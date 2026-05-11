import { Router, Request, Response } from 'express';
import { contactsRouter } from '../crm/contacts/contacts.router.js';
import { leadsRouter } from '../crm/leads/leads.router.js';
import { whatsappRouter } from '../whatsapp/whatsapp.router.js';
import { productsRouter } from '../woocommerce/products.router.js';
import { authRouter } from '../auth/auth.router.js';

const router = Router();

router.use('/auth', authRouter);
router.use('/contacts', contactsRouter);
router.use('/leads', leadsRouter);
router.use('/whatsapp', whatsappRouter);
router.use('/products', productsRouter);

router.get('/health', (_req: Request, res: Response) => {
	res.json({ status: 'ok', timestamp: new Date().toISOString() });
	return;
});

export default router;
