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

// Directorio de autenticación de Baileys (definido aquí para uso en readLidFromFile y clearSession)
const authDir = path.join(process.cwd(), '_IGNORE_baileys_auth');

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
				// Solo actualizar si el phone parece un LID (15+ dígitos) para evitar
				// pisar realPhone con un mapeo incorrecto para números regulares
				if (cleanLid.length >= 15) {
					const contact = await (prisma.contact as any).findUnique({
						where: { phone: cleanLid }
					});
					if (contact && !(contact as any).realPhone) {
						await (prisma.contact as any).update({
							where: { phone: cleanLid },
							data: { realPhone: cleanPn }
						});
						logger.info({ lid: cleanLid, realPhone: cleanPn }, 'Updated contact realPhone in DB');
					}
				}
			} catch (err) {
				logger.error({ err, lid: cleanLid }, 'Failed to update contact realPhone in DB');
			}
		}
	}
};

/**
 * Lee el número de teléfono real de un LID directamente desde los archivos del auth-store de Baileys.
 * Formato: _IGNORE_baileys_auth/lid-mapping-{lid}_reverse.json → contiene el número como string JSON
 */
const readLidFromFile = async (lid: string): Promise<string | null> => {
	try {
		const filePath = path.join(authDir, `lid-mapping-${lid}_reverse.json`);
		const content = await fs.readFile(filePath, 'utf-8');
		const pn = JSON.parse(content);
		if (pn && typeof pn === 'string') {
			const cleanPn = pn.replace(/@s\.whatsapp\.net|@c\.us|@lid/g, '').trim();
			if (cleanPn && cleanPn !== lid) return cleanPn;
		}
	} catch {
		// archivo no existe o formato inesperado
	}
	return null;
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
		
		// 2. Intentar con el auth-key-store usando la clave '{lid}_reverse' (formato real de Baileys)
		if ((sock as any)?.authState?.keys) {
			try {
				const reverseKey = `${cleanLid}_reverse`;
				const results = await (sock as any).authState.keys.get('lid-mapping', [reverseKey, cleanLid]);
				const raw = results?.[reverseKey] ?? results?.[cleanLid];
				if (raw) {
					const cleanPn = String(raw).replace(/@s\.whatsapp\.net|@c\.us|@lid/g, '').trim();
					if (cleanPn && cleanPn !== cleanLid) {
						await registerLidMapping(cleanLid, cleanPn);
						logger.info({ jid, resolved: cleanPn, source: 'auth-store' }, 'Resolved LID to PN');
						return cleanPn;
					}
				}
			} catch (err) {
				logger.warn({ err, jid }, 'Failed to query lid-mapping from auth keys');
			}
		}

		// 3. Leer directamente el archivo del auth-store en disco
		const filePhone = await readLidFromFile(cleanLid);
		if (filePhone) {
			await registerLidMapping(cleanLid, filePhone);
			logger.info({ jid, resolved: filePhone, source: 'file' }, 'Resolved LID to PN from file');
			return filePhone;
		}
		
		// 4. Fallback: retornar el LID crudo
		logger.warn({ jid }, 'LID could not be resolved to phone number, returning raw LID');
		return cleanLid;
	}
	
	return jid.replace(/@s\.whatsapp\.net|@c\.us/g, '').trim();
};

/**
 * Backfill: intenta resolver realPhone para todos los contactos que aún tienen null.
 * Consulta memoria, auth-key-store (clave '_reverse') y los archivos en disco.
 * Se llama al abrir conexión y tras recibir messaging-history.
 */
export const backfillLidMappings = async (): Promise<void> => {
	try {
		const contacts = await (prisma.contact as any).findMany({
			where: { realPhone: null },
			select: { phone: true },
		});

		// Solo tratar como LID los números de 15+ dígitos (los teléfonos reales son <=13)
		const candidates = contacts.map((c: any) => c.phone).filter((p: any) => /^\d{15,}$/.test(p));

		if (candidates.length === 0) return;

		logger.info({ count: candidates.length }, 'Backfill: attempting to resolve realPhone for contacts');

		for (const lid of candidates) {
			// 1. Revisar mapa en memoria
			const memPn = lidToPhone.get(lid);
			if (memPn) {
				await (prisma.contact as any).update({ where: { phone: lid }, data: { realPhone: memPn } });
				logger.info({ lid, realPhone: memPn }, 'Backfill: realPhone set from memory');
				continue;
			}

			// 2. Consultar auth-key-store con clave '{lid}_reverse' (formato correcto de Baileys)
			let resolved = false;
			if ((sock as any)?.authState?.keys) {
				try {
					const reverseKey = `${lid}_reverse`;
					const results = await (sock as any).authState.keys.get('lid-mapping', [reverseKey, lid]);
					const raw = results?.[reverseKey] ?? results?.[lid];
					if (raw) {
						const cleanPn = String(raw).replace(/@s\.whatsapp\.net|@c\.us|@lid/g, '').trim();
						if (cleanPn && cleanPn !== lid) {
							lidToPhone.set(lid, cleanPn);
							await (prisma.contact as any).update({ where: { phone: lid }, data: { realPhone: cleanPn } });
							logger.info({ lid, realPhone: cleanPn }, 'Backfill: realPhone set from auth-store');
							resolved = true;
						}
					}
				} catch (err) {
					logger.warn({ err, lid }, 'Backfill: failed to query auth-store for lid');
				}
			}

			// 3. Fallback: leer directamente el archivo del disco
			if (!resolved) {
				const filePhone = await readLidFromFile(lid);
				if (filePhone) {
					lidToPhone.set(lid, filePhone);
					await (prisma.contact as any).update({ where: { phone: lid }, data: { realPhone: filePhone } });
					logger.info({ lid, realPhone: filePhone }, 'Backfill: realPhone set from file');
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

		// Obtener la versión de WhatsApp Web más reciente
		let version: [number, number, number] = [2, 2413, 51];
		try {
			const { version: latestVersion, isLatest } = await fetchLatestWaWebVersion({});
			logger.info({ latestVersion, isLatest }, 'Fetched latest WhatsApp Web version from WaWeb');
			version = latestVersion;
		} catch (err) {
			logger.warn({ err }, 'Failed to fetch latest WaWeb version, using fallback version');
		}

		const baileysLogger = logger.child({ module: 'baileys' });
		baileysLogger.level = 'info';

		const client = makeWASocket({
			auth: state,
			version,
			printQRInTerminal: false,
			logger: baileysLogger as any,
			browser: Browsers.macOS('Desktop'),
		});

		sock = client;

		client.ev.on('creds.update', saveCreds);

		// Eventos de mapeo LID a número de teléfono (PN) — con type casts para compatibilidad v6/v7
		(client.ev as any).on('lid-mapping.update', (mapping: any) => {
			if (mapping) {
				registerLidMapping(mapping.lid, mapping.pn);
			}
		});

		client.ev.on('messaging-history.set', async (history: any) => {
			if (history.lidPnMappings) {
				for (const mapping of history.lidPnMappings) {
					registerLidMapping(mapping.lid, mapping.pn);
				}
			}
			if (history.contacts) {
				for (const c of history.contacts) {
					const pn = c.phoneNumber || (c.id?.replace(/@s\.whatsapp\.net|@c\.us/g, ''));
					if (c.lid && pn) {
						registerLidMapping(c.lid, pn);
					} else if (c.id && isLidUser(c.id) && pn) {
						registerLidMapping(c.id, pn);
					}
				}
			}
			// Tras recibir historial, re-intentar backfill con los nuevos mapeos ya en memoria
			setTimeout(() => backfillLidMappings().catch((e) => logger.warn({ e }, 'backfill error after history.set')), 2000);
		});

		client.ev.on('contacts.upsert', (contacts: any) => {
			for (const c of contacts) {
				const pn = c.phoneNumber || (c.id?.replace(/@s\.whatsapp\.net|@c\.us/g, ''));
				if (c.lid && pn) {
					registerLidMapping(c.lid, pn);
				} else if (c.id && isLidUser(c.id) && pn) {
					registerLidMapping(c.id, pn);
				}
			}
		});

		client.ev.on('contacts.update', (updates: any) => {
			for (const u of updates) {
				const pn = u.phoneNumber || (u.id?.replace(/@s\.whatsapp\.net|@c\.us/g, ''));
				if (u.lid && pn) {
					registerLidMapping(u.lid, pn);
				} else if (u.id && isLidUser(u.id) && pn) {
					registerLidMapping(u.id, pn);
				}
			}
		});

		client.ev.on('connection.update', async (update) => {
			const { connection, lastDisconnect, qr } = update;
			
			if (qr) {
				currentQR = qr;
				isReady = false;
				logger.info('QR Code received. Scan with WhatsApp.');
			}

			if (connection === 'close') {
				isReady = false;
				currentQR = null;
				
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
				const errorMessage = (lastDisconnect?.error as Boom)?.message || (lastDisconnect?.error as any)?.message;
				const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.badSession;
				
				logger.error({ shouldReconnect, statusCode, errorMessage, error: lastDisconnect?.error?.stack || lastDisconnect?.error }, 'Connection closed');
				
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
			} else if (connection === 'connecting') {
				logger.info('WhatsApp connecting...');
			}
		});

		// Deduplicación de mensajes entrantes (evita bucles por re-emisión de Baileys)
		const processedIds = new Set<string>();
		const MAX_PROCESSED = 500;
		setInterval(() => {
			if (processedIds.size > MAX_PROCESSED) processedIds.clear();
		}, 60000).unref();

		client.ev.on('messages.upsert', async (m) => {
			if (m.type === 'notify') {
				for (const msg of m.messages) {
					// Ignorar si no tiene mensaje o fue enviado por nosotros mismos
					if (!msg.message) continue;
					if (msg.key.fromMe) continue;
					// Ignorar mensajes mientras se está reconectando
					if (isReconnecting) {
						logger.info('Skipping message during reconnection');
						continue;
					}
					
					const remoteJid = msg.key.remoteJid || '';
					// Ignorar grupos y newsletters
					if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter')) {
						continue;
					}

					// Ignorar si ya procesamos este mensaje (evita duplicados por reconexión)
					if (msg.key.id && processedIds.has(msg.key.id)) {
						logger.info({ msgId: msg.key.id }, 'Skipping already processed message');
						continue;
					}
					if (msg.key.id) processedIds.add(msg.key.id);
					
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
	if (isReconnecting && !forceNewSession) {
		logger.info('Reconnection already in progress, skipping duplicate call...');
		return false;
	}
	if (forceNewSession && isReconnecting) {
		logger.info('User-triggered reconnect detected, forcing new session...');
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
