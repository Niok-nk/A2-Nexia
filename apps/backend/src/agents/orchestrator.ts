import {
	IAgent,
	VentasAgent,
	CarteraAgent,
	ServicioTecnicoAgent,
	RepuestosAgent,
	VacantesAgent,
	DistribuidoresAgent,
	PagosAgent,
} from './agents.js';
import { generateResponse } from '../utils/gemini.js';

export class Orchestrator {
	private agents: Record<string, IAgent> = {
		ventas: new VentasAgent(),
		cartera: new CarteraAgent(),
		servicio_tecnico: new ServicioTecnicoAgent(),
		repuestos: new RepuestosAgent(),
		vacantes: new VacantesAgent(),
		distribuidores: new DistribuidoresAgent(),
		pagos: new PagosAgent(),
	};

	async classifyIntent(message: string): Promise<string> {
		const classificationPrompt = `Clasifica el siguiente mensaje en una de estas categorías:
- ventas (si quiere comprar, cotizar, información de vehículos)
- cartera (si es sobre pagos, deuda, recordatorios)
- servicio_tecnico (si es reparación, mantenimiento, falla)
- repuestos (si busca repuestos específicos)
- vacantes (si pregunta por empleo)
- distribuidores (si quiere ser distribuidor)
- pagos (si quiere pagar, medios de pago)

Mensaje: "${message}"

Responde solo con la categoría (una palabra):`;

		const classification = await generateResponse(classificationPrompt);
		const category = classification.toLowerCase().trim();

		if (category.includes('venta')) return 'ventas';
		if (category.includes('cartera')) return 'cartera';
		if (category.includes('servicio') || category.includes('técnico'))
			return 'servicio_tecnico';
		if (category.includes('repuesto')) return 'repuestos';
		if (category.includes('vacante') || category.includes('empleo'))
			return 'vacantes';
		if (category.includes('distribuidor')) return 'distribuidores';
		if (category.includes('pago')) return 'pagos';

		return 'ventas';
	}

	async route(
		message: string,
		context: any
	): Promise<{ agentType: string; response: string }> {
		const intent = await this.classifyIntent(message);
		const agent = this.agents[intent] || this.agents.ventas;

		const result = await agent.handle(message, context);

		return {
			agentType: intent,
			response: result.response,
		};
	}
}

export const orchestrator = new Orchestrator();
