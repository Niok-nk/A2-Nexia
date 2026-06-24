import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { contactsRouter } from '../crm/contacts/contacts.router.js';
import { leadsRouter } from '../crm/leads/leads.router.js';
import { whatsappRouter } from '../whatsapp/whatsapp.router.js';
import { productsRouter } from '../woocommerce/products.router.js';
import { authRouter } from '../auth/auth.router.js';

const router: Router = Router();

router.use('/auth', authRouter);
router.use('/contacts', contactsRouter);
router.use('/leads', leadsRouter);
router.use('/whatsapp', whatsappRouter);
router.use('/products', productsRouter);

router.get('/health', (_req: Request, res: Response) => {
	res.json({ status: 'ok', timestamp: new Date().toISOString() });
	return;
});

// Servir archivos de media (imágenes, audios, videos) subidos por WhatsApp
const MEDIA_DIR = path.join(process.cwd(), 'media');
router.get('/media/:filename', (req: Request, res: Response) => {
	const filename = path.basename(req.params.filename);
	const filepath = path.join(MEDIA_DIR, filename);

	if (!fs.existsSync(filepath)) {
		res.status(404).json({ error: 'Media file not found' });
		return;
	}

	const ext = path.extname(filename).toLowerCase();
	const mimeMap: Record<string, string> = {
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.png': 'image/png',
		'.webp': 'image/webp',
		'.ogg': 'audio/ogg',
		'.mp4': 'audio/mp4',
		'.mp3': 'audio/mpeg',
		'.amr': 'audio/amr',
		'.3gp': 'video/3gpp',
		'.pdf': 'application/pdf',
		'.bin': 'application/octet-stream',
	};
	const mime = mimeMap[ext] || 'application/octet-stream';
	res.setHeader('Content-Type', mime);
	res.setHeader('Cache-Control', 'public, max-age=86400');
	fs.createReadStream(filepath).pipe(res);
});

export default router;
