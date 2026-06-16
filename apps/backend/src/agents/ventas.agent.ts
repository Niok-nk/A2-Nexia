import { IAgent, AgentResponse, CreditoData, CreditoStep } from './types.js';
import {
	CATEGORIAS_RE,
	PROFILING_STEPS,
	resolverRespuestaPerfil,
	detectarCategoria,
	extraerProductoConIA,
	detectarShortcuts,
	obtenerTerminoBusquedaDesdePerfil,
	camposPerfilCompletados,
	formatHistory,
	cleanResponse,
	buildUserDataContext,
	buildGemmaPrompt,
	verificarCobertura,
	extraerCiudadDelMensaje,
	detectarCiudadConIA,
	AGENT_NAME,
	getSaludo,
	resolverOpcion
} from './helpers.js';
import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';
import { sendMessage as sendWA } from '../whatsapp/whatsapp.js';

// ─── BÚSQUEDA INTELIGENTE DE PRODUCTOS ───────────────────────────────────────
//
// Maneja tres tipos de búsqueda que el text-search genérico falla:
//   1. SKU / referencia (ej: "JLC-21215", "JLC-500W", "JLC-55A71SGO")
//   2. Specs de potencia (ej: "500W", "2600W RMS") + categoría
//   3. Texto libre normal
//
// Intenta múltiples estrategias en orden de especificidad y devuelve el
// primer conjunto de resultados que coincida.

const CATEGORIAS_PRODUCTO = ['nevera', 'nevecon', 'refrigerador', 'refri', 'lavadora', 'televisor', 'tv', 'congelador', 'parlante', 'sonido', 'licuadora', 'horno', 'microondas', 'estufa', 'ventilador', 'aire', 'plancha', 'aspiradora', 'cafetera', 'freidora', 'minibar', 'exhibidor', 'hervidor', 'arrocera'];

/** Extrae un SKU/referencia tipo "JLC-21215" o "JLC-55A71SGO" del texto. */
function extraerSKU(texto: string): string | null {
	// Patrón: JLC seguido de guión opcional y alfanuméricos (mínimo 3 chars)
	const match = texto.match(/\bJLC[\s-]?([A-Z0-9]{3,15})\b/i);
	if (match) {
		return `JLC-${match[1].toUpperCase()}`;
	}
	return null;
}

/** Extrae una spec de capacidad (litros, kilos, pulgadas) del texto: { valor, unidad } */
function extraerCapacidad(mensaje: string): { valor: number; unidad: string; query: string } | null {
	const t = mensaje.toLowerCase();
	const patrones = [
		{ regex: /(\d{2,4})\s*(?:kilos|kilogramos|kg)\b/, unidad: 'kg', label: 'kilos' },
		{ regex: /(\d{2,4})\s*(?:litros|lt|l)\b/, unidad: 'L', label: 'litros' },
		{ regex: /(\d{2,4})\s*(?:pulgadas|pulg)\b/, unidad: '"', label: 'pulgadas' },
	];
	for (const p of patrones) {
		const match = t.match(p.regex);
		if (match) {
			return { valor: parseInt(match[1], 10), unidad: p.unidad, query: `${match[1]} ${p.label}` };
		}
	}
	return null;
}

/** Extrae una spec de potencia tipo "500W", "2600W RMS" del texto. */
function extraerPotencia(texto: string): string | null {
	const match = texto.match(/(\d{2,5})\s*w(?:\s*rms)?/i);
	if (match) {
		return `${match[1]}W`;
	}
	return null;
}

/** Detecta la categoría mencionada en el texto. */
function detectarCategoriaTexto(texto: string): string | null {
	const lower = texto.toLowerCase();
	for (const cat of CATEGORIAS_PRODUCTO) {
		if (lower.includes(cat)) {
			// Normalizar sinónimos
			if (cat === 'tv') return 'televisor';
			if (cat === 'sonido') return 'parlante';
			if (cat === 'refrigerador' || cat === 'refri') return 'nevera';
			return cat;
		}
	}
	return null;
}

/**
 * Búsqueda inteligente. Recibe el mensaje del cliente y opcionalmente la
 * categoría/contexto conocido. Devuelve productos + cómo se encontraron.
 */
export async function buscarProductoInteligente(
	mensaje: string,
	categoriaContexto?: string | null
): Promise<{ products: any[]; estrategia: string; sku?: string }> {
	const sku = extraerSKU(mensaje);
	const potencia = extraerPotencia(mensaje);
	const categoria = detectarCategoriaTexto(mensaje) || categoriaContexto || null;

	// ── Estrategia 1: Búsqueda por SKU exacto ──────────────────────────
	if (sku) {
		try {
			// Intentar método dedicado de SKU si existe
			if (typeof (wooCommerceService as any).getProductBySku === 'function') {
				const bySku = await (wooCommerceService as any).getProductBySku(sku);
				if (bySku) return { products: [bySku], estrategia: 'sku', sku };
			}
			// Fallback: buscar el SKU como texto
			const results = await wooCommerceService.searchProducts(sku, 10);
			if (results?.length > 0) return { products: results, estrategia: 'sku', sku };
			// Intentar sin el prefijo JLC- (solo el código)
			const codigo = sku.replace(/^JLC-/, '');
			const results2 = await wooCommerceService.searchProducts(codigo, 10);
			if (results2?.length > 0) return { products: results2, estrategia: 'sku_codigo', sku };
		} catch { /* continuar */ }
	}

	// ── Estrategia 2: Categoría + capacidad (ej: "nevera 254 litros", "lavadora 19 kilos") ──
	if (categoria) {
		const capacidad = extraerCapacidad(mensaje);
		if (capacidad) {
			try {
				const query = `${categoria} ${capacidad.query}`;
				const results = await wooCommerceService.searchProducts(query, 20);
				if (results?.length > 0) return { products: results, estrategia: 'categoria_capacidad' };
				// Fallback: solo buscar por capacidad
				const results2 = await wooCommerceService.searchProducts(capacidad.query, 20);
				if (results2?.length > 0) return { products: results2, estrategia: 'capacidad' };
			} catch { /* continuar */ }
		}
	}

	// ── Estrategia 3: Categoría + potencia (ej: "parlante 500W") ────────
	if (potencia && categoria) {
		try {
			const query = `${categoria} ${potencia}`;
			const results = await wooCommerceService.searchProducts(query, 20);
			if (results?.length > 0) {
				// Filtrar para priorizar los que realmente mencionan la potencia
				const conPotencia = results.filter((p: any) =>
					p.name?.toLowerCase().includes(potencia.toLowerCase())
				);
				if (conPotencia.length > 0) return { products: conPotencia, estrategia: 'categoria_potencia' };
				return { products: results, estrategia: 'categoria_potencia_aprox' };
			}
		} catch { /* continuar */ }
	}

	// ── Estrategia 4: Solo potencia / solo capacidad, buscar en toda la tienda ──
	if (potencia && !categoria) {
		try {
			const results = await wooCommerceService.searchProducts(potencia, 20);
			if (results?.length > 0) {
				const conPotencia = results.filter((p: any) =>
					p.name?.toLowerCase().includes(potencia.toLowerCase())
				);
				if (conPotencia.length > 0) return { products: conPotencia, estrategia: 'potencia' };
				return { products: results, estrategia: 'potencia_aprox' };
			}
		} catch { /* continuar */ }
	}
	if (!categoria) {
		const capacidad = extraerCapacidad(mensaje);
		if (capacidad) {
			try {
				const results = await wooCommerceService.searchProducts(capacidad.query, 20);
				if (results?.length > 0) return { products: results, estrategia: 'capacidad_solo' };
			} catch { /* continuar */ }
		}
	}

	// ── Estrategia 5: Categoría sola ────────────────────────────────────
	if (categoria) {
		try {
			const results = await wooCommerceService.searchProducts(categoria, 20);
			if (results?.length > 0) return { products: results, estrategia: 'categoria' };
		} catch { /* continuar */ }
	}

	// ── Estrategia 6: Texto libre (limpiar palabras de relleno) ─────────
	const textoLimpio = mensaje
		.toLowerCase()
		.replace(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa|info de|informacion de|el|la|los|las|un|una|este|esta|ese|esa)\s*/gi, '')
		.replace(/[.,!?¡¿]+/g, '')
		.trim();
	if (textoLimpio.length >= 3) {
		try {
			const results = await wooCommerceService.searchProducts(textoLimpio, 20);
			if (results?.length > 0) return { products: results, estrategia: 'texto' };
		} catch { /* continuar */ }
	}

	// ── Estrategia 6: Palabras clave individuales ───────────────────────
	const palabras = textoLimpio.split(/\s+/).filter((w) => w.length > 3);
	for (const palabra of palabras) {
		try {
			const results = await wooCommerceService.searchProducts(palabra, 20);
			if (results?.length > 0) return { products: results, estrategia: 'palabra_clave' };
		} catch { /* continuar */ }
	}

	return { products: [], estrategia: 'sin_resultados', sku: sku || undefined };
}

/**
 * Detecta si el mensaje es una PREGUNTA sobre especificaciones, medidas o
 * características del producto. Estas preguntas deben responderse SIEMPRE,
 * tienen prioridad sobre cualquier flujo de compra o pago.
 */
export function esPreguntaEspecificacion(texto: string): boolean {
	const t = texto.toLowerCase();
	// Palabras de especificación técnica (incluye capacidad: kilos, litros, pulgadas)
	const tieneSpec = /(?:medida|medidas|mide|miden|cu[aá]nto mide|dimensi[oó]n|dimensiones|alto|ancho|largo|profundidad|fondo|altura|anchura|cent[ií]metro|cm\b|metro|pulgada|tama[ñn]o|capacidad|litro|litros|lt\b|kilo|kilogramo|kg\b|pies|peso|consumo|voltaje|potencia|watt|vatio|color|colores|garant[ií]a|especificaci|caracter[ií]stica|ficha t[eé]cnica|cabe|caben|entra|cu[aá]nto pesa|material|funci[oó]n|funciones|programa)/i.test(t);
	// Capacidad numérica (ej: "19 kilos", "254 litros", "50 pulgadas", "18kg") como pregunta implícita
	const tieneCapacidadNumerica = /\b\d{2,4}\s*(?:kilos|kilogramos|kg|litros|lt|pulgadas|pulg)\b/i.test(t);
	// Forma interrogativa
	const esPregunta = /[?¿]/.test(t) || /^(?:cu[aá]l|cu[aá]nto|cu[aá]nta|qu[eé]|c[oó]mo|d[oó]nde|tiene|tienen|me\s+(?:das|pasas|dices|confirmas|puedes)|podr[ií]as|sabes)/i.test(t);
	return (tieneSpec && esPregunta) || tieneCapacidadNumerica;
}

/** Convierte texto de presupuesto a un techo numérico en pesos. */
function parsearPresupuesto(texto: string): number {
	if (!texto) return 0;
	const t = texto.toLowerCase().trim();

	// Mapeo de rangos cualitativos
	if (t === 'bajo') return 800000;
	if (t === 'medio') return 2500000;
	if (t === 'alto') return 99000000;

	// Extraer número directo (ej: "1000000", "1.000.000", "1 millón")
	if (/mill[oó]n/.test(t)) {
		const m = t.match(/(\d+(?:[.,]\d+)?)\s*mill/);
		if (m) return parseFloat(m[1].replace(',', '.')) * 1000000;
		return 1000000;
	}
	const num = t.replace(/[^\d]/g, '');
	if (num) {
		const valor = parseInt(num);
		// Si parece estar en miles (ej: "1000" → probablemente $1.000.000)
		if (valor < 10000) return valor * 1000;
		return valor;
	}
	return 0;
}

// ─── PASOS DEL FORMULARIO DE CRÉDITO ─────────────────────────────────────────

export const CREDITO_STEPS: CreditoStep[] = [
	{ field: 'nombres',            pregunta: '¿Cómo te llamas? (nombre completo)' },
	{ field: 'cedula',             pregunta: '¿Cuál es tu número de cédula?' },
	{ field: 'celular',            pregunta: '¿Un celular donde te pueda contactar?' },
	{ field: 'direccion',          pregunta: '¿Cuál es tu dirección con barrio?' },
	{
		field: 'tipoVivienda',
		pregunta: '¿Tu vivienda es...?\n1️⃣ Propia\n2️⃣ Arriendo\n3️⃣ Anticrés\n4️⃣ Familiar',
		opciones: ['Propia', 'Arriendo', 'Anticrés', 'Familiar'],
	},
	{ field: 'departamento',       pregunta: '¿En qué departamento vives?' },
	{ field: 'ciudad',             pregunta: '¿Y la ciudad? Si aplica, incluye la vereda.' },
	{
		field: 'personasACargo',
		pregunta: '¿Cuántas personas tienes a cargo?\n1️⃣ 1\n2️⃣ 2\n3️⃣ 3\n4️⃣ 4\n5️⃣ 5 o más',
		opciones: ['1', '2', '3', '4', '5 o más'],
	},
	{ field: 'empresa',            pregunta: '¿En qué empresa trabajas? Si eres independiente, cuéntame tu actividad.' },
	{ field: 'cargo',              pregunta: '¿Qué cargo tienes?' },
	{ field: 'experienciaLaboral', pregunta: '¿Cuánto tiempo llevas ahí?' },
	{
		field: 'estadoCivil',
		pregunta: '¿Estado civil?\n1️⃣ Soltero/a\n2️⃣ Casado/a\n3️⃣ Unión libre\n4️⃣ Viudo/a',
		opciones: ['Soltero/a', 'Casado/a', 'Unión libre', 'Viudo/a'],
	},
	{ field: 'ingresosMensuales',  pregunta: '¿Cuánto ganas al mes aproximadamente?' },
	{ field: 'gastosMensuales',    pregunta: '¿Y cuánto gastas al mes más o menos?' },
	{ field: 'otrosIngresos',      pregunta: '¿Tienes otros ingresos? Si no, escribe "No".' },
	{ field: 'producto',           pregunta: '¿Qué producto te gustaría financiar?' },
	{ field: 'skuProducto',        pregunta: 'Por último, ¿tienes el código o referencia del producto? Lo ves debajo del nombre en la página. Si no lo tienes, escribe "No sé".' },
];

function sanitizarNumerosVentas(texto: string): string {
	const AUTORIZADO = '3187408190';
	// Captura: con prefijo +57 (ej "+57 320 788 1151") o celular pelado de 10
	// dígitos que empiece por 3 (ej "3207881151", "320 788 1151").
	const patron = /(\+?57[\s-]*)?\b3\d{2}[\s-]*\d{3}[\s-]*\d{4}\b/g;
	return texto.replace(patron, (match) => {
		const soloDigitos = match.replace(/\D/g, '').replace(/^57/, '');
		if (soloDigitos === AUTORIZADO) return match;
		return '+57 318 740 8190';
	});
}

export function formatearResumenCredito(data: CreditoData): string {
	return `
🟦 SOLICITUD DE CRÉDITO - JLC Electronics

👤 Datos personales
- Nombre: ${data.nombres} ${data.apellidos || ''}
- Cédula: ${data.cedula}
- Celular: ${data.celular}
- Dirección: ${data.direccion}
- Tipo de vivienda: ${data.tipoVivienda}
- Departamento: ${data.departamento}
- Ciudad: ${data.ciudad}
- Personas a cargo: ${data.personasACargo}
- Estado civil: ${data.estadoCivil}

💼 Información laboral
- Empresa: ${data.empresa}
- Cargo: ${data.cargo}
- Experiencia: ${data.experienciaLaboral}

💰 Información financiera
- Ingresos mensuales: ${data.ingresosMensuales}
- Gastos mensuales: ${data.gastosMensuales}
- Otros ingresos: ${data.otrosIngresos}

🛒 Producto de interés
- Producto: ${data.producto}
- SKU / Referencia: ${data.skuProducto}
`.trim();
}

export async function enviarResumenWhatsApp(resumen: string): Promise<void> {
	const WHATSAPP_CREDITO = process.env.WA_CREDITO || process.env.WA_ESCALAMIENTO || '573187408190';
	await sendWA(WHATSAPP_CREDITO, resumen);
}

/**
 * Usa Inteligencia Artificial para entender exactamente qué producto eligió el cliente
 * analizando el último mensaje del asistente para mantener el contexto real de lo ofrecido.
 */
async function matchProductoDesdeMsg(msg: string, productos: any[], lastAssistantMsg: string = ''): Promise<any | null> {
	if (!productos || productos.length === 0) return null;
	const lowerMsg = msg.toLowerCase().trim();

	// 1. Camino rápido: si escribe exactamente "1", "2", etc.
	const shortNum = parseInt(lowerMsg, 10);
	if (!isNaN(shortNum) && lowerMsg.length <= 2 && shortNum >= 1 && shortNum <= productos.length) {
		return productos[shortNum - 1];
	}

	// 2. IA para interpretar natural language robustamente
	const listaStr = productos.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
	const system = `Eres un sistema experto de análisis de intenciones comerciales.
Lista MÁXIMA de productos en la base de datos (con sus índices correctos):
${listaStr}

Lo que el asistente le acaba de decir al cliente:
"${lastAssistantMsg}"

El cliente respondió: "${msg}"

REGLAS:
- Determina qué producto de la lista seleccionó el cliente, BASADO EN LO QUE LE OFRECIÓ EL ASISTENTE.
- Si el cliente dice "la primera", se refiere a la primera opción mencionada en el mensaje del asistente, busca cuál de la lista corresponde a esa opción.
- RESPONDE ÚNICAMENTE CON EL NÚMERO DE ÍNDICE DEL PRODUCTO EN LA BASE DE DATOS (1, 2, 3...).
- Si la respuesta es ambigua o no selecciona ningún producto, responde "0".
- NO des explicaciones, solo el número.`;

	try {
		const raw = await generateResponse(msg, system);
		const match = raw.match(/\d+/);
		const num = match ? parseInt(match[0], 10) : NaN;
		if (!isNaN(num) && num >= 1 && num <= productos.length) {
			return productos[num - 1];
		}
	} catch (e) {
		console.error("[Ventas] Error en matchProductoDesdeMsg con IA:", e);
	}

	return null;
}

async function generarMensajeSinCobertura(ciudad: string, mensajeUsuario: string): Promise<string> {
	const ctx = mensajeUsuario
		? `El usuario mencionó su ciudad (${ciudad}) y previamente dijo: "${mensajeUsuario}".`
		: `El usuario dijo que es de ${ciudad}.`;
	const yaMencionoProducto = mensajeUsuario?.length > 5;
	
	// Buscar el producto real en WooCommerce para obtener el link correcto
	let productLink = '';
	if (yaMencionoProducto) {
		try {
			const results = await wooCommerceService.searchProducts(mensajeUsuario, 5);
			if (results?.length > 0 && results[0].permalink) {
				productLink = results[0].permalink;
			}
		} catch { /* continuar sin link */ }
	}

	try {
		const msg = await generateResponse(
			ctx,
			`Eres un asesor de ventas amable y natural. El usuario es de ${ciudad}, donde NO tenemos cobertura directa. Redacta un mensaje personalizado (máximo 2 oraciones) que:
- NO diga "qué bien" ni "excelente" (porque no hay cobertura directa)
- Informe amablemente que no tenemos cobertura directa pero que enviamos por transportadora (el flete NO está incluido en el precio, se calcula al agregar el producto al carrito en la web)
- NO menciones "pago contra entrega", "contra entrega" ni "pagar al recibir"
${yaMencionoProducto ? '- El usuario YA mencionó su producto. NO preguntes qué producto busca. Refiérete al producto que ya mencionó.' : '- Pregunte qué producto o referencia busca'}
- Use un tono natural, no robotizado
NO incluyas saludos formales, solo el cuerpo del mensaje.`
		);
		return productLink ? `${msg}\n\nLink del producto:\n${productLink}` : msg;
	} catch {
		const fallback = `En ${ciudad.charAt(0).toUpperCase() + ciudad.slice(1)} no tenemos cobertura directa, pero podemos enviarte por transportadora (el flete se calcula en la web al agregar el producto al carrito). ${yaMencionoProducto ? 'Podemos confirmar la referencia de ese producto para revisar disponibilidad. 😊' : '¿Qué producto o referencia buscas? 😊'}`;
		return productLink ? `${fallback}\n\nLink del producto:\n${productLink}` : fallback;
	}
}

export class VentasAgent implements IAgent {
	name = 'Ventas';

	// ── Flujo de crédito paso a paso ──────────────────────────────────────────
	private async manejarFlujoCredito(
		message: string,
		context: any
	): Promise<AgentResponse> {
		const DEPARTAMENTOS_COLOMBIA = [
			'amazonas', 'antioquia', 'arauca', 'atlántico', 'atlantico', 'bolívar', 'bolivar',
			'boyacá', 'boyaca', 'caldas', 'caquetá', 'caqueta', 'casanare', 'cauca', 'césar', 'cesar',
			'chocó', 'choco', 'córdoba', 'cordoba', 'cundinamarca', 'guainía', 'guainia',
			'guaviare', 'huila', 'la guajira', 'magdalena', 'meta', 'nariño', 'narino',
			'norte de santander', 'putumayo', 'quindío', 'quindio', 'risaralda', 'san andrés',
			'santander', 'sucre', 'tolima', 'valle del cauca', 'valle', 'vaupés', 'vaupes', 'vichada',
		];

		function esDepartamentoValido(v: string): boolean {
			return DEPARTAMENTOS_COLOMBIA.some((d) => v.toLowerCase().includes(d));
		}

		// Pre-poblar departamento si ya se conoce la ciudad
		if (context?.ciudad && context?.userData && !context.userData.departamento) {
			const CIUDAD_A_DEPARTAMENTO: Record<string, string> = {
				pasto: 'Nariño', tumaco: 'Nariño', ipiales: 'Nariño', samaniego: 'Nariño',
				barbacoas: 'Nariño', sandoná: 'Nariño', sandona: 'Nariño',
				popayán: 'Cauca', popayan: 'Cauca', quilichao: 'Cauca', miranda: 'Cauca',
				'puerto tejada': 'Cauca', piendamó: 'Cauca', piendamo: 'Cauca',
				mocoa: 'Putumayo', 'puerto asís': 'Putumayo', 'puerto asis': 'Putumayo',
				orito: 'Putumayo', sibundoy: 'Putumayo', villagarzón: 'Putumayo', villagarzon: 'Putumayo',
				neiva: 'Huila', pitalito: 'Huila', garzón: 'Huila', garzon: 'Huila', campoalegre: 'Huila',
				cali: 'Valle del Cauca', buenaventura: 'Valle del Cauca', palmira: 'Valle del Cauca',
				tuluá: 'Valle del Cauca', tulua: 'Valle del Cauca', buga: 'Valle del Cauca',
				cartago: 'Valle del Cauca', jamundí: 'Valle del Cauca', jamundi: 'Valle del Cauca',
				yumbo: 'Valle del Cauca',
				'bogotá': 'Cundinamarca', 'bogota': 'Cundinamarca',
			};
			const ciudadLower = context.ciudad.toLowerCase().trim();
			if (CIUDAD_A_DEPARTAMENTO[ciudadLower]) {
				context.userData = { ...context.userData, departamento: CIUDAD_A_DEPARTAMENTO[ciudadLower] };
			}
		}

		const creditoData: CreditoData = {
			...context?.creditoData,
			...(context?.userData?.nombre ? { nombres: context.userData.nombre } : {}),
			...(context?.userData?.cedula ? { cedula: context.userData.cedula } : {}),
			...(context?.userData?.direccion ? { direccion: context.userData.direccion } : {}),
			...(context?.userData?.departamento ? { departamento: context.userData.departamento } : {}),
			...(context?.userData?.ciudad ? { ciudad: context.userData.ciudad } : {}),
			...(context?.userData?.productoSolicitado ? { producto: context.userData.productoSolicitado } : {}),
		};
		const stepIndex: number = context?.creditoStep ?? 0;

		if (stepIndex > 0) {
			const stepAnterior = CREDITO_STEPS[stepIndex - 1];

			if (stepAnterior.field === 'nombres') {
				const textoLimpio = message.trim();
				if (textoLimpio.length >= 2 && !/^\d+$/.test(textoLimpio) && !/^[\p{Emoji}\s]+$/u.test(textoLimpio)) {
					creditoData.nombres = textoLimpio;
				}
				if (!creditoData.nombres) {
					return {
						response: 'Disculpa, no logré captar tu nombre. ¿Me lo escribes de nuevo? 😊',
						metadata: {
							agentType: 'ventas',
							flujo: 'credito',
							creditoData,
							creditoStep: stepIndex,
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
						},
					};
				}
			} else if (stepAnterior.field === 'skuProducto' && context?.creditoOptions) {
				const num = parseInt(message.trim(), 10);
				const opciones = context.creditoOptions as Array<{ sku: string; name: string }>;
				if (!isNaN(num) && num >= 1 && num <= opciones.length) {
					const seleccion = opciones[num - 1];
					creditoData.skuProducto = seleccion.sku;
					creditoData.producto = seleccion.name;
				} else {
					const term = message.toLowerCase().trim();
					const match = opciones.find(o => o.name.toLowerCase().includes(term));
					if (match) {
						creditoData.skuProducto = match.sku;
						creditoData.producto = match.name;
					} else {
						creditoData.skuProducto = message.trim();
					}
				}
			} else {
				const valor = stepAnterior.opciones
					? resolverOpcion(message, stepAnterior.opciones)
					: message.trim();

				// Validación específica por campo
				if (stepAnterior.field === 'departamento' && !esDepartamentoValido(valor)) {
					const pista = creditoData.ciudad ? ` (recuerda que ${creditoData.ciudad} queda en el departamento del Cauca, Nariño, etc.)` : '';
					return {
						response: `Mmm, "${valor}" no me suena a un departamento de Colombia 😅 ¿En qué departamento queda tu ciudad?${pista}`,
						metadata: {
							agentType: 'ventas',
							flujo: 'credito',
							creditoData,
							creditoStep: stepIndex,
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
						},
					};
				}
				if (stepAnterior.field === 'personasACargo' && valor === '0' && !context?._personas0ok) {
					context._personas0ok = true;
					return {
						response: '¿Seguro que no tienes ninguna persona a cargo? Puede ser hijos, padres u otros familiares que dependan de ti. Si es así, escribe "0" de nuevo. 😊',
						metadata: {
							agentType: 'ventas',
							flujo: 'credito',
							creditoData,
							creditoStep: stepIndex,
						},
					};
				}
				if (stepAnterior.field === 'ingresosMensuales') {
					const num = parseInt(valor.replace(/\D/g, ''), 10);
					if (isNaN(num) || num <= 0) {
						return {
							response: '¿Me puedes decir cuánto ganas al mes aproximadamente? Un valor numérico, por favor 😊',
							metadata: { agentType: 'ventas', flujo: 'credito', creditoData, creditoStep: stepIndex },
						};
					}
				}
				if (stepAnterior.field === 'cedula') {
					const dig = valor.replace(/\D/g, '');
					if (dig.length < 6 || dig.length > 12) {
						return {
							response: 'La cédula debe tener entre 6 y 12 dígitos. ¿Me la confirmas? 😊',
							metadata: { agentType: 'ventas', flujo: 'credito', creditoData, creditoStep: stepIndex },
						};
					}
				}
				if (stepAnterior.field === 'celular') {
					const dig = valor.replace(/\D/g, '');
					if (dig.length < 10) {
						return {
							response: 'El celular debe tener al menos 10 dígitos. ¿Me lo escribes completo? 😊',
							metadata: { agentType: 'ventas', flujo: 'credito', creditoData, creditoStep: stepIndex },
						};
					}
				}
				if (stepAnterior.field === 'direccion' && valor.length < 5) {
					return {
						response: '¿Me das la dirección más completa? Incluye barrio, calle y número si es posible 😊',
						metadata: { agentType: 'ventas', flujo: 'credito', creditoData, creditoStep: stepIndex },
					};
				}

				creditoData[stepAnterior.field] = valor;
			}
		}

		const camposFaltantes = CREDITO_STEPS.filter((s) => !creditoData[s.field]);

		if (camposFaltantes.length > 0) {
			const siguientePaso = camposFaltantes[0];
			const indexReal = CREDITO_STEPS.findIndex(
				(s) => s.field === siguientePaso.field
			);

			const completados = CREDITO_STEPS.length - camposFaltantes.length;
			let transicion = '';
			if (completados === 1) transicion = '¡Gracias! ';
			else if (completados === 3) transicion = 'Vamos muy bien 💪 ';
			else if (completados === 5) transicion = 'Seguimos con la información. ';
			else if (completados === 8) transicion = 'Ya casi terminamos la parte personal. ';
			else if (completados === 11) transicion = 'Casi listo, solo faltan unos pocos datos más. ';
			else if (completados >= 13) transicion = '¡Ya casi terminamos! ';
			else if (completados > 0 && completados % 3 === 0) transicion = 'Perfecto. ';

			if (siguientePaso.field === 'skuProducto') {
				const queryTerm = creditoData.producto || 'electrodomestico';
				let matchedProducts: any[] = [];
				try {
					matchedProducts = await wooCommerceService.searchProducts(queryTerm, 5);
				} catch (e) {
					console.error('Failed to search WooCommerce in credit flow', e);
				}

				if (matchedProducts && matchedProducts.length > 0) {
					const opciones = matchedProducts.map((p) => ({
						sku: p.sku || String(p.id),
						name: p.name,
					}));
					const listStr = matchedProducts
						.map((p, i) => {
							return `${i + 1}️⃣ *${p.name}*`;
						})
						.join('\n');
					
					return {
						response: `${transicion}Para tu solicitud de crédito, encontré estos modelos disponibles en JLC Electronics. ¿Cuál de estos te gustaría financiar? Escríbeme el número de tu opción: 😊\n\n${listStr}\n\nSi prefieres otro, dime el nombre o escribe "otro".`,
						metadata: {
							agentType: 'ventas',
							flujo: 'credito',
							creditoData,
							creditoStep: indexReal + 1,
							creditoOptions: opciones,
						},
					};
				}
			}

			return {
				response: `${transicion}${siguientePaso.pregunta}`,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					creditoData,
					creditoStep: indexReal + 1,
				},
			};
		}

		const resumen = formatearResumenCredito(creditoData);

		let creditoNotificado = false;
		try {
			await enviarResumenWhatsApp(resumen);
			creditoNotificado = true;
		} catch (e) {
			console.error('Error enviando resumen de crédito por WhatsApp', e);
		}

		return {
			response: `¡Listo! 🎉 Tu solicitud fue enviada a nuestro equipo comercial. Un asesor se comunicará contigo pronto para continuar el proceso de crédito. Si tienes preguntas urgentes, puedes escribir al WhatsApp +57 318 740 8190.`,
			nextStage: 'TRANSFER',
			shouldTransfer: true,
			metadata: {
				agentType: 'ventas',
				flujo: 'credito_completado',
				modalidad: null,
				creditoData,
				// Solo pedir al handler que reintente si el envío directo falló
				// (evita doble notificación al +57 318 740 8190)
				notificarCredito: !creditoNotificado,
				creditoResumen: resumen,
			},
		};
	}

	// ── Handle principal ──────────────────────────────────────────────────────
	async handle(message: string, context: any): Promise<AgentResponse> {
		const lower = message.toLowerCase().trim();

		// ── Flujo de esperando_ciudad o esperando_modalidad pausado ──────────
		if (context?.flujo === 'esperando_ciudad_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			if (quiereContinuar) {
				context.flujo = 'esperando_ciudad';
				return {
					response: '¡Excelente! Sigamos. ¿Desde dónde nos escribes? 📍😊',
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_ciudad',
						pendingMessage: context?.pendingMessage,
					},
				};
			} else {
				context.flujo = null;
				return {
					response: 'Entendido, cancelamos la consulta. ¿En qué más te puedo ayudar hoy? 😊✨',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		if (context?.flujo === 'esperando_modalidad_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			if (quiereContinuar) {
				context.flujo = 'esperando_modalidad';
			return {
				response: '¡Súper! Cuéntame, ¿la compra sería al *contado* o a *crédito*? 💙',
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_modalidad',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
					pendingMessage: context?.pendingMessage,
				},
			};
			} else {
				context.flujo = null;
				return {
					response: 'Listo, dejamos de lado el proceso. ¿Qué otra duda o consulta tienes? 😊',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		// ── Flujo: Problema con la página web ──────────────────────────────────
		if (context?.flujo === 'problema_web') {
			const pd = context.problemaWebData || {};
			const detallesSuficientes = (pd.detalle?.length ?? 0) > 15 || pd.causa;
			if (detallesSuficientes) {
				return this.finalizarProblemaWeb(message, context);
			}
			return {
				response: 'Cuéntame más, ¿qué pasó exactamente? ¿Te apareció algún mensaje de error, en qué parte de la página ibas o qué estabas tratando de hacer? Así puedo entender mejor y ayudarte. 😊',
				metadata: {
					agentType: 'ventas',
					flujo: 'problema_web',
					problemaWebData: pd,
				},
			};
		}

		// Detectar problema web desde mensaje libre (sin flujo activo)
		const esProblemaWeb = !context?.flujo && /(?:problem[aeo]|error|fall[oóae]|no\s*(?:funcion[ae]|carg[aeo]|abre|sirve|dej[ao]|pued[eo])|pagina\s*(?:no|da|tien)|web\s*(?:no|mal|error)|trab[ae]ad[ao]|congel[ao]|se\s*(?:qued[oó]|trab[oó])|no\s*(?:carg[ao]|proces[oa]|redireccion[ae]|muestra))\b/i.test(lower);

		if (esProblemaWeb) {
			return {
				response: '¡Ay no, qué pena que estés teniendo inconvenientes con la página! 😟 Cuéntame, ¿qué estabas haciendo cuando se presentó el problema? ¿Te apareció algún mensaje de error? Así puedo revisar y ayudarte mejor. 💙',
				metadata: {
					agentType: 'ventas',
					flujo: 'problema_web',
					problemaWebData: { detalle: message },
				},
			};
		}

		// ── Flujo de crédito activo o pausado ──────────────────────────────────
		if (context?.flujo === 'credito' || context?.flujo === 'credito_pausado') {
			if (context?.flujo === 'credito_pausado') {
				const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar|reproducir/i.test(lower);
				if (quiereContinuar) {
					context.flujo = 'credito';
				} else {
					context.flujo = null;
					return {
						response: 'Entendido, cancelamos el proceso de crédito. ¿En qué más te puedo ayudar hoy? 😊',
						metadata: { agentType: 'ventas', flujo: null, modalidad: null },
					};
				}
			}
			if (context.flujo === 'credito') {
				return this.manejarFlujoCredito(message, context);
			}
		}

		// ── Flujo de pago o perfilando pausado ─────────────────────────────────
		if (context?.flujo === 'pago_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			if (quiereContinuar) {
				context.flujo = context.flujoAnterior || 'seleccion_pago';
			} else {
				context.flujo = null;
				return {
					response: 'Listo, dejamos de lado el pago. ¿Qué otra duda o consulta tienes? 😊',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		if (context?.flujo === 'perfilando_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			const mencionaProducto = context?.ultimaBusqueda?.results?.length > 0 && (
				/\b(?:primero|primera|segundo|segunda|tercero|tercera|[1-3])\b/i.test(lower) ||
				/(?:me (?:interesa|gusta|llama|llam[oó])|quiero|prefiero|ese|esa|este|esta|ese modelo|esa referencia)/i.test(lower)
			);
			if (quiereContinuar) {
				context.flujo = 'perfilando';
			} else if (mencionaProducto) {
				context.flujo = null;
			} else {
				context.flujo = null;
				return {
					response: 'Perfecto, cuéntame entonces en qué producto estás interesado y te busco las mejores opciones. 😊',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		// ── Flujo de selección de pago ambiguo (Mejora #21 de info.md) ─────────
		if (context?.flujo === 'seleccion_pago_ambiguo') {
			const opcion = message.trim();
			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			
			// Extraer último mensaje del asistente para contexto
			const history = context?.history || [];
			const assistantMsgs = history.filter((h: any) => h.role === 'model');
			const lastAssistantMsg = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].parts[0].text : '';

			// Usar IA para interpretar cuál producto seleccionó
			const selected: any = await matchProductoDesdeMsg(opcion, ultimosProductos, lastAssistantMsg);

			if (selected) {
				const precioStr = selected.price ? ` tiene un valor de *$${Number(selected.price).toLocaleString('es-CO')}*` : '';
				const linkStr = selected.permalink ? `\nAquí tienes el enlace del producto:\n${selected.permalink}` : '';
				const ciudadStr = context?.ciudad ? ` con envío gratis a ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
				const opcionPuntoFisico = context?.tieneCobertura ? '\n3️⃣ Paga en un punto físico' : '';
				
				return {
					response: `¡Perfecto! El *${selected.name}*${precioStr}${ciudadStr}.${linkStr}\n\n¿Cómo prefieres realizar el pago? 💳\n1️⃣ Por transferencia bancaria (medios autorizados)\n2️⃣ Directamente en nuestra página web (PSE, Tarjeta, Nequi)${opcionPuntoFisico}\n\nEscríbeme el número de tu opción y te doy las instrucciones paso a paso. 😊`,
					nextStage: 'PROPOSAL',
					metadata: {
						agentType: 'ventas',
						flujo: 'seleccion_pago',
						modalidad: 'contado',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						productoCompra: selected.name,
						productoURL: selected.permalink,
						ultimaBusqueda: context?.ultimaBusqueda,
					},
				};
			} else {
				// Si el mensaje es una consulta sobre otros productos (no un intento de selección fallido),
				// salir del flujo para que el procesamiento normal lo maneje
				const esConsultaProducto = /[¿?]|quiero (?:ver|que me muestre|saber)|muestra|hay.*(?:m[aá]s|otro)|no\s+(?:me gusta|quiero|gracias)|tienes.*(?:de |con )|capacidad|kilos|kg\b|litros|lt\b|pulgadas|potencia|m[aá]s (?:grande|peque|chico|barato|caro)|m[aá]s grande|m[aá]s peque|otro modelo|otra opcion|otras opciones|no tiene|b[uú]sca|b[uú]squeda|recomiend|presupuesto/i.test(message);
				if (esConsultaProducto) {
					context.flujo = null;
					// No se retorna — el flujo normal procesa el mensaje
				} else {
					const listaNombres = ultimosProductos.slice(0, 3).map((p: any, i: number) => {
						const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar';
						return `${i + 1}️⃣ *${p.name}* (${precio})`;
					}).join('\n');
					return {
						response: `Disculpa, no logré captar tu elección. Por favor escríbeme el número de la opción que prefieres:\n\n${listaNombres}`,
						metadata: {
							agentType: 'ventas',
							flujo: 'seleccion_pago_ambiguo',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
							ultimaBusqueda: context?.ultimaBusqueda,
						},
					};
				}
			}
		}

		// ── Pre-poblar ciudad desde UserData si ya está guardada ─────────────
		if (!context?.ciudad && context?.userData?.ciudad) {
			context = {
				...context,
				ciudad: context.userData.ciudad,
				ciudadValidada: true,
				departamento: context.userData.departamento ?? undefined,
			};
		}

		// ── SI ESTAMOS ESPERANDO CIUDAD, procesar primero (PASO 2) ─────────
		if (context?.flujo === 'esperando_ciudad') {
			let ciudadDetectada = await extraerCiudadDelMensaje(message);
			if (!ciudadDetectada) {
				ciudadDetectada = await detectarCiudadConIA(message);
			}
			if (!ciudadDetectada) {
				const limpio = message.trim().replace(/[.,!?¡¿]+$/g, '');
				if (limpio.length >= 3 && limpio.length <= 30) {
					ciudadDetectada = limpio.toLowerCase();
				}
			}

			if (!ciudadDetectada) {
				return {
					response: `No logré identificar tu ciudad. ¿Puedes escribirla de nuevo? 📍`,
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_ciudad',
						pendingMessage: context?.pendingMessage,
					},
				};
			}

			const cobertura = await verificarCobertura(ciudadDetectada);
			const ciudadCap = ciudadDetectada.charAt(0).toUpperCase() + ciudadDetectada.slice(1);

			if (cobertura === 'cobertura') {
				const msgOriginal = context?.pendingMessage || '';
				const yaDijoCredito = /\b(?:cr[eé]dito|financiar|cuotas|a cuotas|financiaci[oó]n)\b/i.test(msgOriginal);
				if (yaDijoCredito) {
					return {
						response: `¡Qué bien! A ${ciudadCap} te llega con envío gratis 🚚\n\n¡Dale, te ayudo con el crédito! 📋 Para armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
						metadata: {
							agentType: 'ventas',
							ciudad: ciudadDetectada,
							ciudadValidada: true,
							tieneCobertura: true,
							flujo: 'credito',
							modalidad: 'credito',
							creditoData: {},
							creditoStep: 1,
						},
					};
				}
			return {
				response: `¡Qué bien! A ${ciudadCap} te llega con envío gratis 🚚\n\n¿La compra sería al *contado* o a *crédito*?`,
				metadata: {
					agentType: 'ventas',
					ciudad: ciudadDetectada,
					ciudadValidada: true,
					tieneCobertura: true,
					flujo: 'esperando_modalidad',
					pendingMessage: context?.pendingMessage,
					productoSolicitado: context?.userData?.productoSolicitado || context?.pendingMessage || undefined,
					ultimaBusqueda: context?.ultimaBusqueda,
					terminoBusqueda: context?.terminoBusqueda,
				},
			};
			}

			const msgSinCobertura = (await generarMensajeSinCobertura(ciudadCap, context?.pendingMessage || '')).trim();
			return {
				response: msgSinCobertura,
				metadata: {
					agentType: 'ventas',
					ciudad: ciudadDetectada,
					ciudadValidada: true,
					tieneCobertura: false,
					modalidad: 'contado',
					flujo: null,
					productoSolicitado: context?.userData?.productoSolicitado || context?.pendingMessage || undefined,
					ultimaBusqueda: context?.ultimaBusqueda,
					terminoBusqueda: context?.terminoBusqueda,
				},
			};
		}

		// ── SI ESTAMOS ESPERANDO MODALIDAD (contado / crédito) ─────────────
		if (context?.flujo === 'esperando_modalidad') {
			const quiereCredito = /cr[eé]dito|a cr[eé]dito|financiar|financiaci[oó]n|cuotas|pagar a cuotas|^\s*1\s*$/i.test(lower);
			const quiereContado = /contado|efectivo|pago inmediato|precio de contado|contadito|^\s*2\s*$/i.test(lower);

			if (quiereCredito) {
				return {
					response: `¡Dale, te ayudo con el crédito! 📋\n\nPara armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
					metadata: {
						agentType: 'ventas',
						flujo: 'credito',
						modalidad: 'credito',
						creditoData: {},
						creditoStep: 1,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						productoSolicitado: context?.userData?.productoSolicitado || context?.pendingMessage || undefined,
					},
				};
			}

			if (quiereContado) {
				const msgOriginal = context?.pendingMessage || '';
				let terminoIA = await extraerProductoConIA(msgOriginal);
				if (!terminoIA && msgOriginal.length > 3) {
					terminoIA = msgOriginal;
				}
				if (terminoIA) {
					let products: any[] = [];
					try {
						products = await wooCommerceService.searchProducts(terminoIA, 20);
					} catch { /* continuar sin productos */ }
					if (products.length > 0) {
						const cat = detectarCategoria(msgOriginal) || 'otra';
						const esEspecifico = /[A-Z]{2,5}[-][A-Z0-9]+/.test(msgOriginal) || /\d+\s*(?:litros?|kg|pulgadas?|lb|w|vatios?|refrigeraci[oó]n)/i.test(msgOriginal);
						if (esEspecifico) {
							const nums = (msgOriginal.match(/\d+[kKlLgG]*/g) || []).map((n: string) => n.toLowerCase());
							const filtrados = products.filter(p => nums.some((n: string) => p.name.toLowerCase().includes(n)));
							const finales = filtrados.length > 0 ? filtrados.slice(0, 4) : products.slice(0, 4);
							const lista = finales.map((p, i) => `${i + 1}. *${p.name}* — $${parseInt(p.price).toLocaleString('es-CO')}`).join('\n');
							return {
								response: `¡Perfecto! Estos son algunos productos que encontré:\n\n${lista}\n\n¿Te gusta alguno? Cuéntame cuál para darte más detalles 😊`,
								metadata: {
									agentType: 'ventas',
									modalidad: 'contado',
									ciudad: context?.ciudad,
									ciudadValidada: true,
									tieneCobertura: context?.tieneCobertura,
									terminoBusqueda: terminoIA,
									ultimaBusqueda: { results: finales, categoria: cat, productoIndex: 0 },
									flujo: null,
								},
							};
						}
						const shortcuts = detectarShortcuts(msgOriginal, cat);
						const pasos = PROFILING_STEPS[cat] || PROFILING_STEPS.otra;
						const camposOk = camposPerfilCompletados(shortcuts);
						if (camposOk < pasos.length) {
							const primerPaso = pasos.find(p => !shortcuts[p.field]);
							if (primerPaso) {
								return {
									response: `¡Perfecto! ${primerPaso.pregunta}`,
									metadata: {
										agentType: 'ventas',
										flujo: 'perfilando',
										perfilState: { categoria: cat, step: 1, answers: shortcuts, terminoOriginal: terminoIA },
										ciudad: context?.ciudad,
										ciudadValidada: true,
										tieneCobertura: context?.tieneCobertura,
										modalidad: 'contado',
										productosPreCargados: products,
									},
								};
							}
						}
						const lista = products.slice(0, 6).map((p, i) => `${i + 1}. *${p.name}* — $${parseInt(p.price).toLocaleString('es-CO')}`).join('\n');
						return {
							response: `¡Perfecto! Estos son algunos productos que encontré:\n\n${lista}\n\n¿Te gusta alguno? Cuéntame cuál para darte más detalles 😊`,
							metadata: {
								agentType: 'ventas',
								modalidad: 'contado',
								ciudad: context?.ciudad,
								ciudadValidada: true,
								tieneCobertura: context?.tieneCobertura,
								terminoBusqueda: terminoIA,
								ultimaBusqueda: { results: products, categoria: cat, productoIndex: 0 },
								flujo: null,
							},
						};
					}
				}
				// Sin resultados de WooCommerce → iniciar perfilado con la categoría detectada
				const cat = detectarCategoria(msgOriginal) || 'otra';
				const pasos = PROFILING_STEPS[cat] || PROFILING_STEPS.otra;
				const primerPaso = pasos[0];
				if (primerPaso) {
					return {
						response: `¡Perfecto! ${primerPaso.pregunta}`,
						metadata: {
							agentType: 'ventas',
							flujo: 'perfilando',
							perfilState: { categoria: cat, step: 1, answers: {}, terminoOriginal: msgOriginal },
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
							modalidad: 'contado',
							productoSolicitado: msgOriginal,
						},
					};
				}
				return {
					response: `¡Perfecto! Cuéntame, ¿qué estás buscando? 😊`,
					metadata: {
						agentType: 'ventas',
						modalidad: 'contado',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						flujo: null,
					},
				};
			}

			return {
				response: `Disculpa, no entendí. ¿La compra sería al *contado* o a *crédito*?\n\nResponde *1* o *contado* si pagas de contado, o *2* o *crédito* si deseas financiar.`,
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_modalidad',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
					pendingMessage: context?.pendingMessage,
				},
			};
		}

		// ── PASO 1: Validar cobertura si aún no se hizo (mejoras #2 y #4) ─────
		if (!context?.ciudadValidada) {
			const ciudadDetectada = await extraerCiudadDelMensaje(message);

			if (!ciudadDetectada) {
				const esPrimeraVez = !context?.history?.length && !context?.nuevaSesion;
				const saludo = getSaludo();
				const intro = esPrimeraVez
					? `${saludo} 👋 Soy ${AGENT_NAME}, tu asesora en JLC Electronics, la marca de los colombianos.\n\n`
					: '';
				const productoDetectado = detectarCategoria(message);
				const meta: any = {
					agentType: 'ventas',
					flujo: 'esperando_ciudad',
					pendingMessage: message,
				};
				if (productoDetectado) meta.productoSolicitado = productoDetectado;
				return {
					response: `${intro}¿Desde dónde nos escribes? 📍`,
					metadata: meta,
				};
			}

			const cobertura = await verificarCobertura(ciudadDetectada);

			if (cobertura === 'cobertura') {
				context = {
					...context,
					ciudadValidada: true,
					ciudad: ciudadDetectada,
					tieneCobertura: true,
				};
				const productoDetectado = detectarCategoria(message);
				return {
					response: `¡Qué bien! A ${ciudadDetectada.charAt(0).toUpperCase() + ciudadDetectada.slice(1)} te llega con envío gratis 🚚\n\n¿La compra sería al *contado* o a *crédito*?`,
					metadata: {
						agentType: 'ventas',
						ciudad: ciudadDetectada,
						ciudadValidada: true,
						tieneCobertura: true,
						flujo: 'esperando_modalidad',
						pendingMessage: message,
						...(productoDetectado && { productoSolicitado: productoDetectado }),
					},
				};
			}

			context = {
				...context,
				ciudadValidada: true,
				ciudad: ciudadDetectada,
				tieneCobertura: false,
			};
			const msgSinCobertura = (await generarMensajeSinCobertura(ciudadDetectada, context?.pendingMessage || '')).trim();
			const productoDetectado = context?.pendingMessage ? detectarCategoria(context.pendingMessage) : null;
			return {
				response: msgSinCobertura,
				metadata: {
					agentType: 'ventas',
					ciudad: ciudadDetectada,
					ciudadValidada: true,
					tieneCobertura: false,
					modalidad: 'contado',
					flujo: null,
					pendingMessage: context?.pendingMessage,
					...(productoDetectado && { productoSolicitado: productoDetectado }),
				},
			};
		}

		// ── PASO 3: Si eligió crédito → iniciar formulario ──────────────────
		const pideCredito = /\b(?:cr[eé]dito|financiar|cuotas|a cuotas|financiaci[oó]n|quiero.*(?:cr[eé]dito|financiar|cuotas)|financiame|me financias|a cr[eé]dito|cr[eé]dito directo)\b/i.test(message);
		if (pideCredito && context?.modalidad !== 'credito') {
			const nuevaModalidad = 'credito';
			return {
				response: `¡Dale, te ayudo con el crédito! 📋\n\nPara armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					modalidad: nuevaModalidad,
					creditoData: {},
					creditoStep: 1,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}
		if (context?.modalidad === 'credito' && context?.flujo !== 'credito_completado') {
			return {
				response: `¡Dale, te ayudo con el crédito! 📋\n\nPara armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					modalidad: 'credito',
					creditoData: {},
					creditoStep: 1,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}

		// ── PASO 4: Detectar intención de compra ─────────────────────────────
		const quiereComprarRaw = /\b(?:comprar(?:lo|la)?|lo quiero|la quiero|quiero(?: esa| esta| ese| este| comprar)?|c[oó]mo (?:compro|hago|puedo pagar|le hago|le hago para pagar|pago)|quiero pagar|proceder|concretar|compralo|c[oó]mpralo|reservar|apartar|d[áa]le|confirmo compra|ya lo quiero|me gusta(?: esa| esta| ese| el| la)?|esa me gusta|esta me gusta|si continuemos|si sigamos|sigamos adelante|seguimos|continuemos)\b|\bcompr(?:o|ar)\s+(?:esa|esta|este|ese|eso|esas|esos|estes)\b|\b(?:el de \d+|la de \d+|el primero|el segundo|la primera|la segunda|me quedo con|me interesa(?!\s+(?:saber|conocer|verificar|preguntar|consultar))(?: el| la)?|prefiero(?: el| la)?|lo compro|la compro|eso quiero|eso me sirve|eso me gusta|me llevo(?: el| la)?)\b|\b(?:el (?:de \d+|primero|segundo)|la (?:de \d+|primera|segunda))\b/i.test(message) && context?.ultimaBusqueda?.results?.length > 0;

		// Si el mensaje es una pregunta sobre medidas/specs, NO es intención de compra
		// aunque mencione "la 3" o "prefiero" — primero hay que responder la duda.
		const quiereComprar = quiereComprarRaw && !esPreguntaEspecificacion(message);

		const puedeComprar = context?.modalidad === 'contado' || 
			(context?.ultimaBusqueda?.results?.length > 0 && context?.modalidad !== 'credito');

		const esNegacionLocal = /^(?:no\s+|tampoco|nunca|jam[aá]s|ni\s*lo\s*quiero)/i.test(message);
		if (quiereComprar && puedeComprar && !esNegacionLocal) {
			const tieneCobertura = context?.tieneCobertura;
			const opcionPuntoFisico = tieneCobertura
				? '\n3️⃣ Paga en un punto físico'
				: '';

			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			let productoSolicitado: string | undefined;
			let productoURL: string | undefined;
			let pPrice: string | undefined;
			if (ultimosProductos.length === 1) {
				productoSolicitado = ultimosProductos[0].name;
				productoURL = ultimosProductos[0].permalink;
				pPrice = ultimosProductos[0].price;
			} else if (ultimosProductos.length > 1) {
				// Extraer último mensaje del asistente para contexto
				const history = context?.history || [];
				const assistantMsgs = history.filter((h: any) => h.role === 'model');
				const lastAssistantMsg = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].parts[0].text : '';

				// Usar IA para interpretar cuál producto seleccionó
				const matchResult = await matchProductoDesdeMsg(message, ultimosProductos, lastAssistantMsg);
				
				if (!matchResult) {
					// No se pudo identificar → preguntar con lista numerada
					const listaNombres = ultimosProductos.slice(0, 3).map((p: any, i: number) => {
						const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar';
						return `${i + 1}️⃣ *${p.name}* (${precio})`;
					}).join('\n');
					
					return {
						response: `¡Ay, qué bien! Pero para darte las instrucciones exactas necesito saber cuál te llevas 😊 Escríbeme el número:\n\n${listaNombres}`,
						metadata: {
							agentType: 'ventas',
							flujo: 'seleccion_pago_ambiguo',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
							ultimaBusqueda: context?.ultimaBusqueda,
						},
					};
				}
				
				productoSolicitado = matchResult.name;
				productoURL = matchResult.permalink;
				pPrice = matchResult.price;
			}

			const precioStr = pPrice ? ` tiene un valor de *$${Number(pPrice).toLocaleString('es-CO')}*` : '';
			const linkStr = productoURL ? `\nAquí tienes el enlace del producto:\n${productoURL}` : '';
			const ciudadStr = context?.ciudad ? ` con envío gratis a ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
			
			const opcionesMsg = `¡Excelente elección! El *${productoSolicitado || 'producto'}*${precioStr}${ciudadStr}.${linkStr}\n\nPara continuar con tu compra, ¿cómo prefieres realizar el pago? 💳\n1️⃣ Por transferencia bancaria (medios autorizados)\n2️⃣ Directamente en nuestra página web (PSE, Tarjeta, Nequi)${opcionPuntoFisico}\n\nEscríbeme el número de tu opción y te doy las instrucciones paso a paso. 😊`;

			return {
				response: opcionesMsg,
				metadata: {
					agentType: 'ventas',
					flujo: 'seleccion_pago',
					modalidad: 'contado',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura,
					...(productoSolicitado ? { productoCompra: productoSolicitado } : {}),
					...(productoURL ? { productoURL } : {}),
				},
			};
		}

		// ── PASO 4b: Consulta genérica sobre cómo pagar ─────────────────────
		const preguntaPago = /\b(?:c[oó]mo (?:pagar|pago|puedo pagar|hago para pagar)|medios de pago|formas de pago|d[oó]nde pago|puedo pagar)\b/i.test(message);
		if (preguntaPago && context?.modalidad === 'contado' && !context?.flujo?.startsWith('pago_') && context?.flujo !== 'seleccion_pago') {
			const tieneCobertura = context?.tieneCobertura;
			return {
				response: `Claro, estas son las opciones:\n1️⃣ Medios de pago autorizados\n2️⃣ Paga directamente en nuestra página web${tieneCobertura ? '\n3️⃣ Paga en un punto físico' : ''}\n¿Cuál prefieres?`,
				nextStage: 'PROPOSAL',
				metadata: {
					agentType: 'ventas',
					flujo: 'seleccion_pago',
					modalidad: 'contado',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura,
				},
			};
		}

		// ── PASO 4c: Seguimiento paso a paso para pago web ──────────────────
		if (context?.flujo === 'pago_web_paso') {
			const pasoActual: number = context?.pasoWeb ?? 1;

			// Pasos reales del checkout JLC Electronics
			const PASOS_WEB = [
				'Abre el enlace del producto y dale clic en el botón *Añadir al carrito* 🛒',
				'Ya en el carrito, busca la sección *"Calcula el envío"*. Selecciona tu *departamento* y dale clic en *Actualizar*. Así se habilitan las ciudades.',
				'Ahora selecciona tu *ciudad/municipio*, escribe tu *código postal* y vuelve a dar clic en *Actualizar*. Ahí te aparece el valor del flete (o "Envío gratis" si aplica). 😊',
				'Dale clic en el botón *Proceder al pago*. Se abre el formulario — llena todos tus datos (nombre, cédula, teléfono, dirección) y luego dale *Realizar el pedido*.',
				'Por último, selecciona tu método de pago en *Wommpi* (PSE, tarjeta de crédito, Nequi, Bancolombia, y más). Confirma el pago y ¡listo! 🎉',
			];

			const avanzar = /\b(?:listo|ya|hecho|ok|okay|sip|dale|s[íï]|siguiente|continu[ae]|lo hice|ya lo hice|ya est[aá]|ya termin[eé]|hice clic|le di|le doy|di clic|puse|escrib[íï]|ya puse|lo vi|me abri[oó]|me aparece|me sali[oó])\b/i.test(lower);

			if (avanzar) {
				if (pasoActual >= PASOS_WEB.length) {
					// Último paso completado → esperar comprobante
					return {
						response: `¡Genial! 🎉 Cuando aparezca la confirmación de pago, compárteme el comprobante o número de transacción por aquí (foto o pantallazo) y nuestro equipo te confirma el despacho de inmediato.`,
						metadata: {
							agentType: 'ventas',
							flujo: 'esperando_comprobante',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							productoURL: context?.productoURL,
						},
					};
				}
				const siguiente = pasoActual + 1;
				return {
					response: `Paso ${siguiente} de ${PASOS_WEB.length}: ${PASOS_WEB[siguiente - 1]}\n\nDime “listo” cuando termines o cuéntame si tienes alguna duda. 😊`,
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_web_paso',
						pasoWeb: siguiente,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						productoURL: context?.productoURL,
					},
				};
			}

			// El usuario escribe algo libre → responder con Gemini y recordar el paso
			const userDataStr2 = buildUserDataContext(context?.userData);
			const { system: sys2, user: usr2 } = buildGemmaPrompt({
				instruccion: `Eres Sara, asesora virtual de JLC Electronics Colombia. El cliente está en el proceso de pago en la página web (Paso ${pasoActual} de ${PASOS_WEB.length}: "${PASOS_WEB[pasoActual - 1]}"). Tiene una duda o comentario sobre ese proceso. Respóndele de forma breve y cálida en español colombiano femenino. NO recomiendes otros productos.\n${userDataStr2}`,
				ejemplos: [],
				historial: formatHistory(context?.history),
				mensajeCliente: message,
			});
			const rawWp = await generateResponse(usr2, sys2);
			const respWp = sanitizarNumerosVentas(cleanResponse(rawWp));
			return {
				response: `${respWp}\n\n_(Paso ${pasoActual} de ${PASOS_WEB.length}: ${PASOS_WEB[pasoActual - 1]} — dime “listo” cuando termines 😊)_`,
				metadata: {
					agentType: 'ventas',
					flujo: 'pago_web_paso',
					pasoWeb: pasoActual,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					productoURL: context?.productoURL,
				},
			};
		}

		// ── Manejo de pago completado o fallido ───────────────────────────────
		if (context?.flujo === 'pago_completado') {
			const noPudo = /no\s*(?:pude|puedo|logr[eé]|me\s*dej[oó])|problema|error|fallo|fall[oó]|no\s*sirv[eió]/i.test(lower);
			if (noPudo) {
				const ciudadCap = context?.ciudad ? context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1) : '';
				const productoInfo = context?.productoURL || 'producto pendiente';
				const notificacion = `⚠️ Cliente desde ${ciudadCap} no pudo completar el pago web.\nProducto: ${productoInfo}\nRequiere asistencia.`;
				try {
					const WA_ESCALAMIENTO = process.env.WA_ESCALAMIENTO || '573187408190';
					await sendWA(WA_ESCALAMIENTO, notificacion);
				} catch { /* no bloquear */ }

				return {
					response: `No te preocupes, ya le notifiqué a nuestro equipo comercial para que te ayude directamente. Un asesor te va a escribir por aquí en un momentico. 😊`,
					metadata: {
						agentType: 'ventas',
						flujo: null,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						escalado: true,
					},
				};
			}
			return {
				response: `¡Qué bien! 🎉 Para confirmar tu pago, compárteme el comprobante o número de transacción por aquí (foto o pantallazo). Nuestro equipo lo verifica y te programamos el envío lo antes posible.`,
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_comprobante',
					ciudad: context?.ciudad,
					ciudadValidada: true,
				},
			};
		}

		if (context?.flujo === 'pago_web') {
			const quiereAyuda = /\bs[íi]\b|sip|dale|ok|bueno|claro|si gracias|si por favor|me acompañas|guíame|ayúdame|paso a paso/i.test(lower);
			if (quiereAyuda) {
				return {
					response: `¡Con mucho gusto te acompaño! 😊\n\nPaso 1 de 5: Abre el enlace del producto y dale clic en el botón *Añadir al carrito* 🛒\n\nDime "listo" cuando lo hayas hecho.`,
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_web_paso',
						pasoWeb: 1,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						productoURL: context?.productoURL,
					},
				};
			}
			return {
				response: `Perfecto, cualquier duda me avisas. 😊`,
				metadata: {
					agentType: 'ventas',
					flujo: null,
					ciudad: context?.ciudad,
					ciudadValidada: true,
				},
			};
		}

		// ── PASO 4d: Confirmación de pago realizado ──
		const yaPago = /\b(?:ya pagu[eé]|pago realizado|ya transfer[ií]|ya realic[eé] el pago|ya hice el pago|pago hecho|listo el pago|comprobante enviado)\b/i.test(message);
		if (yaPago && context?.modalidad === 'contado') {
			return {
				response: `¡Perfecto! Para confirmar tu pago, ¿me puedes compartir el comprobante o el número de transacción? (Puedes enviar una captura de pantalla / pantallazo o foto). 😊\n\nUna vez enviado, nuestro equipo verificará el pago en un tiempo máximo de 1 hora y procederemos con el despacho inmediato de tu pedido con envío gratis. En ese momento te enviaremos el número de guía para que puedas rastrearlo.`,
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_comprobante',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}

		// ── PASO 4e: Ya estamos esperando el comprobante ────────────────────
		if (context?.flujo === 'esperando_comprobante') {
			const productoSolicitado = context?.productoSolicitado || context?.userData?.productoSolicitado || 'tu producto';
			const ciudad = context?.ciudad || context?.userData?.ciudad || '';
			const tieneCiudad = !!ciudad;
			const responseParts = [
				`¡Ay, qué chévere! Ya recibí tu comprobante, así que voy a confirmar el pago de ${productoSolicitado} para dejarla reservada y lista para el envío${tieneCiudad ? ` a ${ciudad}` : ''}. Tan pronto el equipo lo verifique, te estaré contando. ¡Muchas gracias por tu compra! 😊`,
			];
			return {
				response: responseParts.join('\n\n'),
				metadata: {
					agentType: 'ventas',
					flujo: null,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}

		// ── PASO 5: Flujo de selección de pago ──────────────────────────────
		if (context?.flujo === 'seleccion_pago') {
			const opcion = message.trim();
			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			const productoURL = context?.productoURL ?? ultimosProductos[0]?.permalink;

			// PRIORIDAD: si el cliente hace una pregunta (medidas, specs, etc.)
			// en vez de elegir, salir del flujo de pago y responder la pregunta.
			if (esPreguntaEspecificacion(message) && context?.ultimaBusqueda?.results?.length > 0) {
				// Dejar que caiga al bloque de preguntaSeguimiento más abajo
				context = { ...context, flujo: null };
			} else {
				// Matching ANCLADO: la opción debe SER el número/palabra, no contenerlo.
				const esOpcion1 = /^\s*1\s*[.)]?\s*$/.test(opcion) || /^(?:transferencia|medios?\s*(?:de\s*pago|autorizados?)|consignaci[oó]n)\b/i.test(opcion);
				const esOpcion2 = /^\s*2\s*[.)]?\s*$/.test(opcion) || /^(?:p[aá]gina\s*web|web|en\s*l[íi]nea|online|pse|tarjeta|nequi)\b/i.test(opcion);
				const esOpcion3 = /^\s*3\s*[.)]?\s*$/.test(opcion) || /^(?:punto\s*f[íi]sico|f[íi]sico|tienda|presencial)\b/i.test(opcion);

				if (esOpcion1) {
					return {
						response: `Estos son nuestros medios de pago autorizados:\nhttps://jlc-electronics.com/wp-content/uploads/2026/05/Medios_de_pago.jpeg\n\nAhí verás todas las cuentas disponibles (Bancolombia, Davivienda, Nequi, etc.). Una vez realices la transferencia, por favor compárteme tu nombre completo, número de cédula y el comprobante de pago${context?.tieneCobertura ? ' para programar tu envío gratis' : ' y coordinamos el despacho por transportadora'} de inmediato.\n\n¿Pudiste completar el pago o te surgió alguna duda? 😊`,
						nextStage: 'PROPOSAL',
						metadata: {
							agentType: 'ventas',
							flujo: 'pago_medios',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							productoURL,
						},
					};
				}
				if (esOpcion2) {
					const productLink = productoURL
						? `\n\nLink del producto:\n${productoURL}`
						: '';
					return {
						response: `Puedes pagar directamente en nuestra página web.${productLink}\n\n¿Quieres que te acompañe paso a paso con el proceso?`,
						nextStage: 'PROPOSAL',
						metadata: {
							agentType: 'ventas',
							flujo: 'pago_web',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							productoURL,
						},
					};
				}
				if (context?.tieneCobertura && esOpcion3) {
					return {
						response: `¡Claro! Para reservarte el producto en el punto más cercano, necesito tu nombre completo y número de cédula. 😊`,
						nextStage: 'PROPOSAL',
						metadata: {
							agentType: 'ventas',
							flujo: 'pago_fisico',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							notificarPuntoFisico: true,
						},
					};
				}
				return {
					response: `Por favor elige una opción:\n1️⃣ Medios de pago autorizados\n2️⃣ Paga directamente en nuestra página web${context?.tieneCobertura ? '\n3️⃣ Paga en un punto físico' : ''}\n¿Cuál prefieres?`,
					metadata: {
						agentType: 'ventas',
						flujo: 'seleccion_pago',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
					},
				};
			}
		}

		// ── Continuación pago físico: usuario ya dio nombre + cédula ────
		if (context?.flujo === 'pago_fisico') {
			const cedulaMatch = message.match(/\b\d{5,12}\b/);
			const nombre = message.replace(/\b\d{5,12}\b/g, '').trim();
			const tieneNombre = nombre.length >= 3;
			const tieneCedula = !!cedulaMatch;

			if (tieneNombre || tieneCedula) {
				return {
					response: `¡Gracias! Tu solicitud de compra en punto físico quedó registrada. Un asesor se comunicará contigo para coordinar la entrega. Si necesitas algo más, acá estoy para ayudarte 😊💙`,
					nextStage: 'TRANSFER',
					metadata: {
						agentType: 'ventas',
						flujo: null,
						nombreCliente: nombre.length >= 3 ? nombre : undefined,
						cedulaCliente: cedulaMatch ? cedulaMatch[0] : undefined,
					},
				};
			}
			return {
				response: `¿Me confirmas tu nombre completo y número de cédula para la reserva? 😊`,
				metadata: { agentType: 'ventas', flujo: 'pago_fisico' },
			};
		}

		// ── PASO 6: Detectar datos personales del cliente ──────────────────
		const datosPersonales: Record<string, string> = {};
		const cedulaMatch = message.match(/\b\d{5,12}\b/);
		if (cedulaMatch) datosPersonales.cedulaCliente = cedulaMatch[0];

		const nombreMatch = message.match(/^(?:mi nombre es|soy|me llamo)\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s]+)/i);
		if (nombreMatch) datosPersonales.nombreCliente = nombreMatch[1].trim();

		if (message.length > 5 && message.split(/[,;]/).length >= 2 && datosPersonales.cedulaCliente) {
			const partes = message.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
			if (partes.length >= 2 && !datosPersonales.nombreCliente) {
				datosPersonales.nombreCliente = partes[0];
			}
			if (partes.length >= 3) {
				datosPersonales.direccion = partes.slice(2).join(', ');
			}
		}

		// ── PASO 7: Motor de perfilamiento por categoría ────────────────────
		const perfilState = context?.perfilState as { categoria: string; step: number; answers: Record<string, string> } | undefined;

		if (context?.flujo === 'perfilando' && perfilState) {
			const pasos = PROFILING_STEPS[perfilState.categoria] || PROFILING_STEPS.otra;
			const pasoActual = pasos[perfilState.step - 1];
			if (pasoActual) {
				perfilState.answers[pasoActual.field] = resolverRespuestaPerfil(message, pasoActual.field);
				perfilState.step++;
			}

			const camposOk = camposPerfilCompletados(perfilState.answers);

			if (camposOk >= pasos.length || perfilState.step > pasos.length) {
				const terminoBusqueda = (perfilState as any).terminoOriginal || obtenerTerminoBusquedaDesdePerfil(perfilState.categoria, perfilState.answers);

			// Consultar WooCommerce fresco con el término del perfil
			let products: any[] = [];
			const terminoOriginal = (perfilState as any).terminoOriginal;
			const terminoBusquedaPerfil = terminoOriginal || obtenerTerminoBusquedaDesdePerfil(perfilState.categoria, perfilState.answers);
			if (terminoBusquedaPerfil) {
				try {
					const resultado = await buscarProductoInteligente(terminoBusquedaPerfil, perfilState.categoria);
					if (resultado.products.length > 0) products = resultado.products;
				} catch { /* fall through */ }
			}

				// Aplicar filtro de presupuesto si el cliente lo dio
				const presupuestoRaw = perfilState.answers.presupuesto;
				if (presupuestoRaw && products.length > 0) {
					const techo = parsearPresupuesto(presupuestoRaw);
					if (techo > 0) {
						const dentroPresupuesto = products.filter((p: any) => {
							const precio = parseFloat(p.price || '0');
							return precio > 0 && precio <= techo * 1.15; // 15% de margen
						});
						if (dentroPresupuesto.length > 0) {
							products = dentroPresupuesto.sort((a: any, b: any) =>
								parseFloat(a.price || '0') - parseFloat(b.price || '0')
							);
						}
					}
				}

				context = { ...context, flujo: null, terminoBusqueda, ultimaBusqueda: products.length > 0 ? { results: products, categoria: perfilState.categoria, productoIndex: 0 } : context?.ultimaBusqueda };
				if (perfilState.answers.presupuesto) {
					datosPersonales.presupuesto = perfilState.answers.presupuesto;
				}
			} else {
				const siguientePaso = pasos[perfilState.step - 1];
				return {
					response: siguientePaso.pregunta,
					metadata: {
						agentType: 'ventas',
						flujo: 'perfilando',
						perfilState,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						modalidad: context?.modalidad,
						...datosPersonales,
					},
				};
			}
		}

		const CATEGORIAS = CATEGORIAS_RE;
		const esCategoriaSola = CATEGORIAS.test(message) && message.split(/\s+/).length <= 4;
		const esBusquedaCategoria = CATEGORIAS.test(message) && /(?:busco|quiero|necesito|me interesa|tiene[ns]?|hay|venden|muestra|quisiera|info de|informacion de|precio de|precios de|cuesta|cuestan|vale|valen|consulta|tambi[eé]n)/i.test(message);
		const categoriaGeneral = esCategoriaSola || esBusquedaCategoria;

		if (categoriaGeneral) {
			const nuevaCategoria = detectarCategoria(message);
			const categoriaAnterior = context?.ultimaBusqueda?.categoria;
			if (nuevaCategoria && categoriaAnterior && nuevaCategoria !== categoriaAnterior) {
				context = {
					...context,
					ultimaBusqueda: undefined,
					terminoBusqueda: undefined,
					perfilState: undefined,
					flujo: null,
				};
			}
		}
		let catDetectada = detectarCategoria(message);
		// Si el mensaje actual no tiene categoría pero es pregunta de medidas/specs,
		// inferir categoría desde el pendingMessage o productoSolicitado anterior
		if (!catDetectada && esPreguntaEspecificacion(message)) {
			const textoAnterior = context?.pendingMessage || context?.userData?.productoSolicitado || '';
			if (textoAnterior) catDetectada = detectarCategoria(textoAnterior);
		}
		if ((categoriaGeneral || catDetectada) && context?.flujo !== 'perfilando') {
			const cat = catDetectada;
			if (cat) {
				const terminoParaBuscar = message.toLowerCase().replace(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa)\s*/gi, '').trim();
				let productosDisponibles: any[] = [];
				try {
					productosDisponibles = await wooCommerceService.searchProducts(terminoParaBuscar, 20);
					if (productosDisponibles.length === 0) {
						productosDisponibles = await wooCommerceService.searchProducts(cat, 20);
					}
				} catch { /* continuar sin productos */ }

				if (productosDisponibles.length === 0) {
					// Sin resultados → la IA responde naturalmente según el contexto
					context = { ...context, flujo: null, terminoBusqueda: terminoParaBuscar, ultimaBusqueda: undefined };
				}

				const shortcuts = detectarShortcuts(message, cat);
				const pasos = PROFILING_STEPS[cat] || PROFILING_STEPS.otra;
				const campos = camposPerfilCompletados(shortcuts);

				// Si el cliente está preguntando por medidas/specs, NO perfilar por
				// presupuesto.
				if (esPreguntaEspecificacion(message)) {
					// ¿Mencionó una referencia/SKU o producto específico?
					const sku = extraerSKU(message);
					const resultadoEspecifico = (sku || message.length > 25)
						? await buscarProductoInteligente(message, cat)
						: { products: [], estrategia: 'sin_resultados' };

					// Identificar el producto exacto si lo encontramos
					let productoExacto: any = null;
					if (resultadoEspecifico.products.length > 0) {
						if (sku) {
							productoExacto = resultadoEspecifico.products.find((p: any) =>
								(p.sku && p.sku.toUpperCase().includes(sku.replace(/^JLC-/, ''))) ||
								(p.name && p.name.toUpperCase().includes(sku.replace(/^JLC-/, '')))
							) || resultadoEspecifico.products[0];
						} else {
							productoExacto = resultadoEspecifico.products[0];
						}
					}

					// Si identificamos el producto específico → responder sobre ÉL
					if (productoExacto) {
						context = {
							...context,
							flujo: null,
							ultimaBusqueda: { results: [productoExacto, ...resultadoEspecifico.products.filter((p: any) => p.id !== productoExacto.id)], categoria: cat, productoIndex: 0 },
							terminoBusqueda: productoExacto.name,
							productoSolicitado: productoExacto.name,
						};
						// Cae al bloque de preguntaSeguimiento/Gemma más abajo para
						// responder las medidas usando los Detalles del catálogo.
					} else {
						// No identificó producto exacto → pasar productos disponibles a la IA
						const terminoLegible = (context?.pendingMessage && detectarCategoria(context.pendingMessage)) || cat;
						context = {
							...context,
							flujo: null,
							ultimaBusqueda: { results: productosDisponibles, categoria: cat, productoIndex: 0 },
							terminoBusqueda: terminoLegible,
							productoSolicitado: terminoLegible,
						};
					}
				}

				if (esPreguntaEspecificacion(message)) {
					// El producto ya fue identificado arriba; saltar el perfilamiento
				} else if (campos >= pasos.length) {
					const terminoBusqueda = terminoParaBuscar;
					context = { ...context, terminoBusqueda };
				} else {
					const primerPaso = pasos.find(p => !shortcuts[p.field]);
					if (primerPaso) {
						const prodMatch = message.match(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa|info de|informacion de)\s*(?:un[oa]?|unas?|disponible|esta|este|esa|ese)?\s*([a-záéíóúñÁÉÍÓÚÑ][a-záéíóúñÁÉÍÓÚÑ\s]{2,40})/i);
						return {
							response: primerPaso.pregunta,
							metadata: {
								agentType: 'ventas',
								flujo: 'perfilando',
								perfilState: {
									categoria: cat,
									step: pasos.indexOf(primerPaso) + 1,
									answers: shortcuts,
									terminoOriginal: prodMatch ? prodMatch[1].trim().toLowerCase() : terminoParaBuscar
								},
								ciudad: context?.ciudad,
								ciudadValidada: true,
								tieneCobertura: context?.tieneCobertura,
								modalidad: context?.modalidad,
								productosPreCargados: productosDisponibles,
								productoSolicitado: terminoParaBuscar,
								ultimaBusqueda: { results: productosDisponibles, categoria: cat, productoIndex: 0 },
								...datosPersonales,
							},
						};
					}
				}
			}
		}

		// ── Identidad y despedidas ahora las maneja la IA directamente ────

		// ── Seguimiento post-compra (ya pagó / guía / cuándo llega) ─────────
		// NO mostrar números de cartera; confirmar registro y escalar internamente.
		const yaCompro = /(?:ya\s*(?:compr[éeó]|pagu[éeó]|cancel[éeó]|realic[éeé]|hice\s*(?:el|la)\s*(?:compra|pago|transferencia))|qued[óo]\s*pag[ao]|hice\s*la\s*compra|complet[éeó]\s*(?:el|la)\s*(?:compra|pago))/i.test(lower);
		const preguntaEnvio = /(?:gu[ií]a|despacho|cu[aá]ndo\s*(?:llega|recibo|lo\s*recibo|me\s*llega)|estado\s*(?:de\s*)?(?:mi\s*)?pedido|rastre|tracking|seguimiento|cu[aá]nto\s*(?:tarda|demora|se\s*demora)|correo\s*con\s*la\s*gu[ií]a)/i.test(lower);
		const pideCartera = /\bcartera\b/i.test(lower);

		if ((yaCompro || preguntaEnvio) && !pideCartera) {
			return {
				response: `¡Qué buena noticia! 🎉 Tu pedido ya quedó registrado; el equipo te confirma el despacho y la guía muy pronto por aquí.`,
				metadata: {
					agentType: 'ventas',
					flujo: null,
					notificarPostCompra: true, // el handler escala al +57 318 740 8190
					ciudad: context?.ciudad,
					ciudadValidada: context?.ciudadValidada,
					...datosPersonales,
				},
			};
		}

		// ── Preguntas de stock/disponibilidad → escalar a Cris ─────────────
		const preguntaStock = /(?:hay\s*(?:en\s*)?stock|disponible|disponibilidad|cu[aá]ndo\s*(?:llega|llegar[aá]|est[aá]|hay)|tiempo\s*(?:de\s*)?entrega|demora|cu[aá]nto\s*(?:demora|tarda)|lo\s*tiene\s*(?:en\s*)?stock|est[aá]\s*(?:disponible|en\s*stock)|fecha\s*(?:de\s*)?entrega|llega\s*(?:a\s*)?(?:mi\s*)?ciudad)/i.test(message);
		if (preguntaStock && !context?.flujo) {
			const ciudad = context?.ciudad || context?.userData?.ciudad || '';
			const producto = context?.ultimaBusqueda?.results?.[0]?.name || context?.productoSolicitado || context?.terminoBusqueda || '';
			return {
				response: `Déjame confirmar disponibilidad y tiempo de entrega${ciudad ? ` para ${ciudad}` : ''}${producto ? ` del producto ${producto}` : ''} con el equipo; te confirmamos por aquí muy pronto 😊`,
				metadata: {
					agentType: 'ventas',
					flujo: null,
					notificarPostCompra: true,
					ciudad: context?.ciudad,
					ciudadValidada: context?.ciudadValidada,
				},
			};
		}

		// ── Si está en flujo de pago pero pide un producto nuevo, reiniciar ──
		let resetFlujo = false;
		const esNuevoProductoEnPago = context?.flujo === 'seleccion_pago' && /(?:y\s*(?:de|en|para)\s*(?:los|las|un|una)?|qu[e\u00e9]\s*(?:tal|hay\s*de|me\s*recomiendas|otr[oa]s?\s*opciones)|recomiendas|recomi[e\u00e9]ndame|tienes?\s*(?:televisores?|neveras?|lavadoras?|congeladores?|tvs?|licuadoras?|parlantes?|aires?\s*(?:acondicionado)?|ventiladores?|estufas?|hornos?|microondas?|equipos?\s*de\s*sonido|monitores?|pantallas?|aspiradoras?|planchas?)|(?:y\s*)?(?:en\s*)?(?:televisores|neveras|lavadoras|congeladores|tvs|licuadoras|parlantes|sonido|aire|ventiladores|electrodom[e\u00e9]sticos))/i.test(message);
		if (esNuevoProductoEnPago) {
			context = { ...context, flujo: null, ultimaBusqueda: undefined, terminoBusqueda: message };
			resetFlujo = true;
		}

		// ── Detectar intención de compra ("me gusta", "cómo pago", "lo quiero") ─
		const tieneProductos = context?.ultimaBusqueda?.results?.length > 0;
		const esNegacion = /^(?:no\s+|tampoco|nunca|jam[aá]s|ni\s*lo\s*quiero)/i.test(message);
		const compraIntencion = !esNegacion && /(?:me\s*gusta|lo\s*quiero|lo\s*compro|c[oó]mo\s*(?:pago|compro|adquiero)|quiero\s*(?:comprar|pagar|adquirir|lle[vv]armelo|ese)|dalo|res[eé]rvalo|lo\s*reservo|comprar|pagar)/i.test(message);

		// Intentar emparejar el precio mencionado en el mensaje con un producto de la búsqueda anterior
		function extraerPrecio(texto: string): number | null {
			const colMatch = texto.match(/\d{1,3}\.\d{3}(?:\.\d{3})*/);
			if (colMatch) return parseInt(colMatch[0].replace(/\./g, ''), 10);
			const nums = texto.match(/\d{4,9}/g);
			if (nums) {
				for (const n of nums) {
					const val = parseInt(n, 10);
					if (val >= 100000 && val <= 50000000) return val;
				}
			}
			return null;
		}

		const precioMencionado = extraerPrecio(message);
		let productoPorPrecio: any = null;
		if (precioMencionado && context?.ultimaBusqueda?.results) {
			productoPorPrecio = context.ultimaBusqueda.results.find((p: any) => {
				const pp = parseFloat(p.price || '0');
				return pp > 0 && Math.abs(pp - precioMencionado) / precioMencionado < 0.1;
			}) || null;
		}

		if (tieneProductos && compraIntencion && context?.flujo !== 'seleccion_pago' && !resetFlujo) {
			const prod = productoPorPrecio || context?.ultimaBusqueda?.results?.[0];
			const productoURL = prod?.permalink || context?.productoURL;
			const nombreProducto = prod?.name || context?.ultimaBusqueda?.categoria || context?.terminoBusqueda || 'producto';
			const ref = prod?.sku ? ` (ref. ${prod.sku})` : '';
			return {
				response: `¡Con gusto! Te ayudo con el pago de ${nombreProducto}${ref} 😊 ¿Cómo prefieres pagar?\n\n1️⃣ Transferencia bancaria\n2️⃣ En la web (PSE, Tarjeta, Nequi)${context?.tieneCobertura ? '\n3️⃣ En un punto físico' : ''}`,
				nextStage: 'PROPOSAL',
				metadata: {
					agentType: 'ventas',
					flujo: 'seleccion_pago',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
					productoURL,
					productoSolicitado: nombreProducto,
					ultimaBusqueda: context?.ultimaBusqueda,
					...datosPersonales,
				},
			};
		}

		// ── Flujo normal de ventas (mostrar productos) ──────────────────────
		const ciudadStr = context?.ciudad ? `En ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
		const envioStr = context?.tieneCobertura
			? 'tienes envío gratis'
			: 'envío por transportadora (el flete se calcula en la web al agregar el producto al carrito)';

		const pideMas = /(?:tienes\s*mas|hay\s*m[áa]s|m[áa]s\s*opciones|otr[oa]s?\s*opciones|quiero\s*ver\s*m[áa]s|mu[ée]strame\s*m[áa]s|busco\s*otr[oa]|alg[úu]n\s*otr[oa]|otr[oa]s?\s*opciones|diferente)/i.test(message);
		const pideMasEconomico = /(?:m[áa]s\s*(?:econ[oó]mic[oa]s?|barat[oa]s?|econ[oó]mic[oa])|algo\s*(?:m[áa]s\s*)?(?:econ[oó]mico|barato)|m[áa]s\s*barato|menos\s*costoso|de\s*menor\s*precio|hay\s*(?:algo\s*)?m[áa]s\s*barat)/i.test(message);

		let products: any[] = [];
		let hayProductos = false;
		let productoIndex = 0;
		let terminoBusqueda = context?.terminoBusqueda || message;

		const STOPWORDS_PRODUCTO = /\s+(?:de|del|la|el|los|las|un|una|unos|unas|por|para|con|que|y|o|en|a|al|JLC|Electronics|marca|modelo|referencia|producto|electrodoméstico|electrodomestico)\b.*/i;
		const busquedaMatch = message.match(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa|info de|informacion de)\s*(?:un[oa]?|unas?|disponible|esta|este|esa|ese)?\s*([a-záéíóúñÁÉÍÓÚÑ][a-záéíóúñÁÉÍÓÚÑ\s]{2,40})/i);
		let productoBuscado: string;
		if (busquedaMatch) {
			productoBuscado = busquedaMatch[1].trim()
				.replace(STOPWORDS_PRODUCTO, '')
				.replace(/\s{2,}/g, ' ')
				.trim();
			if (productoBuscado.length < 3) productoBuscado = terminoBusqueda;
		} else {
			productoBuscado = terminoBusqueda;
		}

		const preguntaSeguimiento = /(?:especificaciones?|caracter[ií]sticas?|detalles?|d[ée]tal|cu[aá]nto cuesta|cu[aá]nto vale|cu[aá]l es|en qu[eé] se diferencia|diferencia|c[oó]mo es|descr[ií]belo|dimensiones|medidas|capacidad|color|modelo|referencia|precio|m[aá]s info|m[aá]s informaci[oó]n|primero|segunda?|tercero|este|ese|aquel|me gusta|prefiero|quiero|detalles|garantia|la primera opci[oó]n|el primero|la primera)/i.test(message) && context?.ultimaBusqueda?.results?.length > 0;

		if (preguntaSeguimiento) {
			// Re-consultar WooCommerce fresco en vez de reusar cache
			try {
				const termino = context?.ultimaBusqueda?.categoria || context?.terminoBusqueda || terminoBusqueda || message;
				const categoriaCtx = context?.ultimaBusqueda?.categoria || detectarCategoria(termino);
				const resultado = await buscarProductoInteligente(termino, categoriaCtx);
				products = resultado.products?.slice(0, 6) || [];
				hayProductos = products.length > 0;
				productoBuscado = context?.ultimaBusqueda?.categoria || context?.terminoBusqueda || 'producto';
			} catch {
				products = context?.ultimaBusqueda?.results?.slice(0, 6) || [];
				hayProductos = products.length > 0;
				productoBuscado = context?.ultimaBusqueda?.categoria || context?.terminoBusqueda || 'producto';
			}
		}

		if (pideMas || pideMasEconomico) {
			const busquedaGuardada = context?.ultimaBusqueda;
			const catBusqueda = busquedaGuardada?.categoria || context?.terminoBusqueda || '';
			
			if (catBusqueda) {
				try {
					const masProductos = await wooCommerceService.searchProducts(catBusqueda, pideMasEconomico ? 40 : 30);
					if (masProductos?.length > 0) {
						products = masProductos;
						if (pideMasEconomico) {
							products = [...products].sort((a: any, b: any) => {
								const pa = parseFloat(a.price || '999999999');
								const pb = parseFloat(b.price || '999999999');
								return pa - pb;
							});
							productoIndex = 0;
						} else {
							productoIndex = (busquedaGuardada?.productoIndex ?? 0) + 1;
						}
						hayProductos = true;
						productoBuscado = catBusqueda;
					}
				} catch { /* fall through */ }
			}
			if (!hayProductos) {
				products = [];
			}
		}

		// ── Tamaños relativos: "el más pequeño", "el más grande", "mediano" ──
		let esTamanoRelativo = false;
		const tamanoRelativo = (() => {
			if (!context?.ultimaBusqueda?.categoria) return null;
			if (/\b(m[áa]s\s*peque[ñn]o|m[áa]s\s*chico|el\s*menor|el\s*m[íi]nimo)\b/i.test(message)) return 'menor';
			if (/\b(m[áa]s\s*grande|m[áa]s\s*capacidad|el\s*mayor|el\s*m[áa]ximo)\b/i.test(message)) return 'mayor';
			if (/\b(mediano|intermedio|un\s*mediano)\b/i.test(message)) return 'mediano';
			return null;
		})();

		if (tamanoRelativo && context?.ultimaBusqueda?.categoria) {
			esTamanoRelativo = true;
			const categoria = context.ultimaBusqueda.categoria;
			try {
				const masProductos = await wooCommerceService.searchProducts(categoria, 30);
				if (masProductos?.length > 1) {
					function extraerCapacidadProducto(p: any): number {
						// Buscar en el nombre: "251L", "254 Litros", "19kg", "50 Pulgadas"
						const nameCap = extraerCapacidad(p.name || '');
						if (nameCap) return nameCap.valor;
						// Buscar en atributos
						if (p.attributes?.length > 0) {
							for (const attr of p.attributes) {
								const val = attr.options?.[0] || '';
								const cap = extraerCapacidad(`${attr.name}: ${val}`);
								if (cap) return cap.valor;
							}
						}
						// Buscar en descripción corta
						if (p.short_description) {
							const cap = extraerCapacidad(p.short_description);
							if (cap) return cap.valor;
						}
						// Fallback a precio
						return parseFloat(p.price || '0') || 0;
					}

					const conCapacidad = masProductos
						.map((p: any) => ({ ...p, _cap: extraerCapacidadProducto(p) }))
						.sort((a: any, b: any) => a._cap - b._cap);

					if (tamanoRelativo === 'menor') {
						products = [conCapacidad[0]];
					} else if (tamanoRelativo === 'mayor') {
						products = [conCapacidad[conCapacidad.length - 1]];
					} else {
						const mid = Math.floor(conCapacidad.length / 2);
						products = [conCapacidad[mid]];
					}
					hayProductos = true;
					productoIndex = 0;
					productoBuscado = products[0]?.name || categoria;
				}
			} catch { /* fall through */ }
		}

		if (!esTamanoRelativo && products.length === 0) {
			// Si el mensaje referencia un producto guardado previamente, ajustar el término
			const productoPrevio = context?.userData?.productoSolicitado || context?.productoSolicitado;
			if (productoPrevio && !productoBuscado.includes(productoPrevio) && productoBuscado === terminoBusqueda && terminoBusqueda === message) {
				productoBuscado = productoPrevio;
				terminoBusqueda = productoPrevio;
			}

			// Siempre consultar WooCommerce fresco (sin reusar cache)
			try {
				const categoriaCtx = context?.ultimaBusqueda?.categoria || detectarCategoria(terminoBusqueda);
				const resultado = await buscarProductoInteligente(message, categoriaCtx);
				products = resultado.products;

				if (resultado.estrategia.startsWith('sku') || resultado.estrategia.startsWith('potencia') || resultado.estrategia.startsWith('categoria_potencia')) {
					terminoBusqueda = resultado.sku || extraerPotencia(message) || terminoBusqueda;
				}

				hayProductos = products?.length > 0;
			} catch {
				// products = []
			}
		}

		function htmlToCleanText(html: string, isPrimary: boolean): string {
			if (!html) return '';
			// Preservar tablas: convertir <tr> en saltos de línea y <td>/<th> en pipe
			let txt = html
				.replace(/<\/tr>/gi, '\n')
				.replace(/<\/td>/gi, ' | ')
				.replace(/<\/th>/gi, ' | ')
				.replace(/<br\s*\/?>/gi, '\n')
				.replace(/<li>/gi, '\n- ')
				.replace(/<\/li>/gi, '')
				.replace(/<\/?(?:ul|ol)>/gi, '\n');
			// Remover el resto de etiquetas HTML
			txt = txt.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
			const maxLen = isPrimary ? 5000 : 1200;
			return txt.length > maxLen ? txt.slice(0, maxLen - 3) + '...' : txt;
		}

		const productListStr = products.length > 0
			? products.slice(0, 6).map((p: any, i: number) => {
				const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar precio';
				const desc = htmlToCleanText(p.description || p.short_description || '', i === 0);
				// Incluir atributos estructurados (dimensiones, capacidad, etc.)
				let attrs = '';
				if (p.attributes?.length > 0) {
					const relevantes = p.attributes.filter((a: any) =>
						a.options?.length && ['alto', 'ancho', 'largo', 'profundidad', 'fondo', 'capacidad', 'peso', 'volumen', 'medidas', 'dimensiones', 'tamaño', 'color', 'material', 'potencia', 'voltaje', 'consumo', 'garantía'].some(k => a.name?.toLowerCase().includes(k.toLowerCase()))
					);
					if (relevantes.length > 0) {
						attrs = '\n   ' + relevantes.map((a: any) => `${a.name}: ${a.options.join(', ')}`).join('\n   ');
					}
				}
				return `${i + 1}. ${p.name} - ${precio}\n   Enlace: ${p.permalink}${desc ? `\n   Detalles: ${desc}` : ''}${attrs}`;
			}).join('\n\n')
			: 'No se encontraron productos.';

		const userDataStr = buildUserDataContext(context?.userData);

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres ${AGENT_NAME}, asesora comercial y experta en electrodomésticos de JLC Electronics Colombia.

Personalidad y Estilo:
- Cálida, cercana y femenina, como una amiga que sabe de electrodomésticos.
- Español colombiano natural y espontáneo, nunca robótico.
- MENSAJES CORTOS: 1-2 frases máximo. Es WhatsApp, no un correo. Ve al grano con calidez.
- MÁXIMO 1 emoji por mensaje (a veces ninguno). No saturar de emojis.
- Da tu opinión y criterio para guiar al cliente, pero breve.
- Género correcto: televisores/ventiladores MASCULINO, neveras/lavadoras FEMENINO.
- Si preguntan quién eres o se despiden, responde con naturalidad y brevedad. No alargues despedidas.

${ciudadStr ? `Ciudad del cliente: ${ciudadStr}.` : ''} ${envioStr ? `Condición de envío: ${envioStr}.` : ''}
${userDataStr}

POLÍTICAS DE LA EMPRESA —debes cumplirlas:
- El precio NO incluye flete. Si preguntan por envío, indica que se calcula al agregar el producto al carrito en la web.
- No menciones entrega en primer piso a menos que el cliente pregunte explícitamente.
- No confirmes despacho si el cliente no ha pagado.
- Si el cliente dice que ya pagó, pídele el comprobante o número de transacción.
- Si el cliente confirma que quiere un producto, ofrécele ayuda con el pago.
- Si preguntan por opciones de pago, no las enumeres; guíalos a pagar en la web.
- Si necesitan ayuda para pagar, ofrécete a escalar al equipo de soporte. NO des ningún número a menos que el cliente insista.
- NUNCA compartas números de cartera (314 422 9949, 315 721 2367) ni correos de facturación, salvo que el cliente PIDA EXPLÍCITAMENTE el contacto de cartera.
- Para seguimiento post-compra (guía de despacho, "ya compré", "cuándo llega", estado del pedido): dile con calidez que ya quedó registrado y que el equipo le confirma el despacho y la guía pronto. NO des números de cartera. Si insiste en un contacto, el caso se escala internamente.
- No digas "generé tu orden". Di que el producto queda reservado pendiente de pago.
- No compartas direcciones de agencias físicas.
- Si el cliente dice "no me gusta esa marca" o algo similar, explícale que todos los electrodomésticos son JLC, marca propia colombiana, y ofrécele mostrarle otros modelos del mismo tipo (nunca sugerir otras marcas ni saltar a pago).
 
REGLAS DE CATÁLOGO:
- Usa el CATÁLOGO de productos para responder. Si hay productos, preséntalos de forma natural (máx 1-2 recomendaciones).
- Si el cliente pregunta detalles/especificaciones de un producto del catálogo, responde usando su información de "Detalles".
- Si el cliente ya identificó un producto (por nombre, número o SKU), concéntrate en ese producto.
- Si no hay productos en el catálogo, dilo con honestidad y pregunta qué busca.
- Si el cliente pide un producto nuevo o diferente, ayúdale con eso.
- Si menciona un SKU o referencia que SÍ está en el catálogo, confírmaselo y dale el enlace.
- Si menciona un SKU o referencia que NO está, dilo naturalmente sin afirmar que "no existe".
- No inventes productos, precios ni disponibilidad.
- No recomiendes productos de otra categoría si no encontraste lo que busca.`,
			ejemplos: [
				{
					cliente: '¿Tienen el parlante JLC-21215 de 500W?',
					asistente: 'Déjame confirmarte disponibilidad y precio de esa referencia, un momentico 😊',
				},
				{
					cliente: 'Busco una nevera',
					asistente: 'Tenemos la Nevera JLC No Frost 251L por $1.399.900. ¿Te interesa o quieres ver más opciones?',
				},
				{
					cliente: '¿Qué métodos de pago aceptan?',
					asistente: 'En la web puedes pagar con PSE, tarjeta o Nequi al finalizar la compra. ¿Te ayudo con el enlace?',
				},
				{
					cliente: 'Ya compré la nevera y pagué el envío. ¿Cuándo llega y me envían la guía?',
					asistente: '¡Qué buena noticia! 🎉 Tu pedido ya quedó registrado; el equipo te confirma el despacho y la guía muy pronto por aquí.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const catalogPrompt = `\n\nCATÁLOGO DE PRODUCTOS:\n${productListStr}\n\n---\nResponde al cliente según las reglas anteriores.`;

		const raw = await generateResponse(user + catalogPrompt, system);
		let response = cleanResponse(raw);
		response = sanitizarNumerosVentas(response);

		return {
			response,
			...(preguntaSeguimiento ? { nextStage: 'PROPOSAL' } : {}),
			metadata: {
				agentType: 'ventas',
				productosEncontrados: hayProductos,
				ciudadValidada: context?.ciudadValidada,
				ciudad: context?.ciudad,
				modalidad: context?.modalidad,
				tieneCobertura: context?.tieneCobertura,
				...(resetFlujo ? { flujo: null } : {}),
				...(productoBuscado.length < 30 && productoBuscado.split(/\s+/).length <= 5 && !/[?¿]/.test(productoBuscado) ? { productoSolicitado: productoBuscado } : {}),
				ultimaBusqueda: products.length > 0
					? { results: products.slice(0, 6), productoIndex, categoria: detectarCategoria(terminoBusqueda) || undefined }
					: undefined,
				...datosPersonales,
			},
		};
	}

	// ── Finalizar: Problema con la página web ──────────────────────────────────
	private async finalizarProblemaWeb(message: string, context: any): Promise<AgentResponse> {
		const pd = context?.problemaWebData || {};
		pd.nombreCliente = context?.userData?.nombre || pd.nombreCliente || '';
		pd.cedulaCliente = context?.userData?.cedula || pd.cedulaCliente || '';
		pd.ciudad = context?.userData?.ciudad || context?.ciudad || pd.ciudad || '';

		const notaJson = JSON.stringify({
			tipo: 'PROBLEMA_WEB',
			fecha: new Date().toISOString(),
			cliente: pd.nombreCliente,
			cedula: pd.cedulaCliente,
			telefono: context?.telefono || '',
			ciudad: pd.ciudad,
			detalle: pd.detalle || message,
			causa: pd.causa || '',
		});

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres Sara, asesora virtual de JLC Electronics Colombia. El cliente reportó un problema con la página web. Datos: ${notaJson}. Instrucción: Responde con un mensaje cálido, empático, en español colombiano femenino. Dile que su reporte ya fue enviado a nuestro equipo especializado y que un asesor se comunicará con él en breve. NO le pidas más datos, NI soluciones técnicas, NI que intente de nuevo. Solo empatía y que será contactado. Usa emojis variados.`,
			ejemplos: [
				{
					cliente: 'No pude pagar, la página no cargó',
					asistente: '¡Ay, qué pena que hayas tenido ese inconveniente! 😟 Ya quedó registrado tu reporte y nuestro equipo especializado va a revisarlo. En breve un asesor se comunicará contigo para ayudarte. ¡Gracias por avisarnos! 💙🙌',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = sanitizarNumerosVentas(cleanResponse(raw));

		return {
			response,
			metadata: {
				agentType: 'ventas',
				flujo: null,
				notificarProblemaWeb: true,
				problemaWebData: pd,
				notaJson,
			},
		};
	}
}