import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';

export class CarteraAgent implements IAgent {
	name = 'Cartera';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Canales oficiales de cartera y facturación:
- WhatsApp cartera: +57 314 422 9949 y +57 315 721 2367
- Línea telefónica: +57 320 788 1108 (horario: 08:30 p.m. a 12:30 p.m., lunes a viernes)
- Correo peticiones con soportes: callcenter5@electromillonaria.co
Desde este chat no se puede acceder a información personal del cliente.${userDataCtx}`;

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
						'Entiendo la situación. Escribe al WhatsApp de cartera +57 314 422 9949 o llama al +57 320 788 1108 entre 12:30 and 2:30 p.m. para revisar opciones de reestructuración.',
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
