import makeWASocket, {
	DisconnectReason,
	useMultiFileAuthState,
	WASocket,
	fetchLatestWaWebVersion,
	Browsers,
	isLidUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import prisma from '../db/index.js';
import { handleIncomingMessage } from './message.handler.js';

let sock: WASocket | null = null;
let currentQR: string | null = null;
let isReady = false;
let isReconnecting = false;

// Almacén en memoria para mapeos LID -> Phone Number (PN)
const lidToPhone = new Map<string, string>();

/**
 * Registra un mapeo entre un LID y un número de teléfono (PN) en memoria y base de datos
 */
export const registerLidMapping = async (lid: string, pn: string) => {
	if (!lid || !pn) return;
	const cleanLid = lid.replace('@lid', '').trim();
	const cleanPn = pn.replace('@s.whatsapp.net', '').replace('@c.us', '').trim();
	if (cleanLid && cleanPn) {
		const existing = lidToPhone.get(cleanLid);
		if (existing !== cleanPn) {
			lidToPhone.set(cleanLid, cleanPn);
			logger.info({ lid: cleanLid, pn: cleanPn }, 'Registered LID to PN mapping');
			
			// Actualizar en segundo plano en la BD de Prisma
			try {
				const contact = await prisma.contact.findUnique({
					where: { phone: cleanLid }
				});
				if (contact && !contact.realPhone) {
					await prisma.contact.update({
						where: { phone: cleanLid },
						data: { realPhone: cleanPn }
					});
					logger.info({ lid: cleanLid, realPhone: cleanPn }, 'Updated contact realPhone in DB');
				}
			} catch (err) {
				logger.error({ err, lid: cleanLid }, 'Failed to update contact realPhone in DB');
			}
		}
	}
};

/**
 * Resuelve un JID (que puede ser de tipo LID) a un número de teléfono real limpio
 */
export const resolvePhoneFromJid = async (jid: string): Promise<string> => {
	if (!jid) return '';
	
	if (isLidUser(jid)) {
		const cleanLid = jid.replace('@lid', '').trim();
		
		// 1. Intentar obtener de la memoria
		const memoryPhone = lidToPhone.get(cleanLid);
		if (memoryPhone) {
			logger.info({ jid, resolved: memoryPhone, source: 'memory' }, 'Resolved LID to PN');
			return memoryPhone;
		}
		
		// 2. Intentar consultar el almacén de claves (auth state keys)
		if (sock?.authState?.keys) {
			try {
				const results = await sock.authState.keys.get('lid-mapping', [cleanLid]);
				if (results && results[cleanLid]) {
					const pn = results[cleanLid];
					registerLidMapping(cleanLid, pn);
					const cleanPn = pn.replace('@s.whatsapp.net', '').replace('@c.us', '').trim();
					logger.info({ jid, resolved: cleanPn, source: 'auth-store' }, 'Resolved LID to PN');
					return cleanPn;
				}
			} catch (err) {
				logger.warn({ err, jid }, 'Failed to query lid-mapping from auth keys');
			}
		}
		
		// 3. Fallback: retornar el LID crudo
		logger.warn({ jid }, 'LID could not be resolved to phone number, returning raw LID');
		return cleanLid;
	}
	
	return jid.replace(/@s\.whatsapp\.net|@c\.us/g, '').trim();
};

/**
 * Backfill: intenta resolver realPhone para todos los contactos que aún tienen null.
 * Consulta primero el mapa en memoria y luego el auth-key-store de Baileys.
 * Se llama al abrir conexión y tras recibir messaging-history.
 */
export const backfillLidMappings = async (): Promise<void> => {
	try {
		const contacts = await prisma.contact.findMany({
			where: { realPhone: null },
			select: { phone: true },
		});

		const candidates = contacts.map((c) => c.phone).filter((p) => /^\d{9,20}$/.test(p));

		if (candidates.length === 0) return;

		logger.info({ count: candidates.length }, 'Backfill: attempting to resolve realPhone for contacts');

		for (const lid of candidates) {
			// 1. Revisar mapa en memoria
			const memPn = lidToPhone.get(lid);
			if (memPn) {
				await prisma.contact.update({ where: { phone: lid }, data: { realPhone: memPn } });
				logger.info({ lid, realPhone: memPn }, 'Backfill: realPhone set from memory');
				continue;
			}

			// 2. Consultar auth-key-store
			if (sock?.authState?.keys) {
				try {
					const results = await sock.authState.keys.get('lid-mapping', [lid]);
					if (results && results[lid]) {
						const cleanPn = String(results[lid])
							.replace(/@s\.whatsapp\.net|@c\.us|@lid/g, '')
							.trim();
						if (cleanPn && cleanPn !== lid) {
							lidToPhone.set(lid, cleanPn);
							await prisma.contact.update({ where: { phone: lid }, data: { realPhone: cleanPn } });
							logger.info({ lid, realPhone: cleanPn }, 'Backfill: realPhone set from auth-store');
						}
					}
				} catch (err) {
					logger.warn({ err, lid }, 'Backfill: failed to query auth-store for lid');
				}
			}
		}
	} catch (err) {
		logger.error({ err }, 'Backfill: unexpected error');
	}
};

export type WAStatus = 'disconnected' | 'qr_pending' | 'connected';

export const getStatus = (): WAStatus => {
	if (isReady) return 'connected';
	if (currentQR) return 'qr_pending';
	return 'disconnected';
};

export const getCurrentQR = (): string | null => currentQR;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const authDir = path.join(process.cwd(), '_IGNORE_baileys_auth');

/**
 * Limpia la sesión de Baileys eliminando el directorio de autenticación
 */
const clearSession = async (): Promise<void> => {
	try {
		await fs.rm(authDir, { recursive: true, force: true });
		logger.info('WhatsApp session directory cleared');
	} catch (error) {
		logger.warn({ error }, 'Failed to clear session directory');
	}
};

export const initWhatsApp = async (forceNewSession = false, isInternalReconnect = false): Promise<WASocket | null> => {
	if (isReconnecting && !forceNewSession && !isInternalReconnect) {
		logger.info('Reconnection already in progress, skipping...');
		return null;
	}

	if (forceNewSession) {
		isReconnecting = false;
		await clearSession();
	}

	try {
		logger.info('Initializing WhatsApp with @whiskeysockets/baileys');

		const { state, saveCreds } = await useMultiFileAuthState(authDir);

		// Obtener la versión de WhatsApp Web más reciente para evitar fallos de inicio de sesión ("no se pudo iniciar sesión")
		let version: [number, number, number] = [2, 3000, 1039904970];
		try {
			const { version: latestVersion, isLatest } = await fetchLatestWaWebVersion();
			logger.info({ latestVersion, isLatest }, 'Fetched latest WhatsApp Web version from WaWeb');
			version = latestVersion;
		} catch (err) {
			logger.warn({ err }, 'Failed to fetch latest WaWeb version, using fallback version');
		}

		const baileysLogger = logger.child({ module: 'baileys' });
		baileysLogger.level = 'warn';

		const client = makeWASocket({
			auth: state,
			version,
			printQRInTerminal: true,
			logger: baileysLogger as any,
			browser: Browsers.macOS('Desktop'),
		});

		sock = client;

		client.ev.on('creds.update', saveCreds);

		// Eventos de mapeo LID a número de teléfono (PN)
		client.ev.on('lid-mapping.update', (mapping) => {
			if (mapping) {
				registerLidMapping(mapping.lid, mapping.pn);
			}
		});

		client.ev.on('messaging-history.set', async (history) => {
			if (history.lidPnMappings) {
				for (const mapping of history.lidPnMappings) {
					registerLidMapping(mapping.lid, mapping.pn);
				}
			}
			if (history.contacts) {
				for (const c of history.contacts) {
					if (c.lid && c.phoneNumber) {
						registerLidMapping(c.lid, c.phoneNumber);
					} else if (c.id && isLidUser(c.id) && c.phoneNumber) {
						registerLidMapping(c.id, c.phoneNumber);
					}
				}
			}
			// Tras recibir historial, re-intentar backfill con los nuevos mapeos ya en memoria
			setTimeout(() => backfillLidMappings().catch((e) => logger.warn({ e }, 'backfill error after history.set')), 2000);
		});

		client.ev.on('contacts.upsert', (contacts) => {
			for (const c of contacts) {
				if (c.lid && c.phoneNumber) {
					registerLidMapping(c.lid, c.phoneNumber);
				} else if (c.id && isLidUser(c.id) && c.phoneNumber) {
					registerLidMapping(c.id, c.phoneNumber);
				}
			}
		});

		client.ev.on('contacts.update', (updates) => {
			for (const u of updates) {
				if (u.lid && u.phoneNumber) {
					registerLidMapping(u.lid, u.phoneNumber);
				} else if (u.id && isLidUser(u.id) && u.phoneNumber) {
					registerLidMapping(u.id, u.phoneNumber);
				}
			}
		});

		client.ev.on('connection.update', async (update) => {
			const { connection, lastDisconnect, qr } = update;
			
			if (qr) {
				logger.info('QR Code received. Scan with WhatsApp.');
				currentQR = qr;
				isReady = false;
			}

			if (connection === 'close') {
				isReady = false;
				currentQR = null;
				
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
				const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.badSession;
				
				logger.info({ shouldReconnect, statusCode, error: lastDisconnect?.error }, 'Connection closed');
				
				if (shouldReconnect) {
					logger.info('Attempting reconnect due to connection drop...');
					await reconnectWhatsApp(false);
				} else {
					logger.warn('Logged out or bad session of WhatsApp. Reconnection will require scanning a new QR.');
					await clearSession();
				}
			} else if (connection === 'open') {
				logger.info('WhatsApp connection opened successfully!');
				isReady = true;
				currentQR = null;
				// Intentar rellenar realPhone para contactos con LID sin resolver
				setTimeout(() => backfillLidMappings().catch((e) => logger.warn({ e }, 'backfill error')), 5000);
			}
		});

		client.ev.on('messages.upsert', async (m) => {
			if (m.type === 'notify') {
				for (const msg of m.messages) {
					// Ignorar si no tiene mensaje o fue enviado por nosotros mismos
					if (!msg.message) continue;
					if (msg.key.fromMe) continue;
					
					const remoteJid = msg.key.remoteJid || '';
					// Ignorar grupos y newsletters
					if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter')) {
						continue;
					}
					
					logger.info({ msgId: msg.key.id, from: remoteJid }, 'Passing message to handler');
					await handleIncomingMessage(msg);
				}
			}
		});

		return client;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error({ error: msg }, 'Failed to initialize WhatsApp');
		return null;
	}
};

export const getWhatsAppClient = (): WASocket | null => sock;

export const sendMessage = async (to: string, message: string): Promise<void> => {
	if (!sock) {
		throw new Error('WhatsApp client not initialized');
	}

	const cleanTo = to.replace('@lid', '').replace('@s.whatsapp.net', '').replace('@c.us', '').trim();
	
	// Determinar si el destinatario es un LID (ej. cuenta nueva sin número de teléfono resuelto aún)
	const isLid = to.includes('@lid') || (cleanTo.startsWith('158') && cleanTo.length >= 14);

	if (isLid) {
		const jid = `${cleanTo}@lid`;
		logger.info({ originalTo: to, jid }, 'Sending WhatsApp message to LID');
		await sock.sendMessage(jid, { text: message });
	} else {
		let phone = cleanTo;
		if (phone.length === 10) {
			phone = '57' + phone;
		}
		
		const jid = `${phone}@s.whatsapp.net`;
		logger.info({ originalTo: to, normalizedPhone: phone, jid }, 'Sending WhatsApp message');
		await sock.sendMessage(jid, { text: message });
	}
};

export const reconnectWhatsApp = async (forceNewSession = true): Promise<boolean> => {
	if (isReconnecting) {
		logger.info('Reconnection already in progress, skipping duplicate call...');
		return false;
	}
	isReconnecting = true;

	try {
		if (sock) {
			try {
				sock.end(undefined);
			} catch {
				logger.warn('Error ending socket connection gracefully');
			}
			sock = null;
		}

		isReady = false;
		currentQR = null;

		// Esperar 3 segundos para liberar locks de archivos
		logger.info('Waiting 3s for session files to unlock...');
		await sleep(3000);

		// Limpiar sesión solo si se requiere
		if (forceNewSession) {
			await clearSession();
		}

		await sleep(1000);

		logger.info('Attempting to reconnect WhatsApp...');
		await initWhatsApp(forceNewSession, true);

		setTimeout(() => {
			isReconnecting = false;
		}, 5000);

		return true;
	} catch (error) {
		logger.error({ error }, 'Failed to reconnect WhatsApp');
		isReconnecting = false;
		return false;
	}
};
