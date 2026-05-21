import { Router, Request, Response } from 'express';
import prisma from '../../db/index.js';
import { z } from 'zod';
import { backfillLidMappings } from '../../whatsapp/whatsapp.js';

const router: Router = Router();

router.get('/' as any, async (_req: Request, res: Response) => {
	try {
		// Disparar backfill en segundo plano para rellenar realPhone de contactos pendientes
		backfillLidMappings().catch(() => {});

		const contacts = await prisma.contact.findMany({
			include: { leads: true, messages: true },
		});
		res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
		res.json(contacts);
		return;
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch contacts' });
		return;
	}
});

router.get('/:id', async (req: Request, res: Response) => {
	try {
		const contact = await prisma.contact.findUnique({
			where: { id: req.params.id as string },
			include: { leads: true, messages: true },
		});
		if (!contact) {
			return res.status(404).json({ error: 'Contact not found' });
		}
		res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
		res.json(contact);
		return;
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch contact' });
		return;
	}
});

const createContactSchema = z.object({
	phone: z.string(),
	name: z.string().optional(),
	email: z.string().email().optional(),
});

router.post('/' as any, async (req: Request, res: Response) => {
	try {
		const result = createContactSchema.safeParse(req.body);
		if (!result.success) {
			return res.status(400).json({ error: 'Invalid data' });
		}
		const { phone, name, email } = result.data;
		const contact = await prisma.contact.create({
			data: { phone, name, email },
		});
		res.status(201).json(contact);
		return;
	} catch (error) {
		res.status(400).json({ error: 'Failed to create contact' });
		return;
	}
});

router.patch('/:id', async (req: Request, res: Response) => {
	try {
		const { name, email } = req.body;
		const contact = await prisma.contact.update({
			where: { id: req.params.id as string },
			data: { name, email },
		});
		res.json(contact);
		return;
	} catch (error) {
		res.status(400).json({ error: 'Failed to update contact' });
		return;
	}
});

export { router as contactsRouter };
