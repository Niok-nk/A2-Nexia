import { generateResponse } from '../utils/gemini.js';

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

export class VentasAgent implements IAgent {
	name = 'Ventas';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres un agente de ventas especializado en vehículos.
Tu objetivo es ayudar al cliente a encontrar el vehículo ideal y guiarlo en el proceso de compra.
Responde de manera amable y profesional.`;

		const response = await generateResponse(
			`Mensaje del cliente: ${message}\nContexto: ${JSON.stringify(context)}`,
			systemPrompt
		);

		return {
			response,
			nextStage: 'PROPOSAL',
			metadata: { agentType: 'ventas' },
		};
	}
}

export class CarteraAgent implements IAgent {
	name = 'Cartera';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres un agente de cartera encargado del seguimiento de pagos.
Tu objetivo es recordar amablemente los pagos pendientes y facilitar canales de pago.`;

		const response = await generateResponse(
			`Mensaje del cliente: ${message}\nContexto: ${JSON.stringify(context)}`,
			systemPrompt
		);

		return {
			response,
			metadata: { agentType: 'cartera' },
		};
	}
}

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres un agente de servicio técnico especializado en diagnóstico de vehículos.
Tu objetivo es identificar el problema y agendar una cita de servicio.`;

		const response = await generateResponse(
			`Mensaje del cliente: ${message}\nContexto: ${JSON.stringify(context)}`,
			systemPrompt
		);

		return {
			response,
			metadata: { agentType: 'servicio_tecnico' },
		};
	}
}

export class RepuestosAgent implements IAgent {
	name = 'Repuestos';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres un agente de repuestos.
Tu objetivo es ayudar al cliente a encontrar los repuestos que necesita y proporcionar información de precios y disponibilidad.`;

		const response = await generateResponse(
			`Mensaje del cliente: ${message}\nContexto: ${JSON.stringify(context)}`,
			systemPrompt
		);

		return {
			response,
			metadata: { agentType: 'repuestos' },
		};
	}
}

export class VacantesAgent implements IAgent {
	name = 'Vacantes';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres un agente de recursos humanos encargado de vacantes.
Tu objetivo es informar sobre las vacantes disponibles y solicitar el CV de los interesados.`;

		const response = await generateResponse(
			`Mensaje del cliente: ${message}\nContexto: ${JSON.stringify(context)}`,
			systemPrompt
		);

		return {
			response,
			metadata: { agentType: 'vacantes' },
		};
	}
}

export class DistribuidoresAgent implements IAgent {
	name = 'Distribuidores';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres un agente encargado de gestionar distribuidores.
Tu objetivo es captar nuevos distribuidores y gestionar el formulario de registro.`;

		const response = await generateResponse(
			`Mensaje del cliente: ${message}\nContexto: ${JSON.stringify(context)}`,
			systemPrompt
		);

		return {
			response,
			metadata: { agentType: 'distribuidores' },
		};
	}
}

export class PagosAgent implements IAgent {
	name = 'Medios de Pago';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const systemPrompt = `Eres un agente especializado en medios de pago.
Tu objetivo es enviar links de pago y facilitar las transacciones.`;

		const response = await generateResponse(
			`Mensaje del cliente: ${message}\nContexto: ${JSON.stringify(context)}`,
			systemPrompt
		);

		return {
			response,
			metadata: { agentType: 'pagos' },
		};
	}
}
