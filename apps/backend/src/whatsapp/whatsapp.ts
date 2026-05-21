import makeWASocket, {
	DisconnectReason,
	useMultiFileAuthState,
	WASocket,
	fetchLatestWaWebVersion,
	Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { handleIncomingMessage } from './message.handler.js';

let sock: WASocket | null = null;
let currentQR: string | null = null;
let isReady = false;
let isReconnecting = false;

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

export const initWhatsApp = async (forceNewSession = false): Promise<WASocket | null> => {
	if (isReconnecting && !forceNewSession) {
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

	// Normalizar el número de teléfono
	let phone = to;
	if (phone.includes('@lid')) {
		phone = phone.replace('@lid', '');
	} else if (phone.includes('@c.us')) {
		phone = phone.replace('@c.us', '');
	} else if (phone.includes('@s.whatsapp.net')) {
		phone = phone.replace('@s.whatsapp.net', '');
	}

	if (phone.length === 10) {
		phone = '57' + phone;
	}

	const jid = `${phone}@s.whatsapp.net`;
	logger.info({ originalTo: to, normalizedPhone: phone, jid }, 'Sending WhatsApp message');
	await sock.sendMessage(jid, { text: message });
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
		await initWhatsApp(forceNewSession);

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
