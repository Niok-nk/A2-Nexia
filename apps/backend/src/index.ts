import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';
import prisma from './db/index.js';
import { initWhatsApp } from './whatsapp/whatsapp.js';
import { validateEnv } from './utils/env.js';


validateEnv();

const PORT = process.env.PORT || 8000;

const server = app.listen(PORT, () => {
	logger.info(`Server running on port ${PORT}`);
	initWhatsApp();

});

process.on('SIGINT', async () => {
	logger.info('Shutting down gracefully...');
	await prisma.$disconnect();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	logger.info('Shutting down gracefully...');
	await prisma.$disconnect();
	process.exit(0);
});

process.on('uncaughtException', (error) => {
	logger.error({ error }, 'Uncaught exception');
	process.exit(1);
});

process.on('unhandledRejection', (error) => {
	logger.error({ error }, 'Unhandled rejection');
	process.exit(1);
});

export default server;
