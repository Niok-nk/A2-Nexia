import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';
import { sanitizarNumerosVentas } from './ventas.agent.js';

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const esUrgente = /urgente|rapido|rápido|ya|inmediato|ahora|apenas|quemando|quemó|humo|fuego|explosión|fuga|gas|agua|inundación|corto\s*circuito/i.test(message);

		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Canales de servicio técnico JLC:${userDataCtx}
- Web: https://jlc-electronics.com/servicio-tecnico/
- Link para solicitar garantía: https://mitoolset.ddns.net:222/postventa/public/tickets/solicitud_garantia
${esUrgente ? '- WhatsApp técnico: +57 320 7881151\n- WhatsApp Postventa: +57 320 7881110\n- WhatsApp Postventa: +57 314 8028482' : ''}
Para garantías, el cliente debe tener factura de compra y el producto en buen estado externo.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de servicio técnico de Electrodomésticos JLC. Atiendes clientes con electrodomésticos dañados o que necesitan mantenimiento.

REGLAS:
- NO muestres números de teléfono de servicio técnico ni postventa a menos que el cliente los solicite URGENTEMENTE (ej: el electrodoméstico tiene humo, fuego, fuga, cortocircuito o el cliente dice "urgente", "rápido", "inmediato").
- Si el cliente solicita GARANTÍA, indícale que debe ingresar al link de solicitud de garantía para asignar un ticket: https://mitoolset.ddns.net:222/postventa/public/tickets/solicitud_garantia
- Para casos NO URGENTES (fallas comunes, mantenimiento, consultas), indícales que pueden gestionarlo por la web https://jlc-electronics.com/servicio-tecnico/
- Cuando el caso es urgente, ENTREGA los números de contacto al final.
- Sé breve y natural. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: 'Mi lavadora no centrifuga',
					asistente:
						'Lamento la falla. Puedes gestionar tu solicitud en nuestra web https://jlc-electronics.com/servicio-tecnico/ y un técnico te contactará. ¿Me indicas marca y modelo para orientarte mejor?',
				},
				{
					cliente: 'Necesito mantenimiento para mi nevera JLC',
					asistente:
						'¡Claro! Puedes registrar tu solicitud en https://jlc-electronics.com/servicio-tecnico/ para que un técnico se ponga en contacto contigo. 😊',
				},
				{
					cliente: 'Tengo una nevera en garantía que no enfría',
					asistente:
						'Para tramitar la garantía tienes un nuevo método: ingresa al link https://mitoolset.ddns.net:222/postventa/public/tickets/solicitud_garantia y asigna tu ticket. Necesitarás la factura de compra y el equipo en buen estado externo. 😊',
				},
				{
					cliente: 'Mi nevera está soltando humo, urgente',
					asistente:
						'¡Esto es urgente! Desconecta el equipo de inmediato. Escríbeles ya a los técnicos: 📞 +57 320 788 1151 o +57 320 788 1110 (lunes a sábado, 8 a.m. a 5 p.m.).',
				},
				{
					cliente: '¿Cuánto cobra el técnico por visita?',
					asistente:
						'El costo de la visita lo confirma directamente el técnico según la zona y el tipo de equipo. Puedes solicitar la visita en https://jlc-electronics.com/servicio-tecnico/ para que te cotice. 😊',
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
