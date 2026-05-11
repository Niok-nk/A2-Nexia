import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import logger from '../utils/logger.js';

let whatsappClient: Client | null = null;

export const initWhatsApp = async (): Promise<Client | null> => {
	try {
		const client = new Client({
			authStrategy: new LocalAuth({
				dataPath: './wa_session',
			}),
			puppeteer: {
				headless: true,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
				],
			},
		});

		client.on('qr', (qr) => {
			logger.info('QR Code received. Scan with WhatsApp.');
			qrcode.toString(qr, { type: 'terminal' }, (err, url) => {
				if (err) {
					logger.error({ err }, 'Error generating QR');
				} else {
					console.log(url);
				}
			});
		});

		client.on('ready', () => {
			logger.info('WhatsApp is ready!');
		});

		client.on('message', (message) => {
			logger.info({ message }, 'New message received');
		});

		await client.initialize();
		whatsappClient = client;
		return client;
	} catch (error) {
		logger.error({ error }, 'Failed to initialize WhatsApp');
		return null;
	}
};

export const getWhatsAppClient = (): Client | null => whatsappClient;

export const sendMessage = async (to: string, message: string): Promise<void> => {
	if (!whatsappClient) {
		throw new Error('WhatsApp client not initialized');
	}
	const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
	await whatsappClient.sendMessage(chatId, message);
};
