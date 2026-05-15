import { Router, Request, Response } from 'express';
import qrcode from 'qrcode';
import { z } from 'zod';
import { getStatus, getCurrentQR, sendMessage, reconnectWhatsApp } from './whatsapp.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import prisma from '../db/index.js';
import { orchestrator } from '../agents/orchestrator.js';
import logger from '../utils/logger.js';

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
		await sendMessage(to, message);
		res.json({ success: true, to, message });
	} catch (error) {
		res.status(500).json({ error: 'Error enviando mensaje', details: String(error) });
	}
});

// POST /api/v1/whatsapp/test — Simula un mensaje entrante para probar la IA
const testMessageSchema = z.object({
	phone: z.string().min(10),
	message: z.string().min(1),
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
		// Buscar o crear contacto
		const contact = await prisma.contact.upsert({
			where: { phone },
			update: {},
			create: { phone, name: `Test ${phone.slice(-4)}` },
		});

		// Persistir mensaje INBOUND
		await prisma.message.create({
			data: {
				contactId: contact.id,
				direction: 'INBOUND',
				body: message,
			},
		});

		// Obtener historial
		const history = await prisma.message.findMany({
			where: { contactId: contact.id },
			orderBy: { sentAt: 'desc' },
			take: 10,
		});

		// Obtener lead activo
		let lead = await prisma.lead.findFirst({
			where: { contactId: contact.id },
			orderBy: { createdAt: 'desc' },
		});

		const context = {
			contactId: contact.id,
			phone,
			leadId: lead?.id,
			stage: lead?.stage ?? 'INITIAL',
			module: lead?.module ?? 'VENTAS',
			history: history.reverse().map((m) => ({
				direction: m.direction,
				body: m.body,
				sentAt: m.sentAt,
			})),
		};

		// Llamar al orquestador
		const { agentType, response } = await orchestrator.route(message, context);

		// Persistir respuesta OUTBOUND
		await prisma.message.create({
			data: {
				contactId: contact.id,
				direction: 'OUTBOUND',
				body: response,
				agentType,
			},
		});

		// Crear lead si no existe
		if (!lead) {
			const moduleMap: Record<string, string> = {
				ventas: 'VENTAS',
				cartera: 'CARTERA',
				servicio_tecnico: 'SERVICIO_TECNICO',
				repuestos: 'REPUESTOS',
				vacantes: 'VACANTES',
				distribuidores: 'DISTRIBUIDORES',
				pagos: 'MEDIOS_DE_PAGO',
			};
			lead = await prisma.lead.create({
				data: {
					contactId: contact.id,
					stage: 'INITIAL',
					type: 'CONSULTA',
					module: moduleMap[agentType] ?? 'VENTAS',
				},
			});
		}

		// Enviar respuesta por WhatsApp
		await sendMessage(phone, response);

		res.json({
			success: true,
			contactId: contact.id,
			leadId: lead.id,
			agentType,
			message: response.substring(0, 100) + '...',
		});
	} catch (error) {
		logger.error({ error, phone, message }, 'Test message error');
		res.status(500).json({ error: 'Error procesando mensaje', details: String(error) });
	}
});

export { router as whatsappRouter };
