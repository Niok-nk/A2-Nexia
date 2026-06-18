import { Router, Request, Response } from 'express';
import qrcode from 'qrcode';
import { z } from 'zod';
import { getStatus, getCurrentQR, sendMessage, reconnectWhatsApp } from './whatsapp.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import prisma from '../db/index.js';
import logger from '../utils/logger.js';
import { processIncomingMessage } from './message.handler.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const router: Router = Router();

// GET /api/v1/whatsapp/status
router.get('/status', requireAuth, (_req: Request, res: Response) => {
	res.set('Cache-Control', 'no-store');
	res.json({ status: getStatus() });
});

// POST /api/v1/whatsapp/reconnect — Fuerza reconexión y genera nuevo QR
router.post('/reconnect', requireAuth, async (_req: Request, res: Response) => {
	try {
		const success = await reconnectWhatsApp();
		if (success) {
			res.json({ success: true, message: 'Reconnecting... Wait for new QR' });
		} else {
			res.status(500).json({ success: false, error: 'Failed to reconnect' });
		}
	} catch (error) {
		res.status(500).json({ error: 'Error reconnecting', details: String(error) });
	}
});

// GET /api/v1/whatsapp/qr — Retorna QR como imagen base64
router.get('/qr', requireAuth, async (_req: Request, res: Response) => {
	const qr = getCurrentQR();

	if (!qr) {
		res.status(404).json({
			error: 'No hay QR disponible',
			status: getStatus(),
		});
		return;
	}

	try {
		const base64 = await qrcode.toDataURL(qr);
		res.json({ qr: base64, status: 'qr_pending' });
	} catch {
		res.status(500).json({ error: 'Error generando QR' });
	}
});

const sendSchema = z.object({
	to: z.string().min(5),
	message: z.string().min(1),
});

// POST /api/v1/whatsapp/send — Envía mensaje manual
router.post('/send', requireAuth, async (req: Request, res: Response) => {
	const result = sendSchema.safeParse(req.body);
	if (!result.success) {
		res.status(400).json({ error: 'Datos inválidos', details: result.error.flatten() });
		return;
	}

	if (getStatus() !== 'connected') {
		res.status(503).json({ error: 'WhatsApp no está conectado', status: getStatus() });
		return;
	}

	try {
		const { to, message } = result.data;

		// Usar realPhone si existe para el envío
		let phone = to;
		if (phone.includes('@s.whatsapp.net')) {
			phone = phone.replace('@s.whatsapp.net', '');
		} else if (phone.includes('@lid')) {
			phone = phone.replace('@lid', '');
		} else if (phone.includes('@c.us')) {
			phone = phone.replace('@c.us', '');
		}

		const contact = await prisma.contact.findUnique({ where: { phone } }).catch(() => null);
		const sendTo = contact?.realPhone || to;
		await sendMessage(sendTo, message);

		// Registrar de inmediato en la base de datos para actualizar la UI en tiempo real
		if (contact) {
			await prisma.message.create({
				data: {
					contactId: contact.id,
					direction: 'OUTBOUND',
					body: message,
					agentType: 'MANUAL',
				},
			});
			logger.info({ phone, sendTo, body: message.slice(0, 50) }, 'Manual outbound message saved to database');
		}

		res.json({ success: true, to, sendTo, message });
	} catch (error) {
		res.status(500).json({ error: 'Error enviando mensaje', details: String(error) });
	}
});

// POST /api/v1/whatsapp/test — Simula un mensaje entrante para probar la IA
const testMessageSchema = z.object({
	phone: z.string().min(10),
	message: z.string().min(1),
	image: z.string().optional(),
	imageMimeType: z.string().optional(),
});

// Endpoint sin auth para el chat flotante
router.post('/chat', async (req: Request, res: Response) => {
	const result = testMessageSchema.safeParse(req.body);
	if (!result.success) {
		res.status(400).json({ error: 'Datos inválidos', details: result.error.flatten() });
		return;
	}

	const { phone, message, image, imageMimeType } = result.data;

	let mediaInfo: { mediaType: string; mediaMimeType: string; mediaFileName: string } | undefined;

	if (image && imageMimeType) {
		try {
			const ext = imageMimeType.split('/')[1] || 'jpg';
			const fileName = `${crypto.randomUUID()}.${ext}`;
			const mediaDir = path.join(process.cwd(), 'media');
			await fs.mkdir(mediaDir, { recursive: true });
			const buffer = Buffer.from(image, 'base64');
			await fs.writeFile(path.join(mediaDir, fileName), buffer);
			mediaInfo = { mediaType: 'image', mediaMimeType: imageMimeType, mediaFileName: fileName };
			logger.info({ fileName, size: buffer.length }, 'Image saved from chat widget');
		} catch (err) {
			logger.warn({ error: err }, 'Failed to save image from chat widget');
		}
	}

	try {
		const { response, agentType } = await processIncomingMessage(phone, message, null, mediaInfo);
		if (!response) {
			res.status(500).json({ error: 'No se pudo procesar el mensaje' });
			return;
		}

		const contact = await prisma.contact.findUnique({ where: { phone } }).catch(() => null);
		const sendTo = contact?.realPhone || phone;

		const waStatus = getStatus();
		logger.info({ waStatus, phone, sendTo }, 'WhatsApp send check');
		try {
			await sendMessage(sendTo, response);
			logger.info({ phone, sendTo }, 'Message sent via WhatsApp');
		} catch (err) {
			logger.warn({ error: err, phone, sendTo, waStatus }, 'WhatsApp send failed');
		}

		res.json({ success: true, message: response, agentType });
	} catch (error) {
		logger.error({ error, phone, message }, 'Chat error');
		res.status(500).json({ error: 'Error procesando mensaje', details: String(error) });
	}
});

router.post('/test', requireAuth, async (req: Request, res: Response) => {
	const result = testMessageSchema.safeParse(req.body);
	if (!result.success) {
		res.status(400).json({ error: 'Datos inválidos', details: result.error.flatten() });
		return;
	}

	const { phone, message } = result.data;
	logger.info({ phone, message }, 'Test message received');

	try {
		const { response, agentType, contactId, leadId } = await processIncomingMessage(phone, message);
		if (!response) {
			res.status(500).json({ error: 'No se pudo procesar el mensaje' });
			return;
		}

		// Usar realPhone del contacto para enviar
		const contact = await prisma.contact.findUnique({ where: { phone } }).catch(() => null);
		const sendTo = contact?.realPhone || phone;

		try {
			await sendMessage(sendTo, response);
		} catch (err) {
			logger.warn({ error: err, phone, sendTo }, 'Failed to send WhatsApp response');
		}

		res.json({
			success: true,
			contactId,
			leadId,
			agentType,
			message: response.substring(0, 100) + '...',
		});
	} catch (error) {
		logger.error({ error, phone, message }, 'Test message error');
		res.status(500).json({ error: 'Error procesando mensaje', details: String(error) });
	}
});

export { router as whatsappRouter };
