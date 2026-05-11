import { Router, Request, Response } from 'express';
import axios from 'axios';

const router = Router();

const WC_BASE_URL = process.env.WC_BASE_URL || '';
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET || '';

const wcApi = axios.create({
	baseURL: WC_BASE_URL,
	auth: {
		username: WC_CONSUMER_KEY,
		password: WC_CONSUMER_SECRET,
	},
});

router.get('/' as any, async (_req: Request, res: Response) => {
	try {
		const { data } = await wcApi.get('/wp-json/wc/v3/products');
		res.json(data);
		return;
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch products' });
		return;
	}
});

router.get('/:id', async (req: Request, res: Response) => {
	try {
		const { data } = await wcApi.get(
			`/wp-json/wc/v3/products/${req.params.id}`
		);
		res.json(data);
		return;
	} catch (error) {
		res.status(404).json({ error: 'Product not found' });
		return;
	}
});

router.get('/search', async (req: Request, res: Response) => {
	try {
		const { q } = req.query;
		const { data } = await wcApi.get('/wp-json/wc/v3/products', {
			params: { search: q },
		});
		res.json(data);
		return;
	} catch (error) {
		res.status(500).json({ error: 'Failed to search products' });
		return;
	}
});

export { router as productsRouter };
