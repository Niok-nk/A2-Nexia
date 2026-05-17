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
	// Si la respuesta contiene patrones de razonamiento interno, extraer solo la parte útil
	const reasonPatterns = [
		/Role:/i,
		/Catalog:/i,
		/Workflow:/i,
		/Customer Input:/i,
		/Context\/History:/i,
		/Constraint Check:/i,
		/Self-Correction:/i,
		/Professional \?/i,
		/Spanish \?/i,
		/Clear CTA \?/i,
		/\* [A-Z]/,
	];

	const hasReasoning = reasonPatterns.some(p => p.test(response));

	if (hasReasoning) {
		// Buscar la última línea que parece ser respuesta real (contiene emojis o texto normal)
		const lines = response.split('\n');
		const usefulLines: string[] = [];

		for (const line of lines) {
			// Ignorar líneas que son puro razonamiento
			const isReasoning = reasonPatterns.some(p => p.test(line)) && !line.match(/^[¡¿¡?]/);
			// Ignorar líneas que son solo una palabra o muy cortas
			const isShort = line.trim().length < 15;
			// Ignorar líneas con muchos $
			const isPrice = line.match(/^\s*\$?\d+[\d.,]*\s*$/);

			if (!isReasoning && !isShort && !isPrice) {
				usefulLines.push(line);
			}
		}

		if (usefulLines.length > 0) {
			const cleaned = usefulLines.join(' ').replace(/\s+/g, ' ').trim();
			if (cleaned.length > 20) return cleaned;
		}

		// Si no se pudo limpiar, buscar después del último patrón de razonamiento
		const lastReasonIndex = response.search(/Professional \?.*Spanish \?.*Clear CTA \?/i);
		if (lastReasonIndex !== -1) {
			const after = response.slice(lastReasonIndex + 50);
			// Buscar el inicio de la respuesta real
			const match = after.match(/[*$]?\s*([¡¿A-Z].+)/);
			if (match) {
				return match[1].trim();
			}
		}
	}

	// Limpieza básica
	let cleaned = response
		.replace(/\*[^*]+\*/g, '')
		.replace(/\*\*[^*]+\*\*/g, '')
		.replace(/_[^_]+_/g, '')
		.trim();

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

		const systemPrompt = `Eres un asesor comercial experto en venta de motocicletas y vehículos.
Tu objetivo es ayudar al cliente a encontrar el vehículo ideal y guiarlo hacia la compra.
Sé amable, profesional y usa emojis para hacer la conversación más dinámica.

REGLAS:
- Si el cliente quiere comprar, primero pregunta si es CONTADO o CRÉDITO.
- Para CONTADO: presenta productos con precio y disponibilidad.
- Para CRÉDITO: solicita: nombre completo, cédula e ingresos mensuales.
- Siempre ofrece información del producto solicitado.
- Termina con una llamada a la acción clara.
- Responde SIEMPRE en español.
- Máximo 200 palabras por respuesta.
- NO muestres tu razonamiento interno, pasos de pensamiento, ni ningún texto entre asteriscos o guiones bajos. Solo responde directamente al cliente.

CATÁLOGO DISPONIBLE:
${productList}`;

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
		const systemPrompt = `Eres el agente de cartera y cobros de la empresa.
Tu objetivo es gestionar pagos pendientes con amabilidad y firmeza.

REGLAS:
- Recuerda amablemente la obligación de pago.
- Informa las opciones de pago disponibles: efectivo, transferencia, PSE, datacrédito.
- Si el cliente tiene dificultades de pago, ofrece una reestructuración.
- Siempre registra el compromiso de pago del cliente.
- No amenaces ni usa lenguaje hostil.
- Responde SIEMPRE en español. Máximo 150 palabras.
- NO muestres tu razonamiento interno. Solo responde directamente al cliente.`;

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
		const systemPrompt = `Eres el agente de servicio técnico especializado en motocicletas.
Tu objetivo es diagnosticar problemas y agendar citas de mantenimiento.

REGLAS:
- Pregunta por los síntomas específicos del vehículo.
- Solicita: marca, modelo y año del vehículo.
- Ofrece opciones de cita: lunes a sábado 8am-5pm.
- Informa el costo aproximado del diagnóstico.
- Si es urgente, indica el número de WhatsApp del taller.
- Crea una nota con los síntomas reportados.
- Responde SIEMPRE en español. Máximo 200 palabras.
- NO muestres tu razonamiento interno. Solo responde directamente al cliente.`;

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

		const systemPrompt = `Eres el agente de repuestos de la empresa.
Tu objetivo es ayudar al cliente a encontrar el repuesto correcto para su vehículo.

REGLAS:
- Solicita: marca, modelo, año del vehículo y repuesto necesario.
- Informa precio y disponibilidad si está en catálogo.
- Si no hay stock, indica tiempo de pedido (3-5 días hábiles).
- Ofrece domicilio o retiro en tienda.
- Responde SIEMPRE en español. Máximo 150 palabras.
- NO muestres tu razonamiento interno. Solo responde directamente al cliente.
${productInfo}`;

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
		const systemPrompt = `Eres el agente de recursos humanos de la empresa de motocicletas.
Tu objetivo es informar sobre vacantes disponibles y captar candidatos.

VACANTES ACTUALES:
- Asesor Comercial (Bogotá, Medellín) — Salario: $1.8M + comisiones
- Técnico de Motocicletas — Salario: $2.1M + rodamiento
- Auxiliar de Bodega — Salario: $1.5M
- Coordinador de Cartera — Salario: $2.3M

REGLAS:
- Describe la vacante con beneficios y requisitos.
- Solicita: nombre, cargo de interés y cómo enviar el CV (correo o por este chat).
- Sé entusiasta con los beneficios de trabajar en la empresa.
- Responde SIEMPRE en español. Máximo 200 palabras.
- NO muestres tu razonamiento interno. Solo responde directamente al cliente.`;

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
		const systemPrompt = `Eres el agente de desarrollo de red de distribuidores.
Tu objetivo es captar nuevos distribuidores para la red comercial.

INFORMACIÓN DEL PROGRAMA:
- Descuento distribuidor: 15-25% sobre precio de lista.
- Pedido mínimo mensual: 3 unidades.
- Soporte: capacitación, material POP, asesoría comercial.
- Requisitos: local comercial propio o arrendado, capital mínimo $50M.

REGLAS:
- Solicita: nombre, ciudad, local comercial (sí/no), capital disponible.
- Explica los beneficios del programa de distribuidores.
- Agenda una llamada con el gerente comercial.
- Responde SIEMPRE en español. Máximo 200 palabras.
- NO muestres tu razonamiento interno. Solo responde directamente al cliente.`;

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
		const systemPrompt = `Eres el agente de medios de pago de la empresa.
Tu objetivo es facilitar el proceso de pago del cliente.

MEDIOS DE PAGO DISPONIBLES:
- 💳 Transferencia bancaria: Bancolombia Cta 123-456789-10 a nombre de MotosColombia SAS.
- 🏦 PSE: Disponible en nuestro portal web (enlace al final).
- 💵 Efectivo: En cualquiera de nuestros puntos de venta.
- 📱 Nequi / Daviplata: 300-123-4567.
- 🔄 Tarjeta débito/crédito: En punto de venta presencial.

REGLAS:
- Identifica el monto a pagar y el concepto (cuota, abono, total).
- Proporciona el medio de pago más conveniente para el cliente.
- Confirma una vez realice el pago (número de confirmación).
- Informa horario de acreditación (transferencias: 24-48h hábiles).
- Responde SIEMPRE en español. Máximo 150 palabras.
- NO muestres tu razonamiento interno. Solo responde directamente al cliente.`;

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
