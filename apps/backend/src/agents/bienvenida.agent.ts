import { IAgent, AgentResponse } from './types.js';
import { getSaludo, AGENT_NAME } from './helpers.js';

const MENSAJES_RECURRENTE = [
	(s: string) => `¡${s}! Qué bueno verte de nuevo por aquí. 😊 ¿En qué te puedo ayudar hoy?`,
	(s: string) => `¡${s}! Me alegra verte de nuevo. Cuéntame, ¿qué necesitas el día de hoy?`,
	(s: string) => `¡${s}! Gracias por seguir confiando en JLC, la marca de los colombianos. 😊 ¿En qué te ayudo?`,
	(s: string) => `¡${s}! Qué gusto tenerte por acá de nuevo. Dime, ¿cómo puedo ayudarte hoy?`,
];

const MENSAJES_PRIMERA_VEZ = [
	(s: string) => `¡${s}! 👋 Soy ${AGENT_NAME}, tu asesora en JLC Electronics, la marca de los colombianos.

Gracias por escribirnos. ¿En qué te puedo ayudar?

1️⃣ Comprar un producto (contado o crédito)
2️⃣ Cartera / estado de cuenta
3️⃣ Servicio técnico o garantía
4️⃣ Repuestos
5️⃣ Medios de pago / pagar una cuota
6️⃣ Distribuidores
7️⃣ Trabaja con nosotros

Escríbeme el número o cuéntame qué necesitas 😊`,
	(s: string) => `¡${s}! 👋 Soy ${AGENT_NAME}, tu asesora virtual en JLC Electronics.

Cuéntame, ¿en qué puedo ayudarte hoy?

1️⃣ Comprar un producto (contado o crédito)
2️⃣ Cartera / estado de cuenta
3️⃣ Servicio técnico o garantía
4️⃣ Repuestos
5️⃣ Medios de pago / pagar una cuota
6️⃣ Distribuidores
7️⃣ Trabaja con nosotros

Escríbeme el número o cuéntame qué necesitas 😊`,
	(s: string) => `¡${s}! 👋 Soy ${AGENT_NAME}, de JLC Electronics — la marca de los colombianos.

Gracias por comunicarte con nosotros. ¿En qué te colaboramos?

1️⃣ Comprar un producto (contado o crédito)
2️⃣ Cartera / estado de cuenta
3️⃣ Servicio técnico o garantía
4️⃣ Repuestos
5️⃣ Medios de pago / pagar una cuota
6️⃣ Distribuidores
7️⃣ Trabaja con nosotros

Escríbeme el número o dime qué necesitas 😊`,
];

const MENSAJES_BREVES = [
	(s: string) => `¡${s}! 👋 Soy ${AGENT_NAME}, de JLC. Con gusto te ayudo con eso.`,
	(s: string) => `¡${s}! 👋 Gracias por escribir a JLC, soy ${AGENT_NAME}. Dime cómo te ayudo con eso.`,
	(s: string) => `¡${s}! 👋 Soy ${AGENT_NAME}, tu asesora en JLC. En qué más te ayudo con eso.`,
];

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

export class BienvenidaAgent implements IAgent {
	name = 'Bienvenida';

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

	private esClienteRecurrente(context: any): boolean {
		return context?.nuevaSesion || (context?.history?.length ?? 0) > 0;
	}

	async handle(message: string, context: any): Promise<AgentResponse> {
		const saludo = getSaludo();
		const recurrente = this.esClienteRecurrente(context);
		const tieneIntencion = this.tieneIntencionClara(message);

		if (recurrente && !tieneIntencion) {
			return {
				response: pick(MENSAJES_RECURRENTE)(saludo),
				metadata: {
					agentType: 'bienvenida',
					passthrough: true,
				},
			};
		}

		if (tieneIntencion) {
			return {
				response: pick(MENSAJES_BREVES)(saludo),
				metadata: {
					agentType: 'bienvenida',
					passthrough: true,
				},
			};
		}

		return {
			response: pick(MENSAJES_PRIMERA_VEZ)(saludo),
			metadata: { agentType: 'bienvenida', passthrough: false },
		};
	}
}
