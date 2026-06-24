import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';
import { sanitizarNumerosVentas } from './ventas.agent.js';

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const esGarantia = /\b(?:garant[ií]a|cambio|reembolso|devoluci[oó]n|reclamaci[oó]n)\b/i.test(message);

		const userDataCtx = buildUserDataContext(context?.userData);

		const datos = esGarantia
			? `Link de garantía JLC: https://mitoolset.ddns.net:222/postventa/public/tickets/solicitud_garantia
Para garantías, el cliente debe tener factura de compra y el producto en buen estado externo.`
			: `Canales de servicio técnico JLC:${userDataCtx}
- WhatsApp técnico: +57 320 7881151
- WhatsApp Postventa: +57 320 7881110
- WhatsApp Postventa: +57 314 8028482
- Web: https://jlc-electronics.com/servicio-tecnico/`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `${esGarantia
				? `El cliente solicita GARANTÍA. Indícale que debe ingresar al link para asignar un ticket. NO des diagnósticos ni asistas el caso, solo redirige al link.`
				: `El cliente necesita SERVICIO TÉCNICO. Indícale los canales de contacto para que un técnico lo asista. NO des diagnósticos ni intentes solucionar el problema, solo entrega los datos de contacto.`}

Datos disponibles:
${datos}

Responde MUY corto (máximo 2 frases), solo redirige.`,
			ejemplos: esGarantia
				? [
					{
						cliente: 'Tengo una nevera en garantía que no enfría',
						asistente: 'Para tramitar la garantía ingresa al link https://mitoolset.ddns.net:222/postventa/public/tickets/solicitud_garantia y asigna tu ticket. Necesitarás la factura de compra. 😊',
					},
					{
						cliente: 'Quiero hacer válida la garantía de mi lavadora',
						asistente: 'Ingresa a https://mitoolset.ddns.net:222/postventa/public/tickets/solicitud_garantia para asignar tu ticket de garantía. Ten a mano la factura. 😊',
					},
				]
				: [
					{
						cliente: 'Mi lavadora no centrifuga',
						asistente: 'Comunícate con nuestro técnico al WhatsApp +57 320 788 1151 (lunes a sábado, 8 a.m. a 5 p.m.) para que te ayuden.',
					},
					{
						cliente: 'Necesito mantenimiento para mi nevera JLC',
						asistente: 'Escríbeles a los técnicos al WhatsApp +57 320 788 1151 o +57 320 788 1110 para agendar el mantenimiento. Atienden lunes a sábado de 8 a.m. a 5 p.m.',
					},
					{
						cliente: '¿Cuánto cobra el técnico por visita?',
						asistente: 'El costo lo confirma el técnico según la zona. Escríbele al +57 320 788 1151 (lunes a sábado, 8 a.m. a 5 p.m.) para que te cotice.',
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
