import { IAgent, AgentResponse } from './types.js';
import { getSaludo, AGENT_NAME } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';

const FALLBACKS_PRIMERA_VEZ = [
	(s: string, n?: string) => `¡${s}!${n ? ` ${n}, ` : ' '}soy ${AGENT_NAME}, gracias por escoger a JLC Electronics, la marca de los colombianos. 😊 ¿En qué te puedo ayudar?`,
	(s: string, n?: string) => `¡${s}!${n ? ` ${n}, ` : ' '}un gusto tenerte por aquí. Soy ${AGENT_NAME}, de JLC Electronics, la marca de los colombianos. Cuéntame, ¿en qué te colaboro? ✨`,
	(s: string, n?: string) => `¡${s}!${n ? ` ${n}! ` : ' '}Bienvenido a JLC Electronics, la marca de los colombianos. Soy ${AGENT_NAME} y estoy aquí para ayudarte. ¿Qué necesitas hoy? 💙`,
	(s: string, n?: string) => `¡${s}!${n ? ` ${n} 👋` : ' 👋'} Soy ${AGENT_NAME}, tu asesora en JLC Electronics, la marca de los colombianos. Cuéntame, ¿cómo puedo ayudarte hoy? 😊`,
];

const FALLBACKS_RECURRENTE = [
	(s: string, n?: string) => `¡${s}!${n ? ` ${n}, ` : ' '}qué bueno verte de nuevo por aquí. 😊 ¿En qué te puedo ayudar hoy?`,
	(s: string, n?: string) => `¡${s}!${n ? ` ${n}, ` : ' '}me alegra verte de nuevo. Cuéntame, ¿qué necesitas el día de hoy? ✨`,
	(s: string, n?: string) => `¡${s}!${n ? ` ${n}, ` : ' '}gracias por seguir confiando en JLC, la marca de los colombianos. ¿En qué te ayudo? 💙`,
	(s: string, n?: string) => `¡${s}!${n ? ` ${n}! ` : ' '}qué gusto tenerte de vuelta. Dime, ¿cómo puedo ayudarte hoy? 😊`,
];

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

async function generarBienvenidaIA(recurrente: boolean, nombreCliente?: string): Promise<string | null> {
	const saludo = getSaludo();
	const esRecurrente = recurrente ? 'el cliente ya ha interactuado antes con nosotros' : 'el cliente nos contacta por primera vez';
	const nombreCtx = nombreCliente ? ` Se llama ${nombreCliente}.` : '';
	const variantes = ['cálido', 'alegre', 'cercano', 'entusiasta', 'amigable'];
	const tono = variantes[Math.floor(Math.random() * variantes.length)];
	try {
		const raw = await generateResponse(
			`Clima: ${saludo}. Contexto: ${esRecurrente}.${nombreCtx}`,
			`Eres ${AGENT_NAME}, asesora de JLC Electronics, la marca de los colombianos.
Genera un mensaje de bienvenida PERSONALIZADO y natural (máximo 3 oraciones) para este cliente, con tono ${tono}.
Debe incluir:
- El clima (${saludo}) al inicio
- Tu nombre (${AGENT_NAME})
- "Gracias por escoger a JLC Electronics, la marca de los colombianos" o similar (varía la frase)
- Terminar preguntando "¿En qué te puedo ayudar?" de forma natural (varía la pregunta)${recurrente ? '' : '\n\nIMPORTANTE: el cliente NUNCA ha interactuado antes. NO uses frases como "de nuevo", "volver a saludar", "otra vez", "de vuelta", "otra ocasión". Es su PRIMERA VEZ.'}

NO uses listas numeradas, NO uses "1️⃣", NO muestres opciones.
Tono cálido, femenino, español colombiano.
Incluye 1 o 2 emojis de forma natural para dar calidez 😊✨💙.`
		);
		const limpio = raw.replace(/["""*]/g, '').trim();
		if (limpio.length > 20) {
			if (/(?:^|\s)(?:de\s+nuevo|volver\s+(?:a\s+)?(?:saludar|verte)|volverte\s+(?:a\s+)?saludar|otra\s+vez|de\s+vuelta|otra\s+ocasi[oó]n)/i.test(limpio)) {
				return null; // IA dice "de nuevo" aunque el contexto diga primera vez → descartar
			}
			return limpio;
		}
	} catch {}
	return null;
}

export class BienvenidaAgent implements IAgent {
	name = 'Bienvenida';

	private esClienteRecurrente(context: any): boolean {
		return context?.nuevaSesion || (context?.history?.length ?? 0) > 0;
	}

	async handle(_message: string, context: any): Promise<AgentResponse> {
		const recurrente = this.esClienteRecurrente(context);
		const nombre = (context?.userData?.nombre || '').split(/\s+/)[0] || undefined;
		const iaMsg = await generarBienvenidaIA(recurrente, nombre);
		const fallbacks = recurrente ? FALLBACKS_RECURRENTE : FALLBACKS_PRIMERA_VEZ;
		const saludo = getSaludo();
		const msg = iaMsg || pick(fallbacks)(saludo, nombre);
		return {
			response: msg,
			metadata: { agentType: 'bienvenida', passthrough: false },
		};
	}
}
