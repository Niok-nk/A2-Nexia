import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';

export class PagosAgent implements IAgent {
	name = 'Medios de Pago';

	async handle(message: string, context: any): Promise<AgentResponse> {
		// ── Detectar si hay un producto activo en el contexto ──────────────
		const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
		const productoURL = context?.productoURL ?? ultimosProductos[0]?.permalink;
		const productoNombre = context?.productoCompra ?? ultimosProductos[0]?.name;
		const tieneCobertura = context?.tieneCobertura ?? false;
		const ciudadStr = context?.ciudad
			? context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)
			: '';

		// ── Si hay producto seleccionado → flujo de pago de contado estructurado ─────
		if (productoURL || productoNombre) {
			const linkProducto = productoURL ? `\nLink de tu producto: ${productoURL}` : '';
			const opcionPuntoFisico = tieneCobertura
				? '\n3️⃣ Pagar en un punto físico (solo necesito tu nombre y cédula para reservarlo)'
				: '';
			const envioInfo = tieneCobertura
				? `con envío gratis a ${ciudadStr}`
				: ciudadStr ? `(envío por transportadora a ${ciudadStr})` : '';

			return {
				response: `Para pagar tu *${productoNombre || 'producto'}* ${envioInfo}, estas son tus opciones:${linkProducto}\n\n1️⃣ Por transferencia bancaria (medios autorizados)\nhttps://jlc-electronics.com/wp-content/uploads/2026/05/Medios_de_pago.jpeg\n\n2️⃣ Pagar directamente en la página web (PSE, Tarjeta, Nequi)${opcionPuntoFisico}\n\nEscríbeme el número de tu opción y te acompaño paso a paso. 😊`,
				metadata: {
					agentType: 'ventas', // Redirigir al agente de ventas para manejar el flujo
					flujo: 'seleccion_pago',
					modalidad: 'contado',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura,
					productoURL,
					productoCompra: productoNombre,
					ultimaBusqueda: context?.ultimaBusqueda,
				},
			};
		}

		// ── Sin producto → flujo genérico de medios de pago ───────────────
		const lower = message.toLowerCase();

		// Pregunta sobre soportes de pago
		if (/soporte|comprobante|donde\s*env[ií]o|a\s*d[oó]nde\s*mando/i.test(lower)) {
			return {
				response: `Envía tu soporte de pago al WhatsApp de cartera: +57 314 422 9949 o +57 315 721 2367, o al correo callcenter5@electromillonaria.co. 😊📄✅`,
				metadata: { agentType: 'pagos' },
			};
		}

		// Pregunta sobre crédito
		if (/cr[eé]dito|cuotas|financiar|financiaci[oó]n/i.test(lower)) {
			return {
				response: `El crédito lo gestiona nuestro equipo comercial. ¿Quieres que te ayude a iniciar la solicitud de crédito desde aquí?`,
				metadata: { agentType: 'pagos' },
			};
		}

		// Pregunta genérica de medios de pago
		const userDataCtx = buildUserDataContext(context?.userData);
		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres Sara, asesora de medios de pago de JLC Electronics. Tono cálido y femenino. Español colombiano.
Entrega la información concreta de cómo pagar. No digas "un asesor te contactará".
${userDataCtx}
Medios de pago:
1) En línea en https://jlc-electronics.com/ con PSE, tarjeta de crédito o débito.
2) En punto físico (según disponibilidad en la ciudad del cliente).
3) Crédito/cuotas: se gestiona desde el chat (iniciar solicitud de crédito).
4) Imagen de medios autorizados: https://jlc-electronics.com/wp-content/uploads/2026/05/Medios_de_pago.jpeg
REGLAS:
- Si el cliente pregunta cómo pagar, muestra la imagen de medios de pago.
- Mensajes cortos tipo WhatsApp, sin asteriscos.
- No menciones números de cartera a menos que pregunten por soportes de pago.`,
			ejemplos: [
				{
					cliente: '¿Cómo puedo pagar?',
					asistente:
						'Aquí están nuestros medios de pago autorizados:\nhttps://jlc-electronics.com/wp-content/uploads/2026/05/Medios_de_pago.jpeg\n\nTambién puedes pagar en línea en https://jlc-electronics.com/ con PSE, tarjeta o Nequi. ¿Ya tienes un producto seleccionado?',
				},
				{
					cliente: '¿Aceptan tarjeta de crédito?',
					asistente:
						'Sí, al pagar en https://jlc-electronics.com/ puedes usar tarjeta de crédito, débito o PSE a través de Wompi. ¿Te ayudo a seleccionar un producto?',
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
