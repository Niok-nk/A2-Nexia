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
		name: 'Moto Hero Hunk 160R',
		price: '8500000',
		regular_price: '9200000',
		sale_price: '8500000',
		description: 'Motocicleta deportiva 160cc con frenos ABS, ideal para ciudad y carretera.',
		short_description: 'Deportiva 160cc, ABS, excelente rendimiento',
		stock_status: 'instock',
		categories: [{ name: 'Motocicletas Deportivas' }],
		permalink: 'https://example.com/moto-hero-hunk',
	},
	{
		id: 2,
		name: 'Moto Honda CB190R',
		price: '11200000',
		regular_price: '11200000',
		sale_price: '',
		description: 'Naked sport 190cc de alto rendimiento con frenos de disco delantero y trasero.',
		short_description: 'Naked sport 190cc, potencia y estilo',
		stock_status: 'instock',
		categories: [{ name: 'Motocicletas Deportivas' }],
		permalink: 'https://example.com/honda-cb190r',
	},
	{
		id: 3,
		name: 'Moto Bajaj Pulsar NS 200',
		price: '13500000',
		regular_price: '14000000',
		sale_price: '13500000',
		description: 'Deportiva de alta cilindrada 200cc con tecnología DTS-i y frenos de disco.',
		short_description: '200cc DTS-i, deportiva de alto rendimiento',
		stock_status: 'instock',
		categories: [{ name: 'Motocicletas Deportivas' }],
		permalink: 'https://example.com/bajaj-ns200',
	},
	{
		id: 4,
		name: 'Moto Honda CB125F',
		price: '6800000',
		regular_price: '7100000',
		sale_price: '6800000',
		description: 'Motocicleta económica 125cc, ideal para ciudad. Bajo consumo de combustible.',
		short_description: '125cc económica, perfecta para ciudad',
		stock_status: 'instock',
		categories: [{ name: 'Motocicletas Económicas' }],
		permalink: 'https://example.com/honda-cb125f',
	},
	{
		id: 5,
		name: 'Scooter Yamaha FreeGo 125',
		price: '7400000',
		regular_price: '7400000',
		sale_price: '',
		description: 'Scooter automático 125cc con baúl integrado, cargador USB y arranque inteligente.',
		short_description: 'Scooter automático 125cc, cómodo y práctico',
		stock_status: 'instock',
		categories: [{ name: 'Scooters' }],
		permalink: 'https://example.com/yamaha-freego',
	},
	{
		id: 6,
		name: 'Moto Eléctrica Voltra E1',
		price: '15000000',
		regular_price: '15000000',
		sale_price: '',
		description: 'Moto eléctrica con autonomía de 120km, carga en 4 horas, velocidad máx 90km/h.',
		short_description: 'Eléctrica 120km autonomía, ecológica y económica',
		stock_status: 'instock',
		categories: [{ name: 'Motos Eléctricas' }],
		permalink: 'https://example.com/voltra-e1',
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
