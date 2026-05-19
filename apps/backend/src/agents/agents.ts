import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';

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

// ─── Helper: formatear historial ─────────────────────────────────────────────

function formatHistory(history: Array<{ direction: string; body: string }>): string {
	if (!history || history.length === 0) return '(primer mensaje del cliente)';
	return history
		.slice(-6)
		.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
		.join('\n');
}

// ─── Helper: limpiar respuesta de Gemma ──────────────────────────────────────
//
// Gemma muestra TODO su razonamiento ("Role:", "Task:", "Draft 1:",
// "Check constraints:", asteriscos, etc.). Este filtro es agresivo.

function cleanResponse(raw: string): string {
	if (!raw) return '';
	let text = raw.trim();

	// 1. Eliminar bloques de pensamiento estilo Gemma/DeepSeek
	text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
	text = text.replace(/```[\s\S]*?```/g, '');

	// 2. Si hay un marcador de "borrador final" / "respuesta", quedarse SOLO
	//    con lo que viene después de la última ocurrencia
	const finalMarkers = [
		/(?:^|\n)\s*\**\s*(?:draft\s*\d*\s*final|final\s*draft|borrador final|respuesta final|respuesta al cliente|mensaje al cliente|respuesta|asistente|assistant|output|final answer|final)\s*:?\s*\**\s*\n/gi,
	];
	for (const re of finalMarkers) {
		let lastMatch: RegExpExecArray | null = null;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) lastMatch = m;
		if (lastMatch && typeof lastMatch.index === 'number') {
			text = text.slice(lastMatch.index + lastMatch[0].length);
		}
	}

	// 3. Si Gemma puso un "Draft 1:" tipo borrador, queremos lo que sigue
	const draftRe = /(?:^|\n)\s*\**\s*draft\s*\d+\s*\**\s*:?\s*\**\s*\n?/gi;
	let lastDraft: RegExpExecArray | null = null;
	let dm: RegExpExecArray | null;
	while ((dm = draftRe.exec(text)) !== null) lastDraft = dm;
	if (lastDraft && typeof lastDraft.index === 'number') {
		text = text.slice(lastDraft.index + lastDraft[0].length);
	}

	// 4. Eliminar líneas que son razonamiento (encabezados conocidos)
	const skipPatterns = [
		/^\**\s*(role|rol|task|tarea|company data|company|datos de la empresa|empresa)\s*:/i,
		/^\**\s*(interaction protocol|protocol|protocolo|flujo|workflow|catalog|catálogo)\s*:/i,
		/^\**\s*(constraints|restricciones|reglas|rules|format|formato|output)\s*:/i,
		/^\**\s*(customer|cliente|customer input|customer message|user message|mensaje del cliente|mensaje)\s*:/i,
		/^\**\s*(status|estado|context|contexto|history|historial)\s*:/i,
		/^\**\s*(goal|objetivo|tone|tono|reasoning|razonamiento|analysis|análisis|self[- ]correction|check|constraint check)\s*:/i,
		/^\**\s*(greet|saludar|introduce|presentar|ask|preguntar|provide|recommend|recomendar)\b/i,
		/^\**\s*(first contact|no data provided|primer contacto)/i,
		/^\**\s*(paso \d+|step \d+)\b/i,
		/^\s*(yes|no|sí|si)\s*\.?\s*$/i,
		/^\s*[*\-_=#]{2,}\s*$/, // líneas decorativas
		/^\s*[•\-*]\s*(friendly|professional|emojis|spanish|max\s*\d+\s*words)/i,
		/^\s*max\s*\d+\s*(words|palabras)/i,
		/^\s*\?+\s*$/,
	];

	const lines = text.split('\n');
	const kept: string[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (!t) {
			kept.push('');
			continue;
		}
		// Línea que SOLO contiene viñetas/asteriscos sin texto real
		if (/^[\s*•\-#=_]+$/.test(t)) continue;
		// Línea que parece un encabezado de razonamiento
		if (skipPatterns.some((p) => p.test(t))) continue;
		// Quitar viñetas iniciales (* - •) pero mantener el contenido
		const stripped = line.replace(/^\s*[*•\-]\s+/, '');
		kept.push(stripped);
	}

	let cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();

	// 5. Eliminar TODO asterisco residual (Gemma los usa para *énfasis* y como bullets)
	cleaned = cleaned.replace(/\*+/g, '').trim();

	// 6. Si la respuesta aparece duplicada al final (problema observado),
	//    tomar solo la primera versión.
	//    Detecta: "TEXTOTEXTO" donde TEXTO termina con signo de puntuación.
	const dupMatch = cleaned.match(/^(.+?[.!?])\s*\1\s*$/s);
	if (dupMatch) cleaned = dupMatch[1].trim();

	// 7. Si quedó vacío, último recurso: el texto original sin asteriscos ni
	//    líneas con ":"  al inicio.
	if (cleaned.length < 15) {
		cleaned = raw
			.split('\n')
			.filter((l) => !/^\s*\**\s*[A-Za-zÁÉÍÓÚáéíóúñÑ ]{2,30}\s*:/.test(l))
			.join('\n')
			.replace(/\*+/g, '')
			.trim();
	}

	return cleaned;
}

// ─── Constructor de prompt few-shot (Gemma-friendly) ─────────────────────────
//
// Clave: en lugar de listar "reglas" (que Gemma trata como instrucciones a
// procesar y razonar), mostramos EJEMPLOS de mensaje del cliente → respuesta
// del asistente. Gemma imita ejemplos mucho mejor que sigue reglas.

interface FewShotExample {
	cliente: string;
	asistente: string;
}

function buildGemmaPrompt(opts: {
	rol: string;
	datos?: string;
	ejemplos: FewShotExample[];
	historial: string;
	mensajeCliente: string;
}): { system: string; user: string } {
	const ejemplosTexto = opts.ejemplos
		.map(
			(e) =>
				`Cliente: ${e.cliente}\nAsistente: ${e.asistente}`
		)
		.join('\n\n');

	const system = `${opts.rol}

${opts.datos ? `INFORMACIÓN DE REFERENCIA:\n${opts.datos}\n\n` : ''}A continuación verás ejemplos de cómo respondes. Tu respuesta debe imitar EXACTAMENTE este estilo: directa, breve, en español, sin asteriscos, sin encabezados, sin explicar tu razonamiento, sin escribir "Asistente:" ni "Respuesta:".

${ejemplosTexto}`;

	const user = `${opts.historial !== '(primer mensaje del cliente)' ? `Historial:\n${opts.historial}\n\n` : ''}Cliente: ${opts.mensajeCliente}
Asistente:`;

	return { system, user };
}

// ─── AGENTE BIENVENIDA ───────────────────────────────────────────────────────
//
// Maneja saludos, mensajes vagos, "hola", "buenos días", "info", etc.
// NO usa el modelo — responde con plantillas determinísticas, porque para
// un saludo no hay razón de gastar un LLM y queremos respuesta instantánea
// y predecible.

export class BienvenidaAgent implements IAgent {
	name = 'Bienvenida';

	async handle(message: string, _context: any): Promise<AgentResponse> {
		const hora = new Date().getHours();
		let saludo = 'Hola';
		if (hora >= 5 && hora < 12) saludo = 'Buenos días';
		else if (hora >= 12 && hora < 19) saludo = 'Buenas tardes';
		else saludo = 'Buenas noches';

		const response = `${saludo}, bienvenido(a) a Electrodomésticos JLC. 😊 ¿En qué puedo ayudarte hoy? Puedes preguntarme por:

• Compra o cotización de electrodomésticos
• Repuestos
• Servicio técnico
• Medios de pago
• Distribuidores
• Vacantes`;

		return {
			response,
			metadata: { agentType: 'bienvenida' },
		};
	}
}

// ─── AGENTE VENTAS ───────────────────────────────────────────────────────────

export class VentasAgent implements IAgent {
	name = 'Ventas';

	async handle(message: string, context: any): Promise<AgentResponse> {
		let productList = '';
		try {
			const products = await wooCommerceService.searchProducts(message, 4);
			productList = wooCommerceService.formatProductList(products);
		} catch {
			productList = 'Catálogo no disponible en este momento.';
		}

		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asesor comercial de Electrodomésticos JLC. Atiendes clientes que quieren comprar o cotizar electrodomésticos. Hablas en español de Colombia, eres cordial, breve y directo.',
			datos: `Cierre de ventas: Cristina, WhatsApp +57 318 740 8190.
Compra al detal: contado o crédito.
Compra al por mayor: se atiende por el área de distribuidores.
Zona Putumayo tiene asesor dedicado.
Sitio web: https://jlc-electronics.com/

Productos relacionados con la consulta:
${productList || 'Sin coincidencias.'}`,
			ejemplos: [
				{
					cliente: 'Quiero saber el precio de una nevera',
					asistente:
						'¡Con gusto! Para darte el precio exacto, ¿desde qué ciudad escribes y qué tipo de nevera buscas (capacidad o marca)? También, ¿la compra sería al contado o a crédito?',
				},
				{
					cliente: 'Me interesa una lavadora LG de 18 kilos',
					asistente:
						'¡Excelente elección! ¿La compra sería al contado o a crédito? Y cuéntame desde qué ciudad escribes para confirmar disponibilidad.',
				},
				{
					cliente: 'A crédito por favor',
					asistente:
						'Perfecto. Para iniciar el estudio de crédito necesito tres datos: tu nombre completo, número de cédula e ingresos mensuales. Luego Cristina (+57 318 740 8190) continúa la gestión.',
				},
				{
					cliente: 'Al contado',
					asistente:
						'¡Genial! Confírmame el modelo exacto que te interesa y tu ciudad, y te paso precio y disponibilidad. Después te conecto con Cristina (+57 318 740 8190) para finalizar la compra.',
				},

			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			nextStage: 'PROPOSAL',
			metadata: { agentType: 'ventas' },
		};
	}
}

// ─── AGENTE CARTERA ──────────────────────────────────────────────────────────

export class CarteraAgent implements IAgent {
	name = 'Cartera';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de cartera de Electrodomésticos JLC. Desde este chat no se accede a información personal de cartera, por lo que tu trabajo es redirigir amablemente al cliente a los canales oficiales.',
			datos: `WhatsApp cartera: +57 314 422 9949 y +57 315 721 2367
Línea telefónica: +57 320 788 1108 (horario 12:30 p.m. a 2:30 p.m.)
Correo para peticiones: callcenter5@electromillonaria.co`,
			ejemplos: [
				{
					cliente: '¿Cuánto debo de mi crédito?',
					asistente:
						'Desde esta línea no puedo acceder a tu información personal. Por favor comunícate con nuestra área de cartera al WhatsApp +57 314 422 9949 o +57 315 721 2367 y con gusto te dan el detalle.',
				},
				{
					cliente: 'Ya pagué la cuota, ¿dónde envío el soporte?',
					asistente:
						'¡Gracias por avisar! Envía tu soporte de pago al WhatsApp de cartera: +57 314 422 9949 o +57 315 721 2367. Allí lo registran y te confirman.',
				},
				{
					cliente: 'Estoy atrasado, no puedo pagar este mes',
					asistente:
						'Entiendo tu situación. Te invito a comunicarte con cartera al +57 314 422 9949 para revisar opciones de reestructuración. También puedes llamar al +57 320 788 1108 entre 12:30 y 2:30 p.m.',
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

// ─── AGENTE SERVICIO TÉCNICO ─────────────────────────────────────────────────

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de servicio técnico de Electrodomésticos JLC. Atiendes clientes con electrodomésticos dañados, mantenimiento o fallas.',
			datos: `Servicio Técnico JLC: +57 320 788 1151
Servicio Técnico JLC (Diego): +57 320 788 1110
Sitio web: https://jlc-electronics.com/servicio-tecnico/
Horario: lunes a sábado, 8:00 a.m. a 5:00 p.m.`,
			ejemplos: [
				{
					cliente: 'Mi lavadora no centrifuga',
					asistente:
						'Lamento la falla. ¿Me indicas la marca, modelo y, si lo sabes, el año de tu lavadora? Con esos datos te orientamos mejor o agendamos la revisión.',
				},
				{
					cliente: 'Necesito mantenimiento para mi nevera Mabe',
					asistente:
						'¡Con gusto! ¿Me confirmas el modelo y el año aproximado de la nevera? Luego puedes escribir directamente al técnico al +57 320 788 1151 para agendar (lunes a sábado, 8 a.m. a 5 p.m.).',
				},
				{
					cliente: 'Es una nevera LG modelo GT44, no enfría',
					asistente:
						'Gracias por los datos. Por favor escribe al WhatsApp de servicio técnico +57 320 788 1151 o +57 320 788 1110 (Diego) para agendar la visita. Atienden lunes a sábado de 8 a.m. a 5 p.m.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'servicio_tecnico' },
		};
	}
}

// ─── AGENTE REPUESTOS ────────────────────────────────────────────────────────

export class RepuestosAgent implements IAgent {
	name = 'Repuestos';

	async handle(message: string, context: any): Promise<AgentResponse> {
		let productInfo = '';
		try {
			const products = await wooCommerceService.searchProducts(message + ' repuesto', 3);
			if (products.length > 0) {
				productInfo = wooCommerceService.formatProductList(products);
			}
		} catch {
			// continuar sin catálogo
		}

		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de repuestos de Electrodomésticos JLC. Ayudas al cliente a encontrar el repuesto, precio y disponibilidad.',
			datos: `Si no hay stock, el tiempo de pedido es 3 a 5 días hábiles.
Sitio web: https://jlc-electronics.com/

Repuestos relacionados:
${productInfo || 'Sin coincidencias.'}`,
			ejemplos: [
				{
					cliente: 'Necesito un filtro para nevera',
					asistente:
						'¡Con gusto te ayudo! ¿Me indicas marca, modelo y año de la nevera? Así confirmo el repuesto exacto y la disponibilidad.',
				},
				{
					cliente: 'Es una nevera Mabe modelo RMA250',
					asistente:
						'Gracias. Voy a revisar disponibilidad del filtro para Mabe RMA250. Si tenemos stock te paso el precio; si no, el pedido tarda entre 3 y 5 días hábiles. ¿Te lo reservo?',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'repuestos' },
		};
	}
}

// ─── AGENTE VACANTES ─────────────────────────────────────────────────────────

export class VacantesAgent implements IAgent {
	name = 'Vacantes';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de recursos humanos de Electrodomésticos JLC. Atiendes a personas interesadas en trabajar en la empresa.',
			datos: `Actualmente no hay listado de vacantes cargado en el sistema.
El interesado puede dejar sus datos para quedar en base de datos.
Datos a recolectar: nombre completo, cargo de interés, ciudad.`,
			ejemplos: [
				{
					cliente: '¿Tienen vacantes?',
					asistente:
						'¡Gracias por tu interés en trabajar con nosotros! En este momento no tengo el listado de vacantes vigentes a la mano, pero puedo registrar tu interés. ¿Me compartes tu nombre completo, cargo de interés y ciudad?',
				},
				{
					cliente: 'Soy Carlos Pérez, busco asesor comercial en Cali',
					asistente:
						'¡Excelente, Carlos! Quedas registrado en nuestra base. Si quieres, envía tu hoja de vida para adjuntarla a tu perfil y que el área de RRHH te contacte cuando haya una vacante de asesor comercial en Cali.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'vacantes' },
		};
	}
}

// ─── AGENTE DISTRIBUIDORES ───────────────────────────────────────────────────

export class DistribuidoresAgent implements IAgent {
	name = 'Distribuidores';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente del programa de distribuidores de Electrodomésticos JLC. Atiendes a personas o empresas que quieren ser distribuidores autorizados o comprar al por mayor.',
			datos: `Datos a recolectar (uno o dos por mensaje, no todos de golpe):
1. NIT
2. Nombre o razón social
3. Teléfono
4. Correo electrónico
5. Rango de ventas estimado
6. Departamento
7. Ciudad`,
			ejemplos: [
				{
					cliente: 'Quiero ser distribuidor',
					asistente:
						'¡Bienvenido al programa de distribuidores JLC! Para iniciar el registro, ¿me compartes tu nombre o razón social y la ciudad donde operarías?',
				},
				{
					cliente: 'Soy Comercial XYZ SAS, en Medellín',
					asistente:
						'¡Excelente! Ahora, ¿me indicas tu NIT y un número de contacto para que el equipo de distribuidores te ubique?',
				},
				{
					cliente: 'NIT 901234567, teléfono 3001234567',
					asistente:
						'¡Perfecto! Por último, ¿cuál es tu correo electrónico y un rango aproximado de ventas mensuales estimado? Con esto completamos tu solicitud.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'distribuidores' },
		};
	}
}

// ─── AGENTE MEDIOS DE PAGO ───────────────────────────────────────────────────

export class PagosAgent implements IAgent {
	name = 'Medios de Pago';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const { system, user } = buildGemmaPrompt({
			rol: 'Eres asistente de medios de pago de Electrodomésticos JLC. Ayudas al cliente a saber cómo pagar su compra.',
			datos: `Opciones de pago:
- En línea: el cliente entra a https://jlc-electronics.com/, selecciona el artículo y elige medio de pago al finalizar la compra (PSE, tarjeta, etc.).
- En punto físico: pago directo en la tienda.
- Crédito: lo gestiona Cristina al WhatsApp +57 318 740 8190.`,
			ejemplos: [
				{
					cliente: '¿Cómo puedo pagar?',
					asistente:
						'Tenemos dos formas: 1) En línea entrando a https://jlc-electronics.com/, seleccionas el artículo y eliges medio de pago (PSE, tarjeta, etc.). 2) En el punto físico directamente en la tienda. ¿Cuál te queda más cómoda?',
				},
				{
					cliente: '¿Aceptan tarjeta de crédito?',
					asistente:
						'¡Sí! Al finalizar la compra en https://jlc-electronics.com/ puedes pagar con tarjeta de crédito, débito o PSE. ¿Ya tienes el producto seleccionado?',
				},
				{
					cliente: 'Quiero pagar a crédito',
					asistente:
						'¡Perfecto! El crédito lo gestiona Cristina directamente. Escríbele al WhatsApp +57 318 740 8190 con el producto que te interesa y ella te guía paso a paso.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'pagos' },
		};
	}
}