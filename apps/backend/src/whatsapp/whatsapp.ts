import { create, Client, ChatId, ev } from '@open-wa/wa-automate';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { handleIncomingMessage } from './message.handler.js';

let whatsappClient: Client | null = null;
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

/**
 * Limpia la sesión JSON y el SingletonLock del directorio de datos del navegador
 * para evitar que quede bloqueado tras una reconexión.
 */
const clearSession = async (): Promise<void> => {
	// 1. Borrar archivo de sesión open-wa
	try {
		const sessionFilePath = path.join(process.cwd(), 'nexia-crm-client.data.json');
		await fs.rm(sessionFilePath, { force: true });
		logger.info('WhatsApp session file cleared');
	} catch (error) {
		logger.warn({ error }, 'Failed to clear session file');
	}

	// 2. Borrar el SingletonLock del directorio de datos de Puppeteer
	try {
		const userDataDir = path.join(process.cwd(), '_IGNORE_nexia-crm-client');
		const lockFile = path.join(userDataDir, 'SingletonLock');
		await fs.rm(lockFile, { force: true });
		logger.info('Browser SingletonLock cleared');
	} catch (error) {
		logger.warn({ error }, 'Failed to clear SingletonLock (may not exist)');
	}
};

/**
 * Fuerza el cierre de procesos Chrome que tengan el userDataDir de la sesión bloqueado.
 */
const killStaleChrome = (): void => {
	try {
		execSync(
			'tasklist /FI "IMAGENAME eq chrome.exe" 2>NUL | findstr /i "chrome" && taskkill /F /IM chrome.exe /T 2>NUL || echo no-chrome',
			{ stdio: 'ignore' }
		);
		logger.info('Stale Chrome processes killed');
	} catch {
		// No hay procesos chrome, está bien
	}
};

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
			'C:\\Users\\Niok\\.cache\\puppeteer\\chrome\\win64-148.0.7778.97\\chrome-win64\\chrome.exe';

		logger.info({ chromePath }, 'Initializing WhatsApp with @open-wa/wa-automate');

		ev.on('qr.**', async (qrcode: string) => {
			logger.info('QR Code received via event. Scan with WhatsApp.');
			currentQR = qrcode;
			isReady = false;
		});

		const client = await create({
			sessionId: 'nexia-crm-client',
			multiDevice: true,
			executablePath: chromePath,
			// headless: false es CRÍTICO para evitar detección de bot en WhatsApp Web
			headless: false,
			qrTimeout: 0,
			authTimeout: 0,
			killProcessOnBrowserClose: true,
			autoRefresh: true,
			safeMode: true,
			disableSpins: true,
			popup: 3012,
			defaultViewport: null,
			logConsole: true,
			// User-Agent de Chrome real para evitar detección como headless/bot
			userAgent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
			// Evitar fallos si WhatsApp Web actualiza métodos internos
			skipBrokenMethodsCheck: true,
			// Args adicionales de Chromium para mayor estabilidad en Windows
			chromiumArgs: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-accelerated-2d-canvas',
				'--disable-gpu',
				'--disable-features=IsolateOrigins,site-per-process',
				'--no-first-run',
				'--no-zygote',
			],
		});

		whatsappClient = client;
		isReady = true;
		currentQR = null;
		logger.info('WhatsApp is ready!');

		// Escuchar mensajes entrantes
		client.onMessage(async (msg) => {
			logger.info({ msgId: msg.id, from: msg.from }, 'Message event caught');
			await handleIncomingMessage(msg);
		});

		// Manejar cambios de estado
		client.onStateChanged((state) => {
			logger.info({ state }, 'WhatsApp state changed');
			if (state === 'CONNECTED') {
				isReady = true;
				currentQR = null;
			} else if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
				isReady = false;
			} else if (state === 'UNPAIRED') {
				logger.warn('WhatsApp unpaired. Reinitializing...');
				isReady = false;
				currentQR = null;
				reconnectWhatsApp();
			}
		});

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

	// Normalizar el número de teléfono
	let phone = to;
	if (phone.includes('@lid')) {
		phone = phone.replace('@lid', '');
	} else if (phone.includes('@c.us')) {
		phone = phone.replace('@c.us', '');
	}

	if (phone.length === 10) {
		phone = '57' + phone;
	}

	const chatId = `${phone}@c.us` as ChatId;
	logger.info({ originalTo: to, normalizedPhone: phone, chatId }, 'Sending WhatsApp message');
	await whatsappClient.sendText(chatId, message);
};

export const reconnectWhatsApp = async (): Promise<boolean> => {
	if (isReconnecting) {
		logger.info('Reconnection already in progress, skipping duplicate call...');
		return false;
	}
	isReconnecting = true;

	try {
		// 1. Intentar matar el cliente de forma segura
		if (whatsappClient) {
			try {
				await whatsappClient.kill();
			} catch {
				logger.warn('Error killing WA client gracefully, will force Chrome kill');
			}
			whatsappClient = null;
		}

		isReady = false;
		currentQR = null;

		// 2. Forzar cierre de cualquier proceso Chrome residual
		killStaleChrome();

		// 3. Esperar 3 segundos para que el OS libere archivos y locks
		logger.info('Waiting 3s for browser to release locks...');
		await sleep(3000);

		// 4. Limpiar sesión y SingletonLock
		await clearSession();

		// 5. Esperar 1 segundo adicional antes de reiniciar
		await sleep(1000);

		// 6. Reiniciar el cliente
		logger.info('Attempting to reconnect WhatsApp...');
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
