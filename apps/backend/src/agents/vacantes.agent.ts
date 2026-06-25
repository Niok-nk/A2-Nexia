import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory, AGENT_NAME } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';

const CORREO_VACANTES = 'psicologo2@electromillonaria.co';

export class VacantesAgent implements IAgent {
	name = 'Vacantes';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const userDataCtx = buildUserDataContext(context?.userData);

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres ${AGENT_NAME}, asesora de talento humano de JLC Electronics Colombia.

El cliente está interesado en vacantes o en trabajar con nosotros.

REGLAS:
- Responde de forma personalizada y cálida según lo que haya escrito el cliente.
- Indica que para aplicar debe enviar su hoja de vida al correo: ${CORREO_VACANTES}
- Si el cliente ya envió hoja de vida por imagen, indica que también puede enviarla al correo para que quede registrada.
- No preguntes datos personales ni los registres. Solo redirige al correo.
- Máximo 2 frases, 1 emoji.
- No inventes vacantes ni listados de cargos disponibles.

Correo de postulación: ${CORREO_VACANTES}
${userDataCtx ? `Datos del cliente: ${userDataCtx}` : ''}`,
			ejemplos: [
				{
					cliente: '¿Tienen vacantes?',
					asistente: '¡Gracias por tu interés en formar parte de nuestro equipo! 🌟 Envía tu hoja de vida al correo psicologo2@electromillonaria.co y el equipo de RRHH te contactará. 😊',
				},
				{
					cliente: 'Quiero aplicar para asesor comercial en Cali',
					asistente: 'Qué emocionante que quieras trabajar con nosotros 🎉 Por favor envía tu hoja de vida al correo psicologo2@electromillonaria.co indicando el cargo y ciudad de interés, y te contactarán. 😊',
				},
				{
					cliente: 'Envío mi hoja de vida',
					asistente: '¡Gracias! 📄 Recibimos tu hoja de vida. También puedes enviarla al correo psicologo2@electromillonaria.co para que quede registrada en nuestra base de datos. El equipo de RRHH se pondrá en contacto contigo. 😊',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'vacantes', correoVacantes: CORREO_VACANTES },
		};
	}
}
