import axios from 'axios';
import logger from '../utils/logger.js';

export interface WCProduct {
	id: number;
	name: string;
	price: string;
	regular_price: string;
	sale_price: string;
	description: string;
	short_description: string;
	stock_status: string;
	categories: Array<{ name: string }>;
	permalink: string;
}

// Catálogo de vehículos de ejemplo (usado si WooCommerce no está configurado)
const MOCK_CATALOG: WCProduct[] = [
	{
		id: 1,
		name: 'congeladores JLC',
		price: '',
		regular_price: '',
		sale_price: '',
		description: '',
		short_description: '',
		stock_status: 'instock',
		categories: [{ name: '' }],
		permalink: 'https://jlc-electronics.com/product-category/hogar/refrigeracion/congeladores/',
	},
];

const wcApi = process.env.WC_BASE_URL
	? axios.create({
			baseURL: process.env.WC_BASE_URL,
			auth: {
				username: process.env.WC_CONSUMER_KEY || '',
				password: process.env.WC_CONSUMER_SECRET || '',
			},
			timeout: 8000,
	  })
	: null;

export const wooCommerceService = {
	isConfigured(): boolean {
		return !!wcApi;
	},

	async getProducts(limit = 10): Promise<WCProduct[]> {
		if (!wcApi) {
			logger.warn('WooCommerce not configured, using mock catalog');
			return MOCK_CATALOG.slice(0, limit);
		}
		try {
			logger.info('Fetching products from WooCommerce...');
			const { data } = await wcApi.get('wp-json/wc/v3/products', {
				params: { per_page: limit, status: 'publish' },
			});
			logger.info({ count: data.length }, 'WooCommerce products fetched successfully');
			
			if (data.length === 0) {
				logger.warn('No WooCommerce products, falling back to mock catalog');
				return MOCK_CATALOG.slice(0, limit);
			}
			
			return data as WCProduct[];
		} catch (error: any) {
			logger.error({ error: error.message, status: error.response?.status, data: error.response?.data }, 'WooCommerce API error, falling back to mock');
			return MOCK_CATALOG.slice(0, limit);
		}
	},

	async searchProducts(query: string, limit = 5): Promise<WCProduct[]> {
		if (!wcApi) {
			logger.warn({ query }, 'WooCommerce not configured, searching mock catalog');
			const q = query.toLowerCase();
			return MOCK_CATALOG.filter(
				(p) =>
					p.name.toLowerCase().includes(q) ||
					p.description.toLowerCase().includes(q) ||
					p.categories.some((c) => c.name.toLowerCase().includes(q))
			).slice(0, limit);
		}
		try {
			logger.info({ query }, 'Searching products in WooCommerce...');
			const { data } = await wcApi.get('wp-json/wc/v3/products', {
				params: { search: query, per_page: limit },
			});
			logger.info({ query, count: data.length }, 'WooCommerce search results');
			
			if (data.length === 0) {
				logger.warn({ query }, 'No WooCommerce results, falling back to mock catalog');
				const q = query.toLowerCase();
				return MOCK_CATALOG.filter(
					(p) =>
						p.name.toLowerCase().includes(q) ||
						p.description.toLowerCase().includes(q) ||
						p.categories.some((c) => c.name.toLowerCase().includes(q))
				).slice(0, limit);
			}
			
			return data as WCProduct[];
		} catch (error: any) {
			logger.error({ error: error.message, query, status: error.response?.status, data: error.response?.data }, 'WooCommerce search error, falling back to mock');
			const q = query.toLowerCase();
			return MOCK_CATALOG.filter(
				(p) =>
					p.name.toLowerCase().includes(q) ||
					p.description.toLowerCase().includes(q)
			).slice(0, limit);
		}
	},

	formatProductList(products: WCProduct[]): string {
		if (products.length === 0) return 'No encontré productos disponibles en este momento.';

		return products
			.map((p, i) => {
				const price = new Intl.NumberFormat('es-CO', {
					style: 'currency',
					currency: 'COP',
					maximumFractionDigits: 0,
				}).format(Number(p.price));
				const saleTag = p.sale_price ? ' 🏷️ OFERTA' : '';
				const stock = p.stock_status === 'instock' ? '✅' : '❌ Sin stock';
				return `${i + 1}. *${p.name}*${saleTag}\n   💰 ${price} | ${stock}\n   ${p.short_description}`;
			})
			.join('\n\n');
	},
};
