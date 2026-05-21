import {
	IAgent,
	BienvenidaAgent,
	VentasAgent,
	CarteraAgent,
	ServicioTecnicoAgent,
	RepuestosAgent,
	VacantesAgent,
	DistribuidoresAgent,
	PagosAgent,
} from './agents.js';
import { generateResponse } from '../utils/gemini.js';

type IntentKey =
	| 'bienvenida'
	| 'ventas'
	| 'cartera'
	| 'servicio_tecnico'
	| 'repuestos'
	| 'vacantes'
	| 'distribuidores'
	| 'pagos';

export class Orchestrator {
	private agents: Record<IntentKey, IAgent> = {
		bienvenida: new BienvenidaAgent(),
		ventas: new VentasAgent(),
		cartera: new CarteraAgent(),
		servicio_tecnico: new ServicioTecnicoAgent(),
		repuestos: new RepuestosAgent(),
		vacantes: new VacantesAgent(),
		distribuidores: new DistribuidoresAgent(),
		pagos: new PagosAgent(),
	};

	// ─── Filtro 1: ¿Es un saludo / mensaje vago? ──────────────────────────────
	//
	// Si el mensaje es un saludo simple, sin intención clara, o muy corto y
	// vago, va al agente de Bienvenida. Esto evita que el modelo "adivine" la
	// intención de un "hola" y lo mande a servicio técnico.

	private isGreetingOrVague(message: string, hasHistory: boolean): boolean {
		const m = message.toLowerCase().trim();

		// Si ya hay historial, no es saludo inicial: dejamos que el clasificador decida.
		if (hasHistory) return false;

		// Mensaje vacío o solo emoji/símbolos
		if (m.length === 0) return true;

		// Lista de saludos / aperturas comunes (sin intención específica)
		const greetings = [
			'hola', 'holaa', 'holaaa', 'holi', 'oli', 'ola', 'hello', 'hi', 'hey',
			'buenas', 'buenos dias', 'buenos días', 'buen dia', 'buen día',
			'buenas tardes', 'buenas noches', 'que tal', 'qué tal', 'como estas',
			'cómo estás', 'como estas?', 'cómo estás?', 'que hubo', 'qué hubo',
			'saludos', 'oye', 'jlc', 'buenvenido', 'bienvenido', 'bienvenida',
			'info', 'informacion', 'información', 'ayuda', 'help',
			'menu', 'menú', 'opciones', 'inicio', 'empezar', 'comenzar', 'start',
			'pregunta', 'consulta', 'quisiera saber', 'me gustaría saber',
			'soy nuevo', 'soy nueva', 'primera vez', 'vengo de',
			'quiero informacion', 'quiero información', 'necesito ayuda',
			'1', '2', '3', '4', '5', '6', '7',   // opciones del menú de bienvenida
			'?', '??', '...',
		];

		// Limpiar puntuación final para comparar
		const cleaned = m.replace(/[.,!?¡¿…]+$/g, '').trim();
		if (greetings.includes(cleaned)) return true;

		// Saludos con coma o con algo después
		const firstWord = cleaned.split(/[\s,]+/)[0];
		if (greetings.includes(firstWord) && cleaned.length < 30) return true;

		// Patrones de presentación: "me llamo...", "soy...", etc.
		const presentationPatterns = [
			/^me\s+llamo/i, /^soy\s+[a-z]/i, /^mi\s+nombre/i,
			/^vengo\s+por/i, /^quisiera\s+info/i, /^busco\s+info/i,
		];
		for (const pattern of presentationPatterns) {
			if (pattern.test(cleaned) && cleaned.length < 40) return true;
		}

		// Muy corto y sin palabras clave de intención
		if (cleaned.length < 5) return true;

		return false;
	}

	// ─── Filtro 2: Mapeo de opciones del menú (1-7) ───────────────────────────
	//
	// Cuando el cliente responde un número del menú de bienvenida, lo mapeamos
	// directamente al agente correspondiente sin pasar por el modelo.

	private menuOptionToIntent(message: string): IntentKey | null {
		const m = message.trim().replace(/[.,!?¡¿]+$/g, '');
		const map: Record<string, IntentKey> = {
			'1': 'ventas',
			'2': 'cartera',
			'3': 'servicio_tecnico',
			'4': 'repuestos',
			'5': 'pagos',
			'6': 'distribuidores',
			'7': 'vacantes',
		};
		return map[m] ?? null;
	}

	// ─── Filtro 3: Atajo por palabras clave (sin llamar al modelo) ────────────

	private quickIntent(message: string): IntentKey | null {
		const m = message.toLowerCase();

		if (/\b(distribuidor|distribuidores|ser distribuidor|al por mayor|mayorista|mayoreo)\b/.test(m)) {
			return 'distribuidores';
		}
		if (/\b(vacante|empleo|trabajo|hoja de vida|cv|curriculum|currículum|aplicar a|aplicar al)\b/.test(m)) {
			return 'vacantes';
		}
		if (/\b(servicio t[eé]cnico|reparaci[oó]n|reparar|mantenimiento|no enciende|no funciona|no enfr[ií]a|no centrifuga|da[ñn]ado|da[ñn]ada|falla|aver[ií]a|garant[ií]a)\b/.test(m)) {
			return 'servicio_tecnico';
		}
		if (/\b(repuesto|repuestos|pieza|piezas|accesorio|accesorios|filtro|empaque|resistencia|motor de)\b/.test(m)) {
			return 'repuestos';
		}
		if (/\b(cartera|deuda|mora|cuota atrasada|atrasado|estado de cuenta|saldo|recordatorio de pago|cu[aá]nto debo|me debe|debo|paz y salvo|factura)\b/.test(m)) {
			return 'cartera';
		}
		if (/\b(c[oó]mo pago|d[oó]nde pago|medio de pago|medios de pago|formas de pago|forma de pago|pse|pagar con tarjeta|transferencia|consignar|consignaci[oó]n|soporte de pago|comprobante de pago)\b/.test(m)) {
			return 'pagos';
		}
		if (/\b(comprar|cotizar|cotizaci[oó]n|precio|cu[aá]nto cuesta|cu[aá]nto vale|nevera|lavadora|televisor|televisores|tv|estufa|microondas|licuadora|aire acondicionado|electrodom[eé]stico|electrodom[eé]sticos|cr[eé]dito|financiar|cuotas)\b/.test(m)) {
			return 'ventas';
		}

		return null;
	}

	// ─── Filtro 4: Clasificación con el modelo (few-shot) ─────────────────────

	private async classifyWithModel(message: string): Promise<IntentKey> {
		const prompt = `Eres un clasificador de intención para un chatbot de electrodomésticos. Lee el mensaje del cliente y responde con UNA SOLA palabra de esta lista:

ventas | cartera | servicio_tecnico | repuestos | vacantes | distribuidores | pagos

REGLAS:
- "ventas" cubre: comprar, cotizar, precios, productos, crédito, financiación.
- "cartera" cubre: deudas, cuotas, mora, estado de cuenta, paz y salvo, factura vencida.
- "servicio_tecnico" cubre: reparación, mantenimiento, garantía, equipo dañado o que no funciona.
- "repuestos" cubre: piezas, partes, accesorios, filtros, empaques.
- "vacantes" cubre: trabajo, empleo, hoja de vida.
- "distribuidores" cubre: ser distribuidor, venta al mayor, mayorista.
- "pagos" cubre: medios de pago, PSE, tarjeta, cómo pagar una cuota, envío de soportes.

Ejemplos:

Mensaje: "Hola, quiero saber el precio de una nevera de 300 litros"
Categoría: ventas

Mensaje: "Mi lavadora no centrifuga"
Categoría: servicio_tecnico

Mensaje: "Necesito el filtro de mi nevera marca jlc"
Categoría: repuestos

Mensaje: "¿Cuánto debo de mi crédito?"
Categoría: cartera

Mensaje: "¿Tienen vacantes?"
Categoría: vacantes

Mensaje: "Quiero ser distribuidor"
Categoría: distribuidores

Mensaje: "¿Puedo pagar con tarjeta?"
Categoría: pagos

Mensaje: "Quiero una nevera a crédito"
Categoría: ventas

Mensaje: "${message.replace(/"/g, "'")}"
Categoría:`;

		let raw = '';
		try {
			raw = await generateResponse(prompt);
		} catch {
			return 'ventas';
		}

		const cat = (raw || '').toLowerCase().trim().split(/[\s\n.,!]/)[0];

		if (/servicio|t[eé]cnico/.test(cat)) return 'servicio_tecnico';
		if (/distribuidor/.test(cat)) return 'distribuidores';
		if (/repuesto/.test(cat)) return 'repuestos';
		if (/vacante|empleo|trabajo/.test(cat)) return 'vacantes';
		if (/cartera|deuda|cuota/.test(cat)) return 'cartera';
		if (/^pago/.test(cat) || /medio/.test(cat)) return 'pagos';
		if (/venta/.test(cat)) return 'ventas';

		return 'ventas';
	}

	// ─── Clasificación general ────────────────────────────────────────────────

	async classifyIntent(message: string, hasHistory = false): Promise<IntentKey> {
		// Paso 1: saludo / vago → bienvenida
		if (this.isGreetingOrVague(message, hasHistory)) return 'bienvenida';

		// Paso 2: opción numérica del menú (1-7)
		const menuIntent = this.menuOptionToIntent(message);
		if (menuIntent) return menuIntent;

		// Paso 3: palabras clave
		const quick = this.quickIntent(message);
		if (quick) return quick;

		// Paso 4: modelo
		return this.classifyWithModel(message);
	}

	async route(
		message: string,
		context: any
	): Promise<{ agentType: string; response: string }> {
		const hasHistory = Array.isArray(context?.history) && context.history.length > 0;

		// Si hay un flujo activo en el contexto, respetar el agente actual
		// para no interrumpir procesos en curso (crédito, repuestos, etc.)
		let intent: IntentKey;

		const flujoActivo = context?.flujo;
		if (flujoActivo) {
			// Mapear flujo activo al agente correspondiente
			if (/^credito/.test(flujoActivo) || flujoActivo === 'sin_cobertura' || flujoActivo === 'contado_sin_cobertura' || flujoActivo === 'esperando_ciudad' || flujoActivo === 'credito_perfilando') {
				intent = 'ventas';
			} else if (/^repuesto/.test(flujoActivo)) {
				intent = 'repuestos';
			} else {
				// Flujo desconocido → reclasificar normalmente
				intent = await this.classifyIntent(message, hasHistory);
			}
		} else {
			intent = await this.classifyIntent(message, hasHistory);
		}

		const agent = this.agents[intent] || this.agents.ventas;
		const result = await agent.handle(message, context);

		return {
			agentType: intent,
			response: result.response,
		};
	}
}

export const orchestrator = new Orchestrator();