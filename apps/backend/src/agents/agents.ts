import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';
import { sendMessage as sendWA } from '../whatsapp/whatsapp.js';

export interface AgentResponse {
	response: string;
	nextStage?: string;
	shouldTransfer?: boolean;
	metadata?: Record<string, any>;
}

export interface IAgent {
	name: string;
	handle(message: string, context: any): Promise<AgentResponse>;
}

// ─── Helper: formatear historial ─────────────────────────────────────────────

function formatHistory(history: Array<{ direction: string; body: string }>): string {
	if (!history || history.length === 0) return '';
	return history
		.slice(-6)
		.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
		.join('\n');
}

// ─── Limpiador de respuestas de Gemma ────────────────────────────────────────
//
// Gemma escribe TODO su razonamiento en una sola secuencia continua, sin
// saltos de línea claros. Patrones típicos a eliminar:
//   "User Role: ... Draft 1: ... Draft 2: ... Yes. Yes. Yes. <RESPUESTA>"
//   "<RESPUESTA><RESPUESTA>" (duplicación al final)
//
// Estrategia:
//   1. Detectar marcadores de "respuesta final" y quedarse solo con lo
//      posterior al ÚLTIMO marcador.
//   2. Si hay "Draft N:" en el texto, quedarse con lo posterior al ÚLTIMO
//      "Draft N:" detectado.
//   3. Eliminar duplicación al final (cuando el texto se repite consigo mismo).
//   4. Limpiar asteriscos, encabezados y prefijos residuales.

function cleanResponse(raw: string): string {
	if (!raw) return '';
	let text = raw.trim();

	// 1) Quitar bloques de pensamiento explícitos
	text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	text = text.replace(/```[\s\S]*?```/g, '').trim();

	// 2) Cortar después del último marcador de "Draft N:"
	const draftMatches = [...text.matchAll(/draft\s*\d+\s*:?\s*/gi)];
	if (draftMatches.length > 0) {
		const last = draftMatches[draftMatches.length - 1];
		text = text.slice(last.index! + last[0].length).trim();
	}

	// 3) Cortar después del último marcador estilo "Respuesta final:", etc.
	const finalMarkerRe = /(?:respuesta\s*final|final\s*answer|final\s*draft|borrador\s*final|mensaje\s*al\s*cliente|respuesta\s*al\s*cliente|asistente|assistant|output)\s*:\s*/gi;
	const finalMatches = [...text.matchAll(finalMarkerRe)];
	if (finalMatches.length > 0) {
		const last = finalMatches[finalMatches.length - 1];
		text = text.slice(last.index! + last[0].length).trim();
	}

	// 4) Cortar checklists tipo "Brief? Yes. Direct? Yes."
	text = text.replace(
		/((?:[A-ZÁÉÍÓÚÑa-záéíóúñ"][\wáéíóúñÁÉÍÓÚÑ "]*\?\s*(?:Yes|No|Sí|Si)\.?\s*){2,})/gi,
		''
	);
	text = text.replace(
		/^[\s"']*[\wáéíóúñÁÉÍÓÚÑ "':]*\?\s*(?:Yes|No|Sí|Si)\.?\s*/i,
		''
	).trim();

	// 5) Cortar listas de "User Role:", "Client Goal:", etc.
	const labelRe = /(?:^|[\s.])(?:user role|client goal|customer goal|customer's current request|customer current request|context(?:\s+from\s+previous\s+examples)?|reference info|style|i need to know|the customer is interested|the draft|following the examples)\s*:?/gi;
	const labelMatches = [...text.matchAll(labelRe)];
	if (labelMatches.length > 0) {
		const lastLabel = labelMatches[labelMatches.length - 1];
		const afterLabel = text.slice(lastLabel.index! + lastLabel[0].length);
		const endOfLabel = afterLabel.search(/[.!?]\s+[¡¿"]?[A-ZÁÉÍÓÚÑ]/);
		if (endOfLabel >= 0) {
			text = afterLabel.slice(endOfLabel + 1).trim();
		}
	}

	// 6) Quitar prefijos comunes al inicio
	text = text.replace(
		/^\s*(?:asistente|assistant|respuesta|response|output|mensaje al cliente)\s*:\s*/i,
		''
	).trim();

	// 7) Quitar todos los asteriscos
	text = text.replace(/\*+/g, '').trim();

	// 8) Quitar líneas que sean solo encabezados
	const skipLine = [
		/^\s*(user role|client goal|customer goal|reference info|context|style|status|task|role|company data|protocol|constraints|output|customer|cliente|user|asistente|assistant|goal|tone|workflow|catalog|format)\s*:/i,
		/^\s*paso\s*\d+\s*:/i,
		/^\s*step\s*\d+\s*:/i,
		/^\s*[•\-]\s*(friendly|professional|emojis|spanish|max\s*\d+\s*words)/i,
		/^\s*max\s*\d+\s*(words|palabras)/i,
		/^\s*(yes|no|sí|si)\s*\.?\s*$/i,
		/^[\s_=#]{2,}$/,
	];
	text = text
		.split('\n')
		.filter((l) => {
			const t = l.trim();
			if (!t) return true;
			return !skipLine.some((p) => p.test(t));
		})
		.join('\n')
		.trim();

	// 9) Quitar duplicación al final
	const fullDup = text.match(/^([\s\S]+?)\s*\1\s*$/);
	if (fullDup && fullDup[1].length > 30) {
		text = fullDup[1].trim();
	} else {
		text = dedupeTail(text);
	}

	// 9b) Deduplicación por oraciones
	text = dedupeBySentence(text);

	// 10) Compactar espacios
	text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

	return text;
}

function dedupeTail(text: string): string {
	const len = text.length;
	if (len < 60) return text;

	const candidatePositions: number[] = [];
	for (let i = Math.floor(len * 0.3); i < len * 0.7; i++) {
		const ch = text[i];
		const prev = text[i - 1];
		if ((ch === '¡' || ch === '¿') && i > 30) {
			candidatePositions.push(i);
		} else if (
			/[A-ZÁÉÍÓÚÑ]/.test(ch) &&
			/[.!?]/.test(prev || '')
		) {
			candidatePositions.push(i);
		}
	}

	for (const p of candidatePositions) {
		const first = text.slice(0, p).trim();
		const second = text.slice(p).trim();
		if (first.length < 30 || second.length < 30) continue;

		const a = normalizeForCompare(first);
		const b = normalizeForCompare(second);
		const minLen = Math.min(a.length, b.length);
		const maxLen = Math.max(a.length, b.length);
		if (maxLen === 0) continue;

		if (minLen / maxLen > 0.9) {
			let diff = maxLen - minLen;
			for (let i = 0; i < minLen; i++) {
				if (a[i] !== b[i]) diff++;
				if (diff / maxLen > 0.1) break;
			}
			if (diff / maxLen <= 0.1) {
				return first;
			}
		}
	}

	return text;
}

function normalizeForCompare(s: string): string {
	return s
		.toLowerCase()
		.replace(/[¡¿!?,.;:"'()\s]+/g, ' ')
		.trim();
}

function dedupeBySentence(text: string): string {
	if (text.length < 60) return text;

	const parts = text.split(/(?=¡[A-ZÁÉÍÓÚÑ])|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/);
	if (parts.length < 2) return text;

	const mid = Math.floor(parts.length / 2);
	const firstHalf = parts.slice(0, mid).join(' ').trim();
	const secondHalf = parts.slice(mid).join(' ').trim();

	if (firstHalf.length > 30 && secondHalf.length > 30) {
		const a = normalizeForCompare(firstHalf);
		const b = normalizeForCompare(secondHalf);
		const minLen = Math.min(a.length, b.length);
		const maxLen = Math.max(a.length, b.length);
		if (maxLen > 0 && minLen / maxLen > 0.85) {
			let diff = 0;
			for (let i = 0; i < minLen; i++) {
				if (a[i] !== b[i]) diff++;
			}
			diff += maxLen - minLen;
			if (diff / maxLen < 0.1) {
				return firstHalf;
			}
		}
	}

	for (let i = 0; i < parts.length - 1; i++) {
		const a = normalizeForCompare(parts[i]);
		const b = normalizeForCompare(parts[i + 1]);
		if (a.length > 30 && b.length > 30) {
			const minLen = Math.min(a.length, b.length);
			const maxLen = Math.max(a.length, b.length);
			if (minLen / maxLen > 0.85) {
				let diff = Math.abs(a.length - b.length);
				for (let j = 0; j < minLen; j++) {
					if (a[j] !== b[j]) diff++;
				}
				if (diff / maxLen < 0.1) {
					const newParts = [...parts.slice(0, i + 1), ...parts.slice(i + 2)];
					return newParts.join(' ').trim();
				}
			}
		}
	}

	return text;
}

// ─── Constructor de prompt estilo "conversación continua" ────────────────────

interface FewShotExample {
	cliente: string;
	asistente: string;
}

function buildGemmaPrompt(opts: {
	instruccion: string;
	ejemplos: FewShotExample[];
	historial: string;
	mensajeCliente: string;
}): { system: string; user: string } {
	const system = `${opts.instruccion} Responde en español natural, en una o dos frases breves, sin asteriscos, sin encabezados, sin etiquetas, sin explicar tu razonamiento. IMPORTANTE: Responde SOLO el mensaje al cliente leyendo su contexto.`;

	const ejemplosTexto = opts.ejemplos
		.map((e) => `Cliente: ${e.cliente}\nAsistente: ${e.asistente}`)
		.join('\n\n');

	const historialTexto = opts.historial ? `${opts.historial}\n` : '';

	const user = `${ejemplosTexto}\n\n---\n\n${historialTexto}Cliente: ${opts.mensajeCliente}\nAsistente:`;

	return { system, user };
}

// ─── VALIDADOR DE COBERTURA ───────────────────────────────────────────────────
//
// Departamentos con cobertura propia (envío gratis cuando aplica).
// Zonas fuera de esta lista = contado + transportadora Coordinadora a cargo
// del cliente. Fuente: info.md / configuración JLC.
//
// NOTA: mantener esta lista actualizada (mejora #12 del info.md).

const DEPARTAMENTOS_COBERTURA = [
	'nariño', 'narino',
	'cauca',
	'putumayo',
	'huila',
	'valle', 'valle del cauca',
];

// Algunas ciudades/municipios clave para detección rápida por nombre
const CIUDADES_COBERTURA: string[] = [
	// Nariño
	'pasto', 'tumaco', 'ipiales', 'la union', 'la unión', 'samaniego',
	'túquerres', 'tuquerres', 'barbacoas', 'el charco', 'sandoná', 'sandona',
	// Cauca
	'popayán', 'popayan', 'santander de quilichao', 'miranda', 'patía', 'patia',
	'puerto tejada', 'piendamó', 'piendamo', 'el tambo', 'cajibío', 'cajibio',
	// Putumayo
	'mocoa', 'puerto asís', 'puerto asis', 'orito', 'sibundoy', 'valle del guamuez',
	'san miguel', 'villagarzón', 'villagarzon',
	// Huila
	'neiva', 'pitalito', 'garzón', 'garzon', 'la plata', 'campoalegre',
	'rivera', 'palermo', 'gigante', 'isnos', 'san agustín', 'san agustin',
	// Valle del Cauca
	'cali', 'buenaventura', 'palmira', 'tuluá', 'tulua', 'buga',
	'cartago', 'jamundí', 'jamundi', 'yumbo', 'florida', 'pradera',
	'zarzal', 'la victoria', 'roldanillo', 'el cerrito',
];

/**
 * Determina si una ciudad/departamento mencionado tiene cobertura JLC.
 * Retorna: 'cobertura' | 'sin_cobertura' | 'desconocido'
 */
function verificarCobertura(lugar: string): 'cobertura' | 'sin_cobertura' | 'desconocido' {
	if (!lugar) return 'desconocido';
	const l = lugar.toLowerCase().trim();

	if (DEPARTAMENTOS_COBERTURA.some((d) => l.includes(d))) return 'cobertura';
	if (CIUDADES_COBERTURA.some((c) => l.includes(c))) return 'cobertura';

	// Si menciona un lugar pero no está en la lista → sin cobertura propia
	// Si es muy corto o ambiguo → desconocido
	if (l.length > 3) return 'sin_cobertura';
	return 'desconocido';
}

// ─── AGENTE BIENVENIDA ────────────────────────────────────────────────────────
//
// Mejoras aplicadas (info.md):
//  #1  Inicio organizado con menú claro desde el primer mensaje.
//  #13 Lenguaje más natural y cálido.

const AGENT_NAME = 'Sara';

export class BienvenidaAgent implements IAgent {
	name = 'Bienvenida';

	private getSaludo(): string {
		const hora = new Date().getHours();
		if (hora >= 5 && hora < 12) return 'Buenos días';
		if (hora >= 12 && hora < 19) return 'Buenas tardes';
		return 'Buenas noches';
	}

	private tieneIntencionClara(mensaje: string): boolean {
		const keywords = [
			'nevera', 'televisor', 'tv', 'lavadora', 'congelador', 'parlante',
			'precio', 'cotizar', 'cuánto', 'cuanto', 'comprar', 'garantía',
			'garantia', 'técnico', 'tecnico', 'distribuidor', 'trabajo', 'vacante',
			'pago', 'crédito', 'credito', 'envío', 'envio', 'repuesto', 'cartera',
			'cuota', 'deuda',
		];
		const lower = mensaje.toLowerCase();
		return keywords.some((kw) => lower.includes(kw));
	}

	async handle(message: string, _context: any): Promise<AgentResponse> {
		const saludo = this.getSaludo();
		const tieneIntencion = this.tieneIntencionClara(message);

		// Si el usuario ya llegó con una intención clara, bienvenida breve
		if (tieneIntencion) {
			return {
				response: `${saludo} 👋 Soy ${AGENT_NAME}, asistente virtual de JLC Electronics. Con gusto te ayudo con eso.`,
				metadata: {
					agentType: 'bienvenida',
					passthrough: true,
				},
			};
		}

		// Bienvenida completa con menú organizado (mejora #1)
		const menu = `${saludo} 👋 Soy ${AGENT_NAME}, la asistente virtual de JLC Electronics.

¿En qué puedo ayudarte hoy?

1️⃣ Comprar un producto (contado o crédito)
2️⃣ Cartera / estado de cuenta
3️⃣ Servicio técnico o garantía
4️⃣ Repuestos
5️⃣ Medios de pago / pagar una cuota
6️⃣ Distribuidores
7️⃣ Trabaja con nosotros

Escríbeme el número de tu opción o cuéntame directamente lo que necesitas. 😊`;

		return {
			response: menu,
			metadata: { agentType: 'bienvenida', passthrough: false },
		};
	}
}

// ─── TIPOS ───────────────────────────────────────────────────────────────────

interface CreditoData {
	nombres?: string;
	apellidos?: string;
	cedula?: string;
	celular?: string;
	direccion?: string;
	tipoVivienda?: string;
	departamento?: string;
	ciudad?: string;
	personasACargo?: string;
	empresa?: string;
	cargo?: string;
	experienciaLaboral?: string;
	estadoCivil?: string;
	ingresosMensuales?: string;
	gastosMensuales?: string;
	otrosIngresos?: string;
	reportadoDataCredito?: string;
	dispuestoSaldarDeuda?: string;
	producto?: string;
	skuProducto?: string;
}

interface CreditoStep {
	field: keyof CreditoData;
	pregunta: string;
	opciones?: string[];
}

// ─── PASOS DEL FORMULARIO DE CRÉDITO ─────────────────────────────────────────

const CREDITO_STEPS: CreditoStep[] = [
	{ field: 'nombres',            pregunta: '¿Cuál es tu nombre?' },
	{ field: 'apellidos',          pregunta: '¿Y tus apellidos?' },
	{ field: 'cedula',             pregunta: '¿Cuál es tu número de cédula de ciudadanía?' },
	{ field: 'celular',            pregunta: '¿Cuál es tu número de celular?' },
	{ field: 'direccion',          pregunta: '¿Cuál es tu dirección de residencia y barrio?' },
	{
		field: 'tipoVivienda',
		pregunta: '¿Qué tipo de vivienda tienes?\n1. Propia\n2. Arriendo\n3. Anticrés\n4. Familiar',
		opciones: ['Propia', 'Arriendo', 'Anticrés', 'Familiar'],
	},
	{ field: 'departamento',       pregunta: '¿En qué departamento vives?' },
	{ field: 'ciudad',             pregunta: '¿En qué ciudad? Si aplica, escribe también la vereda.' },
	{
		field: 'personasACargo',
		pregunta: '¿Cuántas personas tienes a cargo?\n1. 1\n2. 2\n3. 3\n4. 4\n5. 5 o más',
		opciones: ['1', '2', '3', '4', '5 o más'],
	},
	{ field: 'empresa',            pregunta: '¿En qué empresa trabajas?' },
	{ field: 'cargo',              pregunta: '¿Qué cargo desempeñas? Si eres independiente, describe tu actividad comercial.' },
	{ field: 'experienciaLaboral', pregunta: '¿Cuánto tiempo llevas en esa empresa o actividad?' },
	{
		field: 'estadoCivil',
		pregunta: '¿Cuál es tu estado civil?\n1. Soltero/a\n2. Casado/a\n3. Unión libre\n4. Viudo/a',
		opciones: ['Soltero/a', 'Casado/a', 'Unión libre', 'Viudo/a'],
	},
	{ field: 'ingresosMensuales',  pregunta: '¿Cuáles son tus ingresos mensuales? (valor aproximado en pesos)' },
	{ field: 'gastosMensuales',    pregunta: '¿Cuáles son tus gastos mensuales? (valor aproximado en pesos)' },
	{ field: 'otrosIngresos',      pregunta: '¿Tienes otros ingresos? Si es así, especifica la fuente. Si no, escribe "No".' },
	{
		field: 'reportadoDataCredito',
		pregunta: '¿Te encuentras reportado en DataCrédito?\n1. Sí\n2. No\n3. No sé',
		opciones: ['Sí', 'No', 'No sé'],
	},
	{
		field: 'dispuestoSaldarDeuda',
		pregunta: '¿Estarías dispuesto/a a saldar tu deuda con la empresa que te reportó para aspirar a un nuevo crédito?\n1. Sí\n2. No',
		opciones: ['Sí', 'No'],
	},
	{ field: 'producto',           pregunta: '¿Qué producto te interesa financiar?' },
	{ field: 'skuProducto',        pregunta: 'Por último, ¿cuál es el código SKU o referencia del producto? Lo encuentras debajo del título en la página. Si no lo tienes, escribe "No sé".' },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function resolverOpcion(respuesta: string, opciones: string[]): string {
	const r = respuesta.trim();
	const porNumero = parseInt(r, 10);
	if (!isNaN(porNumero) && porNumero >= 1 && porNumero <= opciones.length) {
		return opciones[porNumero - 1];
	}
	const porTexto = opciones.find((o) =>
		o.toLowerCase().includes(r.toLowerCase())
	);
	return porTexto ?? r;
}

function formatearResumenCredito(data: CreditoData): string {
	return `
🟦 SOLICITUD DE CRÉDITO - JLC Electronics

👤 Datos personales
- Nombre: ${data.nombres} ${data.apellidos}
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
- Reportado en DataCrédito: ${data.reportadoDataCredito}
- Dispuesto a saldar deuda: ${data.dispuestoSaldarDeuda}

🛒 Producto de interés
- Producto: ${data.producto}
- SKU / Referencia: ${data.skuProducto}
`.trim();
}

async function enviarResumenWhatsApp(resumen: string): Promise<void> {
	const WHATSAPP_CARTERA = process.env.WA_CARTERA || '573007215438';
	await sendWA(WHATSAPP_CARTERA, resumen);
}

// ─── AGENTE VENTAS ────────────────────────────────────────────────────────────
//
// Mejoras aplicadas (info.md):
//  #2  Validación de cobertura obligatoria antes de cotizar.
//  #3  Si no hay cobertura → solo contado + Coordinadora, cliente decide si sigue.
//  #4  Flujo ordenado: ciudad → cobertura → contado/crédito → producto.
//  #5  En crédito: solo perfilar producto (pulgadas/litros/kilos) y transferir.
//  #6  Precio de contado SOLO si el cliente elige contado o lo pide expresamente.
//  #7  En crédito, la IA se retira tras identificar el producto.
//  #8  No se comparten datos de agencias; el asesor humano los da después.

export class VentasAgent implements IAgent {
	name = 'Ventas';

	// ── Formato de productos para el LLM ──────────────────────────────────────
	private formatProductosParaPrompt(products: any[], mostrarPrecio: boolean): string {
		if (!products?.length) return 'No se encontraron productos relacionados.';
		return products
			.map((p, i) => {
				// Mejora #6: precio solo si corresponde
				const precioStr = mostrarPrecio
					? (p.sale_price
						? `Precio: ~~$${Number(p.regular_price).toLocaleString('es-CO')}~~ → $${Number(p.sale_price).toLocaleString('es-CO')} (en oferta)`
						: `Precio: $${Number(p.price).toLocaleString('es-CO')}`)
					: '';
				return `${i + 1}. ${p.name}${precioStr ? '\n   ' + precioStr : ''}\n   Ver producto: ${p.permalink}`;
			})
			.join('\n\n');
	}

	// ── Flujo de crédito paso a paso ──────────────────────────────────────────
	private async manejarFlujoCredito(
		message: string,
		context: any
	): Promise<AgentResponse> {
		const creditoData: CreditoData = context?.creditoData ?? {};
		const stepIndex: number = context?.creditoStep ?? 0;

		if (stepIndex > 0) {
			const stepAnterior = CREDITO_STEPS[stepIndex - 1];
			const valor = stepAnterior.opciones
				? resolverOpcion(message, stepAnterior.opciones)
				: message.trim();
			creditoData[stepAnterior.field] = valor;
		}

		const camposFaltantes = CREDITO_STEPS.filter((s) => !creditoData[s.field]);

		if (camposFaltantes.length > 0) {
			const siguientePaso = camposFaltantes[0];
			const indexReal = CREDITO_STEPS.findIndex(
				(s) => s.field === siguientePaso.field
			);

			return {
				response: siguientePaso.pregunta,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					creditoData,
					creditoStep: indexReal + 1,
				},
			};
		}

		// Todos los campos completos → enviar resumen y TRANSFERIR (mejora #7)
		const resumen = formatearResumenCredito(creditoData);

		try {
			await enviarResumenWhatsApp(resumen);
		} catch {
			console.error('Error enviando resumen de crédito por WhatsApp');
		}

		return {
			response: `¡Listo! 🎉 Tu solicitud fue enviada a nuestro equipo comercial. Un asesor se comunicará contigo pronto para continuar el proceso de crédito. Si tienes preguntas urgentes, puedes escribir al WhatsApp +57 318 740 8190.`,
			nextStage: 'TRANSFER',
			shouldTransfer: true,
			metadata: {
				agentType: 'ventas',
				flujo: 'credito_completado',
				creditoData,
			},
		};
	}

	// ── Flujo sin cobertura ───────────────────────────────────────────────────
	// Mejora #3: informar condiciones y preguntar si desea continuar
	private manejarSinCobertura(ciudad: string): AgentResponse {
		return {
			response: `Revisé tu ubicación (${ciudad}) y en este momento no tenemos cobertura con envío directo en esa zona.\n\nSin embargo, puedes comprar de *contado* y el envío se hace por transportadora *Coordinadora* (el flete corre por tu cuenta).\n\n¿Deseas continuar con esa modalidad? Responde *Sí* para seguir o *No* si prefieres esperar a que lleguemos a tu ciudad. 😊`,
			metadata: {
				agentType: 'ventas',
				flujo: 'sin_cobertura',
				ciudad,
			},
		};
	}

	// ── Handle principal ──────────────────────────────────────────────────────
	async handle(message: string, context: any): Promise<AgentResponse> {
		const lower = message.toLowerCase().trim();

		// ── Flujo de crédito activo ────────────────────────────────────────────
		if (context?.flujo === 'credito') {
			return this.manejarFlujoCredito(message, context);
		}

		// ── Cliente decidió NO continuar sin cobertura (mejora #3) ────────────
		if (context?.flujo === 'sin_cobertura') {
			const noQuiere = /\bno\b|no gracias|no quiero|no por ahora|prefiero no/i.test(lower);
			if (noQuiere) {
				return {
					response: `Entendido, no hay problema. Cuando JLC tenga cobertura en tu ciudad te podremos atender con todas las opciones. ¡Hasta pronto! 😊`,
					nextStage: 'OTRAS_CIUDADES',
					metadata: { agentType: 'ventas', flujo: 'otras_ciudades', ciudad: context.ciudad },
				};
			}
			// Sí quiere continuar → clasificar como contado sin cobertura
			// Continúa al flujo normal pero forzando modalidad contado
			context = { ...context, flujo: 'contado_sin_cobertura', modalidad: 'contado' };
		}

		// ── PASO 1: Validar cobertura si aún no se hizo (mejoras #2 y #4) ─────
		if (!context?.ciudadValidada) {
			// Intentar extraer ciudad del mensaje actual
			const ciudadDetectada = extraerCiudadDelMensaje(message);

			if (!ciudadDetectada) {
				// No se detectó ciudad → preguntar
				return {
					response: `Para poder ayudarte mejor, ¿desde qué ciudad o municipio nos escribes? 📍`,
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_ciudad',
						pendingMessage: message,
					},
				};
			}

			const cobertura = verificarCobertura(ciudadDetectada);

			if (cobertura === 'sin_cobertura') {
				return this.manejarSinCobertura(ciudadDetectada);
			}

			// Con cobertura o zona desconocida → marcar ciudad como validada
			context = {
				...context,
				ciudadValidada: true,
				ciudad: ciudadDetectada,
				tieneCobertura: cobertura === 'cobertura',
			};
		}

		// ── PASO 2: Si está esperando confirmación de ciudad ──────────────────
		if (context?.flujo === 'esperando_ciudad') {
			const ciudadDetectada = extraerCiudadDelMensaje(message) || message.trim();
			const cobertura = verificarCobertura(ciudadDetectada);

			if (cobertura === 'sin_cobertura') {
				return this.manejarSinCobertura(ciudadDetectada);
			}

			context = {
				...context,
				ciudadValidada: true,
				ciudad: ciudadDetectada,
				tieneCobertura: true,
				flujo: undefined,
			};

			// Retomar el mensaje original pendiente si existe
			if (context.pendingMessage) {
				message = context.pendingMessage;
			}
		}

		// ── PASO 3: Detectar modalidad contado o crédito (mejora #5 y #6) ─────
		const quiereCredito = /cr[eé]dito|a cr[eé]dito|financiar|financiaci[oó]n|cuotas|pagar a cuotas/i.test(message);
		const quiereContado = /contado|efectivo|pago inmediato|precio de contado|cu[aá]nto vale|cu[aá]nto cuesta|precio/i.test(message);

		// Mejora #5 y #7: crédito → solo perfilar producto y transferir
		if (quiereCredito || context?.modalidad === 'credito') {
			// Detectar si ya se identificó el producto
			const productoIdentificado = context?.productoCredito;

			if (!productoIdentificado) {
				// Perfilar el producto (pulgadas, litros, kilos según tipo)
				const perfilProducto = generarPreguntaPerfilProducto(message);

				if (perfilProducto) {
					return {
						response: perfilProducto,
						metadata: {
							agentType: 'ventas',
							flujo: 'credito_perfilando',
							modalidad: 'credito',
							ciudadValidada: context?.ciudadValidada,
							ciudad: context?.ciudad,
						},
					};
				}
			}

			// Producto ya identificado o no se pudo perfilar más → iniciar formulario
			return {
				response: `Perfecto, te ayudo con el proceso de crédito 📋\n\nVoy a hacerte unas preguntas para diligenciar tu solicitud. Son ${CREDITO_STEPS.length} campos en total, uno por uno.\n\n${CREDITO_STEPS[0].pregunta}`,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					modalidad: 'credito',
					creditoData: context?.productoCredito ? { producto: context.productoCredito } : {},
					creditoStep: context?.productoCredito ? 1 : 1,
					ciudadValidada: context?.ciudadValidada,
					ciudad: context?.ciudad,
				},
			};
		}

		// ── Flujo normal de ventas (contado) ───────────────────────────────────
		// Mejora #6: mostrar precio solo si es flujo de contado
		const mostrarPrecio = quiereContado || context?.modalidad === 'contado';

		let productosFormateados = '';
		let hayProductos = false;

		try {
			const products = await wooCommerceService.searchProducts(message, 4);
			hayProductos = products?.length > 0;
			productosFormateados = hayProductos
				? this.formatProductosParaPrompt(products, mostrarPrecio)
				: 'No se encontraron productos que coincidan con la búsqueda.';
		} catch {
			productosFormateados = 'No fue posible consultar el catálogo en este momento.';
		}

		// Mejora #8: NO incluir datos de agencias en la respuesta
		const instruccion = `Eres ${AGENT_NAME}, asesora comercial de JLC Electronics.
Tu tono es cálido, claro y directo. Hablas en español colombiano. Tus respuestas son cortas (máximo 3 líneas).

REGLAS:
- Si hay productos en el CATÁLOGO, menciona al menos uno con nombre y enlace.
- No inventes productos ni precios. Solo usa los del CATÁLOGO.
- ${mostrarPrecio ? 'Puedes mostrar el precio de los productos.' : 'NO muestres precios; el cliente no ha indicado que quiere comprar de contado.'}
- Si no hay productos coincidentes, dirige al sitio web https://jlc-electronics.com/ o a Cristina al +57 318 740 8190.
- Si el cliente menciona crédito o cuotas, indícale que iniciarás el proceso de solicitud.
- NO compartas números, direcciones ni datos de agencias físicas. Eso lo hace el asesor humano.
- La ciudad del cliente ya fue validada: ${context?.ciudad || 'no especificada'}. ${context?.tieneCobertura ? 'Tiene cobertura con envío gratis.' : 'Compra de contado, envío por Coordinadora a su cargo.'}

MEDIOS DE COMPRA:
- Contado o crédito (detal).
- Por mayor: área de distribuidores.
- Sitio web: https://jlc-electronics.com/

CATÁLOGO PARA ESTE MENSAJE:
${productosFormateados}`;

		const { system, user } = buildGemmaPrompt({
			instruccion,
			ejemplos: [
				{
					cliente: 'Quiero una nevera',
					asistente: '¡Con gusto! ¿La compra sería al contado o a crédito?',
				},
				{
					cliente: 'Quiero pagar a crédito',
					asistente: 'Perfecto, te ayudo con el proceso. ¿Qué tipo de nevera buscas? Así identificamos la referencia antes de iniciar la solicitud.',
				},
				{
					cliente: '¿Tienen neveras de 300 litros?',
					asistente: 'Sí, tenemos opciones disponibles. ¿La compra sería al contado o a crédito para mostrarte las que aplican?',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			nextStage: 'PROPOSAL',
			metadata: {
				agentType: 'ventas',
				productosEncontrados: hayProductos,
				ciudadValidada: context?.ciudadValidada,
				ciudad: context?.ciudad,
			},
		};
	}
}

// ─── Helper: extraer ciudad de un mensaje ────────────────────────────────────

function extraerCiudadDelMensaje(mensaje: string): string | null {
	const lower = mensaje.toLowerCase();

	// Patrones: "soy de X", "estoy en X", "vivo en X", "escribo desde X", "ciudad: X"
	const patronesPrefijo = [
		/(?:soy de|estoy en|vivo en|escribo desde|desde|ciudad[:\s]+|ubicado en|me encuentro en)\s+([a-záéíóúñ\s]{3,30})/i,
	];

	for (const patron of patronesPrefijo) {
		const match = mensaje.match(patron);
		if (match) {
			return match[1].trim().toLowerCase();
		}
	}

	// Buscar directamente si el mensaje ES una ciudad (respuesta corta)
	const trimmed = lower.trim().replace(/[.,!?]+$/, '');
	if (trimmed.length > 2 && trimmed.length < 30 && !/\s{2,}/.test(trimmed)) {
		// Es posible que sea solo el nombre de la ciudad
		const allCities = [...CIUDADES_COBERTURA, ...DEPARTAMENTOS_COBERTURA];
		const exactMatch = allCities.find((c) => trimmed.includes(c) || c.includes(trimmed));
		if (exactMatch) return trimmed;

		// Si es una respuesta de 1-3 palabras a "¿de qué ciudad eres?", asumir que es ciudad
		const words = trimmed.split(/\s+/);
		if (words.length <= 3 && words.every((w) => /^[a-záéíóúñ]+$/i.test(w))) {
			return trimmed;
		}
	}

	return null;
}

// ─── Helper: pregunta de perfilamiento para crédito (mejora #5) ───────────────

function generarPreguntaPerfilProducto(mensaje: string): string | null {
	const lower = mensaje.toLowerCase();

	if (/televisor|tv\b|tele\b|pantalla/i.test(lower)) {
		return '¿De cuántas pulgadas necesitas el televisor? (ej: 32", 43", 55")';
	}
	if (/nevera|refrigerador|ref[eé]r|congelador/i.test(lower)) {
		return '¿De cuántos litros necesitas la nevera? (ej: 250 lt, 300 lt, 400 lt)';
	}
	if (/lavadora/i.test(lower)) {
		return '¿De cuántos kilos necesitas la lavadora? (ej: 8 kg, 10 kg, 14 kg)';
	}
	if (/estufa|cocina/i.test(lower)) {
		return '¿La estufa sería a gas, eléctrica o mixta?';
	}
	if (/aire|a\/c|acondicionado/i.test(lower)) {
		return '¿Para cuántos metros cuadrados necesitas el aire acondicionado?';
	}
	if (/microondas/i.test(lower)) {
		return '¿De cuántos litros o watts necesitas el microondas?';
	}

	// Producto no identificado aún
	return '¿Qué producto te interesa financiar? (ej: nevera, lavadora, televisor...)';
}

// ─── AGENTE CARTERA ──────────────────────────────────────────────────────────
//
// Mejora #9: entregar directamente los canales reales, sin prometer que
// "un asesor se comunicará" (lo cual genera falsas expectativas).

export class CarteraAgent implements IAgent {
	name = 'Cartera';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const datos = `Canales oficiales de cartera y facturación:
- WhatsApp cartera: +57 314 422 9949 y +57 315 721 2367
- Línea telefónica: +57 320 788 1108 (horario: 12:30 p.m. a 2:30 p.m., lunes a viernes)
- Correo peticiones con soportes: callcenter5@electromillonaria.co
Desde este chat no se puede acceder a información personal del cliente.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de cartera de Electrodomésticos JLC. Tu rol es dar directamente los canales oficiales para que el cliente resuelva su consulta de forma inmediata. No prometas que "un asesor te llamará". Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Cuánto debo de mi crédito?',
					asistente:
						'Desde este chat no puedo acceder a tu información personal. Comunícate directamente con cartera por WhatsApp al +57 314 422 9949 o +57 315 721 2367 y te dan el detalle al instante.',
				},
				{
					cliente: 'Ya pagué la cuota, ¿dónde envío el soporte?',
					asistente:
						'Envía tu soporte de pago al WhatsApp de cartera: +57 314 422 9949 o +57 315 721 2367. Si tienes una petición formal, puedes escribir a callcenter5@electromillonaria.co.',
				},
				{
					cliente: 'Estoy atrasado, no puedo pagar este mes',
					asistente:
						'Entiendo la situación. Escribe al WhatsApp de cartera +57 314 422 9949 o llama al +57 320 788 1108 entre 12:30 y 2:30 p.m. para revisar opciones de reestructuración.',
				},
				{
					cliente: 'Quiero una paz y salvo',
					asistente:
						'Para solicitar tu paz y salvo, escribe al correo callcenter5@electromillonaria.co o al WhatsApp +57 314 422 9949 con tu número de cédula y ellos te lo envían.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'cartera' },
		};
	}
}

// ─── AGENTE SERVICIO TÉCNICO ─────────────────────────────────────────────────
//
// Mejora #10: entregar automáticamente líneas de atención y WhatsApp según
// la marca del electrodoméstico. No dejar al cliente sin respuesta.

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const datos = `Canales de servicio técnico JLC:
- WhatsApp técnico: +57 320 788 1151
- WhatsApp técnico (Diego): +57 320 788 1110
- Web: https://jlc-electronics.com/servicio-tecnico/
- Horario: lunes a sábado, 8:00 a.m. a 5:00 p.m.
Para garantías, el cliente debe tener factura de compra y el producto en buen estado externo.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de servicio técnico de Electrodomésticos JLC. Atiendes clientes con electrodomésticos dañados o que necesitan mantenimiento. Debes SIEMPRE dar los canales de contacto al final de tu respuesta para que el cliente pueda agendar. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: 'Mi lavadora no centrifuga',
					asistente:
						'Lamento la falla. Para agendar la revisión escribe al WhatsApp +57 320 788 1151 (lunes a sábado, 8 a.m. a 5 p.m.). ¿Me indicas marca y modelo para orientarte mejor?',
				},
				{
					cliente: 'Necesito mantenimiento para mi nevera JLC',
					asistente:
						'¡Con gusto! Escribe al WhatsApp +57 320 788 1151 o +57 320 788 1110 (Diego) para agendar el mantenimiento. Atienden lunes a sábado de 8 a.m. a 5 p.m.',
				},
				{
					cliente: 'Tengo una nevera en garantía que no enfría',
					asistente:
						'Para tramitar la garantía necesitarás la factura de compra y el equipo en buen estado externo. Escribe al WhatsApp +57 320 788 1151 y el técnico te indica los pasos.',
				},
				{
					cliente: '¿Cuánto cobra el técnico por visita?',
					asistente:
						'El costo de la visita lo confirma directamente el técnico según la zona y el tipo de equipo. Escríbele al +57 320 788 1151 (lunes a sábado, 8 a.m. a 5 p.m.) para que te cotice.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'servicio_tecnico' },
		};
	}
}

// ─── AGENTE REPUESTOS ─────────────────────────────────────────────────────────
//
// Mejora comentario original: recolectar datos completos antes de responder
// (repuesto solicitado, referencia del producto, foto, nombre y cédula).

export class RepuestosAgent implements IAgent {
	name = 'Repuestos';

	async handle(message: string, context: any): Promise<AgentResponse> {
		// Flujo de recolección de datos para repuesto
		const repuestoData = context?.repuestoData ?? {};

		// Paso 1: nombre del repuesto / qué necesita
		if (!repuestoData.repuesto) {
			// Si el mensaje ya describe el repuesto, guardarlo
			if (message.length > 5 && !/^(hola|buenas|si|no|ok|claro)/i.test(message)) {
				repuestoData.repuesto = message.trim();
			} else {
				return {
					response: '¿Qué repuesto o pieza necesitas? Descríbelo lo mejor posible (ej: "filtro de agua nevera JLC", "empaque puerta lavadora").',
					metadata: { agentType: 'repuestos', flujo: 'repuestos', repuestoData },
				};
			}
		}

		// Paso 2: referencia o modelo del producto
		if (!repuestoData.referencia) {
			if (context?.flujo === 'repuestos' && repuestoData.repuesto && message !== repuestoData.repuesto) {
				repuestoData.referencia = message.trim();
			} else {
				return {
					response: `Gracias. ¿Cuál es la marca, modelo o referencia del electrodoméstico? (La encuentras en la placa trasera del equipo).`,
					metadata: { agentType: 'repuestos', flujo: 'repuestos', repuestoData },
				};
			}
		}

		// Paso 3: nombre y cédula del solicitante
		if (!repuestoData.nombreCliente) {
			if (context?.flujo === 'repuestos' && repuestoData.referencia && message !== repuestoData.referencia) {
				repuestoData.nombreCliente = message.trim();
			} else {
				return {
					response: `¿Cuál es tu nombre completo y número de cédula? (Necesarios para registrar tu solicitud).`,
					metadata: { agentType: 'repuestos', flujo: 'repuestos', repuestoData },
				};
			}
		}

		// Todos los datos básicos recolectados → buscar en WooCommerce y responder
		let productInfo = '';
		try {
			const products = await wooCommerceService.searchProducts(
				`${repuestoData.repuesto} ${repuestoData.referencia} repuesto`,
				3
			);
			if (products.length > 0) {
				productInfo = wooCommerceService.formatProductList(products);
			}
		} catch {
			// continuar sin catálogo
		}

		const datos = `Repuesto solicitado: "${repuestoData.repuesto}". Referencia equipo: "${repuestoData.referencia}". Solicitante: ${repuestoData.nombreCliente}.
Sin stock: tiempo de pedido 3 a 5 días hábiles. Web: https://jlc-electronics.com/.${productInfo ? ` Repuestos encontrados: ${productInfo}` : ' No se encontraron repuestos en catálogo en este momento.'}
Instrucción: indica al cliente que su solicitud fue registrada y que será respondida para confirmar disponibilidad y precio. Si hay repuestos en catálogo, mencionarlos. Pedirle que envíe foto del equipo si puede para confirmar la referencia exacta.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de repuestos de Electrodomésticos JLC. ${datos}`,
			ejemplos: [
				{
					cliente: 'Necesito un empaque para nevera JLC modelo JLC-325',
					asistente:
						'¡Gracias! Tu solicitud quedó registrada. En un momento revisamos disponibilidad y precio del empaque para la JLC-325 y te confirmamos. Si puedes, envíanos una foto de la puerta de la nevera para confirmar la medida exacta.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: {
				agentType: 'repuestos',
				flujo: 'repuestos_completado',
				repuestoData,
			},
		};
	}
}

// ─── AGENTE VACANTES ─────────────────────────────────────────────────────────

export class VacantesAgent implements IAgent {
	name = 'Vacantes';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const datos = `No hay listado de vacantes cargado actualmente. El interesado deja sus datos para quedar en base de datos: nombre completo, cargo de interés, ciudad. Puede enviar hoja de vida.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de recursos humanos de Electrodomésticos JLC. Atiendes a personas interesadas en trabajar en la empresa. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Tienen vacantes?',
					asistente:
						'¡Gracias por tu interés en trabajar con nosotros! En este momento no tengo el listado de vacantes disponible, pero puedo registrar tu perfil. ¿Me compartes tu nombre completo, el cargo de interés y tu ciudad?',
				},
				{
					cliente: 'Soy Carlos Pérez, busco asesor comercial en Cali',
					asistente:
						'¡Excelente, Carlos! Quedas registrado en nuestra base de datos. Si quieres, envía tu hoja de vida para adjuntarla a tu perfil y que RRHH te contacte cuando haya una vacante de asesor comercial en Cali.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'vacantes' },
		};
	}
}

// ─── AGENTE DISTRIBUIDORES ───────────────────────────────────────────────────

export class DistribuidoresAgent implements IAgent {
	name = 'Distribuidores';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const datos = `Datos a recolectar paso a paso: 1. NIT, 2. Nombre o razón social, 3. Teléfono, 4. Correo, 5. Rango de ventas estimado, 6. Departamento, 7. Ciudad. Pedir uno o dos por mensaje, no todos de golpe.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente del programa de distribuidores de Electrodomésticos JLC. Atiendes a interesados en ser distribuidores autorizados. Recolecta los datos de forma amable, de a poco. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: 'Quiero ser distribuidor',
					asistente:
						'¡Bienvenido al programa de distribuidores JLC! Para iniciar el registro, ¿me compartes tu nombre o razón social y la ciudad donde operarías?',
				},
				{
					cliente: 'Soy Comercial XYZ SAS, en Medellín',
					asistente:
						'¡Excelente! Ahora, ¿me indicas tu NIT y un número de contacto?',
				},
				{
					cliente: 'NIT 901234567, teléfono 3001234567',
					asistente:
						'¡Perfecto! Por último, ¿cuál es tu correo electrónico y un rango aproximado de ventas mensuales? Con esto completamos tu solicitud.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'distribuidores' },
		};
	}
}

// ─── AGENTE MEDIOS DE PAGO ───────────────────────────────────────────────────
//
// Mejora #11: entregar automáticamente convenios, cuentas bancarias,
// medios de recaudo y líneas para envío de soportes.

export class PagosAgent implements IAgent {
	name = 'Medios de Pago';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const datos = `Medios de pago JLC Electronics:
1) En línea en https://jlc-electronics.com/ con PSE, tarjeta de crédito o débito.
2) En punto físico (el asesor indica la tienda más cercana según ciudad).
3) Crédito / cuotas: gestionado por Cristina al WhatsApp +57 318 740 8190.
4) Para envío de soportes de pago: WhatsApp cartera +57 314 422 9949 o +57 315 721 2367.
5) Correo para soporte de pago y facturación: callcenter5@electromillonaria.co.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de medios de pago de Electrodomésticos JLC. Entrega SIEMPRE la información concreta de cómo pagar según lo que pide el cliente. No digas "un asesor te contactará"; da los datos directamente. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Cómo puedo pagar?',
					asistente:
						'Tienes dos opciones rápidas: 1) En línea en https://jlc-electronics.com/ con PSE, tarjeta de crédito o débito. 2) En punto físico. ¿Cuál prefieres o desde qué ciudad escribes?',
				},
				{
					cliente: '¿Aceptan tarjeta de crédito?',
					asistente:
						'¡Sí! Al pagar en https://jlc-electronics.com/ puedes usar tarjeta de crédito, débito o PSE. ¿Ya tienes el producto seleccionado?',
				},
				{
					cliente: 'Quiero pagar a crédito',
					asistente:
						'El crédito lo gestiona Cristina. Escríbele al WhatsApp +57 318 740 8190 con el producto que te interesa y ella te guía paso a paso.',
				},
				{
					cliente: '¿A dónde mando el soporte de pago?',
					asistente:
						'Envía tu soporte de pago al WhatsApp de cartera: +57 314 422 9949 o +57 315 721 2367, o al correo callcenter5@electromillonaria.co.',
				},
				{
					cliente: '¿Tienen convenio con Efecty o Baloto?',
					asistente:
						'En este momento los medios habilitados son PSE, tarjeta de crédito/débito en línea y pago en punto físico. Para confirmar convenios adicionales, consulta directamente en https://jlc-electronics.com/ o escribe a Cristina al +57 318 740 8190.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'pagos' },
		};
	}
}