import { Router, Request, Response } from 'express';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
	res.json({ status: 'disconnected', qr: null });
	return;
});

router.get('/qr', (_req: Request, res: Response) => {
	res.json({ message: 'QR endpoint - TODO' });
	return;
});

router.post('/send', (_req: Request, res: Response) => {
	res.json({ message: 'Send message endpoint - TODO' });
	return;
});

export { router as whatsappRouter };
