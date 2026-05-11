import { Router, Request, Response } from 'express';
import prisma from '../../db/index.js';

const router = Router();

router.get('/' as any, async (_req: Request, res: Response) => {
	try {
		const { stage, module: moduleFilter } = _req.query;
		const where: any = {};
		if (stage) where.stage = stage as string;
		if (moduleFilter) where.module = moduleFilter as string;

		const leads = await prisma.lead.findMany({
			where,
			include: { contact: true, notes: true },
		});
		res.json(leads);
		return;
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch leads' });
		return;
	}
});

router.get('/:id', async (req: Request, res: Response) => {
	try {
		const lead = await prisma.lead.findUnique({
			where: { id: req.params.id as string },
			include: { contact: true, notes: true },
		});
		if (!lead) {
			return res.status(404).json({ error: 'Lead not found' });
		}
		res.json(lead);
		return;
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch lead' });
		return;
	}
});

router.patch('/:id/stage', async (req: Request, res: Response) => {
	try {
		const { stage } = req.body;
		const lead = await prisma.lead.update({
			where: { id: req.params.id as string },
			data: { stage },
		});
		res.json(lead);
		return;
	} catch (error) {
		res.status(400).json({ error: 'Failed to update stage' });
		return;
	}
});

router.post('/:id/notes', async (req: Request, res: Response) => {
	try {
		const { body } = req.body;
		const note = await prisma.note.create({
			data: { leadId: req.params.id as string, body },
		});
		res.status(201).json(note);
		return;
	} catch (error) {
		res.status(400).json({ error: 'Failed to add note' });
		return;
	}
});

export { router as leadsRouter };
