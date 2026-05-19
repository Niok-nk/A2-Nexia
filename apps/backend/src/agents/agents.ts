import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';

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

// ─── Helper para formatear historial ────────────────────────────────────────

function formatHistory(history: Array<{ direction: string; body: string }>): string {
	if (!history || history.length === 0) return 'Sin historial previo.';
	return history
		.slice(-6) // Solo últimos 6 mensajes para no saturar el contexto
		.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
		.join('\n');
}

// ─── Helper para limpiar respuesta de razonamiento interno ─────────────────
function cleanResponse(response: string): string {
	// Eliminar TODAS las líneas que contengan patrones de razonamiento
	const lines = response.split('\n');
	const cleanLines: string[] = [];

	const skipPatterns = [
		/User Message:/i,
		/Goal:/i,
		/Tone:/i,
		/Constraints:/i,
		/Greet/i,
		/Introduce/i,
		/Since the catalog/i,
		/Friendly \?/i,
		/Professional \?/i,
		/Emojis \?/i,
		/Spanish \?/i,
		/Max \d+ words/i,
		/No markers/i,
		/Call to action/i,
		/Constraint Check/i,
		/Customer Input/i,
		/Context\/History/i,
		/Self-Correction/i,
		/Role:/i,
		/Catalog:/i,
		/Workflow:/i,
		/\* [A-Z][a-z]/,
		/^\*+$/,
	];

	for (const line of lines) {
		const trimmed = line.trim();
		
		// Saltar líneas que son solo asteriscos
		if (/^\*+$/.test(trimmed) || /^\*[\s\*]*$/.test(trimmed)) {
			continue;
		}
		
		// Saltar líneas que son solo "Yes" o "No"
		if (trimmed === 'Yes' || trimmed === 'No' || trimmed === 'yes' || trimmed === 'no') {
			continue;
		}
		
		// Saltar líneas que coinciden con los patrones de razonamiento
		const shouldSkip = skipPatterns.some(p => p.test(trimmed));
		if (shouldSkip) {
			continue;
		}
		
		// Saltar líneas muy cortas que probablemente son parte del razonamiento
		if (trimmed.length > 0 && trimmed.length < 20 && !trimmed.match(/^[¡¿]/)) {
			// Pero mantener si contiene emojis
			if (!trimmed.match(/[\u{1F300}-\u{1F9FF}]/u)) {
				continue;
			}
		}
		
		cleanLines.push(line);
	}

	// Unir las líneas limpias
	let cleaned = cleanLines.join(' ').replace(/\s+/g, ' ').trim();

	// Si quedó muy corto, devolver original
	if (cleaned.length < 30) {
		return response;
	}

	return cleaned;
}

// ─── AGENTE VENTAS ───────────────────────────────────────────────────────────

export class VentasAgent implements IAgent {
	name = 'Ventas';

	async handle(message: string, context: any): Promise<AgentResponse> {
		// Buscar productos relevantes en WooCommerce / catálogo mock
		let productList = '';
		try {
			const products = await wooCommerceService.searchProducts(message, 4);
			productList = wooCommerceService.formatProductList(products);
		} catch {
			productList = 'Catálogo no disponible en este momento.';
		}

const systemPrompt = `Eres un asesor comercial de Electrodomesticos JLC. Reglas OBLIGATORIAS:

1. RESPUESTA CORTA: Máximo 80 palabras. Sé conciso.
2. SIN PENSAMIENTO: No muestres tu razonamiento, pasos, ni asteriscos. Solo responde al cliente directamente.
3. CRÉDITO: Pide nombre, cédula e ingresos mensuales.
4. CONTADO: Da precio y disponibilidad.
5. FINALIZA: Termina con una pregunta o llamada a la acción breve.

NO TE DESVIES DE ESTAS REGLAS.ENVÍA SOLO LA RESPUESTA FINAL.`;

		const response = cleanResponse(await generateResponse(
			`HISTORIAL:\n${formatHistory(context?.history)}\n\nMENSAJE DEL CLIENTE: ${message}`,
			systemPrompt
		));

		return {
			response,
			nextStage: 'PROPOSAL',
			metadata: { agentType: 'ventas' },
		};
	}
}

// ─── AGENTE CARTERA ──────────────────────────────────────────────────────────

export class CarteraAgent implements IAgent {
	name = 'Cartera';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres agente de cartera. Reglas OBLIGATORIAS:

1. Máximo 60 palabras.
2. No muestres razonamiento interno, asteriscos ni guiones bajos.
3. Informa opciones de pago: efectivo, transferencia, PSE, datacrédito.
4. Si tiene dificultades, ofrece reestructuración.
5. Sé amable pero firme.
6. Responde solo al cliente, sin pasos ni asteriscos.`;

		const response = cleanResponse(await generateResponse(
			`HISTORIAL:\n${formatHistory(context?.history)}\n\nMENSAJE: ${message}`,
			systemPrompt
		));

		return {
			response,
			metadata: { agentType: 'cartera' },
		};
	}
}

// ─── AGENTE SERVICIO TÉCNICO ─────────────────────────────────────────────────

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres agente de servicio técnico de motorcycles. Reglas OBLIGATORIAS:

1. Máximo 80 palabras.
2. No muestres razonamiento interno, asteriscos ni guiones bajos.
3. Pregunta marca, modelo y año del vehículo.
4. Solicita los síntomas.
5. Da opciones de cita: lunes a sábado 8am-5pm.
6. Solo responde al cliente directamente.`;

		const response = cleanResponse(await generateResponse(
			`HISTORIAL:\n${formatHistory(context?.history)}\n\nMENSAJE: ${message}`,
			systemPrompt
		));

		return {
			response,
			metadata: { agentType: 'servicio_tecnico' },
		};
	}
}

// ─── AGENTE REPUESTOS ────────────────────────────────────────────────────────

export class RepuestosAgent implements IAgent {
	name = 'Repuestos';

	async handle(message: string, context: any): Promise<AgentResponse> {
		// Buscar en catálogo de repuestos (usando búsqueda general)
		let productInfo = '';
		try {
			const products = await wooCommerceService.searchProducts(message + ' repuesto', 3);
			if (products.length > 0) {
				productInfo = '\nPRODUCTOS ENCONTRADOS:\n' + wooCommerceService.formatProductList(products);
			}
		} catch {
			// Continuar sin catálogo
		}

		const systemPrompt = `Eres agente de repuestos. Reglas OBLIGATORIAS:

1. Máximo 60 palabras.
2. No muestres razonamiento interno, asteriscos ni guiones bajos.
3. Solicita marca, modelo, año y repuesto necesario.
4. Informa precio y disponibilidad.
5. Si no hay stock, indica tiempo de pedido (3-5 días).
6. Solo responde al cliente directamente.
${productInfo ? '\nProductos disponibles:\n' + productInfo : ''}`;

		const response = cleanResponse(await generateResponse(
			`HISTORIAL:\n${formatHistory(context?.history)}\n\nMENSAJE: ${message}`,
			systemPrompt
		));

		return {
			response,
			metadata: { agentType: 'repuestos' },
		};
	}
}

// ─── AGENTE VACANTES ─────────────────────────────────────────────────────────

export class VacantesAgent implements IAgent {
	name = 'Vacantes';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres agente de recursos humanos. Vacantes disponibles:

- Asesor Comercial: $1.8M + comisiones
- Técnico de Motocicletas: $2.1M + rodamiento
- Auxiliar de Bodega: $1.5M
- Coordinador de Cartera: $2.3M

Reglas OBLIGATORIAS:
1. Máximo 80 palabras.
2. No muestres razonamiento interno, asteriscos ni guiones bajos.
3. Describe vacante con requisitos.
4. Pide nombre y cómo enviar CV.
5. Solo responde al cliente directamente.`;

		const response = cleanResponse(await generateResponse(
			`HISTORIAL:\n${formatHistory(context?.history)}\n\nMENSAJE: ${message}`,
			systemPrompt
		));

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
		const systemPrompt = `Eres agente de distribuidores. Programa:

- Descuento 15-25% sobre precio de lista
- Pedido mínimo 3 unidades/mes
- Soporte: capacitación y asesoría comercial
- Requiere: local comercial y capital $50M

Reglas OBLIGATORIAS:
1. Máximo 60 palabras.
2. No muestres razonamiento interno, asteriscos ni guiones bajos.
3. Solicita nombre, ciudad, local y capital.
4. Solo responde al cliente directamente.`;

		const response = cleanResponse(await generateResponse(
			`HISTORIAL:\n${formatHistory(context?.history)}\n\nMENSAJE: ${message}`,
			systemPrompt
		));

		return {
			response,
			metadata: { agentType: 'distribuidores' },
		};
	}
}

// ─── AGENTE MEDIOS DE PAGO ───────────────────────────────────────────────────

export class PagosAgent implements IAgent {
	name = 'Medios de Pago';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres agente de medios de pago. Opciones:

- Transferencia: Bancolombia Cta 123-456789-10
- PSE: disponible en portal web
- Efectivo: en puntos de venta
- Nequi/Daviplata: 300-123-4567
- Tarjeta: en punto de venta

Reglas OBLIGATORIAS:
1. Máximo 60 palabras.
2. No muestres razonamiento interno, asteriscos ni guiones bajos.
3. Da el medio de pago más conveniente.
4. Confirma após el pago.
5. Solo responde al cliente directamente.`;

		const response = cleanResponse(await generateResponse(
			`HISTORIAL:\n${formatHistory(context?.history)}\n\nMENSAJE: ${message}`,
			systemPrompt
		));

		return {
			response,
			metadata: { agentType: 'pagos' },
		};
	}
}
