import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';
import { sanitizarNumerosVentas } from './ventas.agent.js';

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Canales de servicio técnico JLC:${userDataCtx}
- WhatsApp técnico: +57 320 7881151
- WhatsApp Postventa: +57 320 7881110
- WhatsApp Postventa: +57 314 8028482
- Web: https://jlc-electronics.com/servicio-tecnico/
- O escríbenos al correo: analistapostventa@electromillonaria.co
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
		const response = sanitizarNumerosVentas(cleanResponse(raw));

		return {
			response,
			metadata: { agentType: 'servicio_tecnico' },
		};
	}
}
