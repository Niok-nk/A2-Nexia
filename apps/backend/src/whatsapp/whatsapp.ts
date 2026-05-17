import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client: WAClient, LocalAuth } = require('whatsapp-web.js');
import type { Client } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { handleIncomingMessage } from './message.handler.js';

let whatsappClient: Client | null = null;
let currentQR: string | null = null;
let isReady = false;

export type WAStatus = 'disconnected' | 'qr_pending' | 'connected';

export const getStatus = (): WAStatus => {
	if (isReady) return 'connected';
	if (currentQR) return 'qr_pending';
	return 'disconnected';
};

export const getCurrentQR = (): string | null => currentQR;

const clearSession = async (): Promise<void> => {
	try {
		const sessionPath = path.join(process.cwd(), 'wa_session', 'session-nexia-crm-client');
		await fs.rm(sessionPath, { recursive: true, force: true });
		logger.info('WhatsApp session cleared');
	} catch (error) {
		logger.warn({ error }, 'Failed to clear session folder');
	}
};

let isReconnecting = false;

export const initWhatsApp = async (forceNewSession = false): Promise<Client | null> => {
	if (isReconnecting && !forceNewSession) {
		logger.info('Reconnection already in progress, skipping...');
		return null;
	}

	if (forceNewSession) {
		isReconnecting = false;
		await clearSession();
	}
	try {
		const chromePath =
			process.env.CHROME_PATH ||
			'C:\\Users\\Niok\\.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe';

		logger.info({ chromePath }, 'Initializing WhatsApp with Chrome');

		const client = new WAClient({
			authStrategy: new LocalAuth({
				dataPath: './wa_session',
				clientId: 'nexia-crm-client',
			}),
			takeOver: true,
			webVersionCache: {
				type: 'remote',
				remotePath:
					'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.57.html',
			},
			puppeteer: {
				headless: true,
				executablePath: chromePath,
				args: [
					'--disable-dev-shm-usage',
					'--disable-gpu',
					'--no-first-run',
					'--disable-setuid-sandbox',
					'--no-sandbox',
					'--disable-blink-features=AutomationControlled',
				],
			},
		});

		client.on('qr', async (qr: string) => {
			logger.info('QR Code received. Scan with WhatsApp.');
			currentQR = qr;
			isReady = false;

			// También imprimir en terminal para desarrollo
			qrcode.toString(qr, { type: 'terminal' }, (err, url) => {
				if (!err) console.log(url);
			});
		});

		client.on('ready', () => {
			logger.info('WhatsApp is ready!');
			isReady = true;
			currentQR = null;
		});

		client.on('authenticated', () => {
			logger.info('WhatsApp authenticated');
			currentQR = null;
		});

		client.on('auth_failure', (msg: any) => {
			logger.error({ msg }, 'WhatsApp authentication failed');
			isReady = false;
		});

		client.on('disconnected', async (reason: any) => {
			logger.warn({ reason }, 'WhatsApp disconnected. Reinitializing...');
			isReady = false;
			currentQR = null;
			whatsappClient = null;
			isReconnecting = true;

			setTimeout(async () => {
				logger.info('Attempting to reconnect WhatsApp...');
				await initWhatsApp(true);
				isReconnecting = false;
			}, 2000);
		});

		client.on('change_state', (state: string) => {
			logger.info({ state }, 'WhatsApp state changed');
		});

		// Keep-alive: enviar ping cada 30 segundos para mantener la conexión
		setInterval(async () => {
			if (client.info?.wid) {
				try {
					await client.pupPage.evaluate(() => {
						return window.Store?.Msg?.collection?.length;
					});
					logger.debug('Keep-alive ping sent');
				} catch {}
			}
		}, 30000);

		// Conectar mensajes entrantes al handler
		client.on('message', async (msg) => {
			logger.info({ msgId: msg.id._serialized, from: msg.from }, 'Message event caught');
			await handleIncomingMessage(msg);
		});

		client.on('message_create', (msg) => {
			logger.info({ msgId: msg.id._serialized, fromMe: msg.fromMe }, 'Message created event');
		});

		await client.initialize();
		whatsappClient = client;
		return client;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error({ error: msg }, 'Failed to initialize WhatsApp');
		return null;
	}
};

export const getWhatsAppClient = (): Client | null => whatsappClient;

export const sendMessage = async (to: string, message: string): Promise<void> => {
	if (!whatsappClient) {
		throw new Error('WhatsApp client not initialized');
	}

	// Normalizar el número de teléfono (eliminar cualquier formato anterior)
	let phone = to;
	if (phone.includes('@lid')) {
		phone = phone.replace('@lid', '');
	} else if (phone.includes('@c.us')) {
		phone = phone.replace('@c.us', '');
	}

	// Solo números, agregar código de país si falta
	if (phone.length === 10) {
		phone = '57' + phone;
	}

	logger.info({ originalTo: to, normalizedPhone: phone, chatId }, 'Sending WhatsApp message');
	const chatId = `${phone}@c.us`;
	await whatsappClient.sendMessage(chatId, message);
};

export const reconnectWhatsApp = async (): Promise<boolean> => {
	try {
		if (whatsappClient) {
			await whatsappClient.destroy();
		}
		whatsappClient = null;
		isReady = false;
		currentQR = null;
		isReconnecting = true;

		await clearSession();
		await initWhatsApp(true);

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
