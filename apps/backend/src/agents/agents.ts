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
	if (!history || history.length === 0) return '';
	return history
		.slice(-6)
		.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
		.join('\n');
}

// ─── Limpiador de respuestas de Gemma ────────────────────────────────────────
//
// Gemma escribe TODO su razonamiento en una sola secuencia continua, sin
// saltos de línea claros. Patrones típicos a eliminar:
//   "User Role: ... Draft 1: ... Draft 2: ... Yes. Yes. Yes. <RESPUESTA>"
//   "<RESPUESTA><RESPUESTA>" (duplicación al final)
//
// Estrategia:
//   1. Detectar marcadores de "respuesta final" y quedarse solo con lo
//      posterior al ÚLTIMO marcador.
//   2. Si hay "Draft N:" en el texto, quedarse con lo posterior al ÚLTIMO
//      "Draft N:" detectado.
//   3. Eliminar duplicación al final (cuando el texto se repite consigo mismo).
//   4. Limpiar asteriscos, encabezados y prefijos residuales.

function cleanResponse(raw: string): string {
	if (!raw) return '';
	let text = raw.trim();

	// 1) Quitar bloques de pensamiento explícitos
	text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	text = text.replace(/```[\s\S]*?```/g, '').trim();

	// 2) Cortar después del último marcador de "Draft N:"
	//    Esto deja TODO lo que vino después del último borrador, que suele
	//    ser la respuesta final (a veces duplicada).
	const draftMatches = [...text.matchAll(/draft\s*\d+\s*:?\s*/gi)];
	if (draftMatches.length > 0) {
		const last = draftMatches[draftMatches.length - 1];
		text = text.slice(last.index! + last[0].length).trim();
	}

	// 3) Cortar después del último marcador estilo "Respuesta final:",
	//    "Final answer:", "Asistente:", "Output:", "Mensaje al cliente:"
	const finalMarkerRe = /(?:respuesta\s*final|final\s*answer|final\s*draft|borrador\s*final|mensaje\s*al\s*cliente|respuesta\s*al\s*cliente|asistente|assistant|output)\s*:\s*/gi;
	const finalMatches = [...text.matchAll(finalMarkerRe)];
	if (finalMatches.length > 0) {
		const last = finalMatches[finalMatches.length - 1];
		text = text.slice(last.index! + last[0].length).trim();
	}

	// 4) Cortar checklists tipo "Brief? Yes. Direct? Yes. Colombian Spanish? Yes."
	//    Hacemos dos pasadas: primero la lista completa, luego fragmentos sueltos
	//    como `"? Yes.` o `Asistente"? Yes.` que quedan al inicio.
	text = text.replace(
		/((?:[A-ZÁÉÍÓÚÑa-záéíóúñ"][\wáéíóúñÁÉÍÓÚÑ "]*\?\s*(?:Yes|No|Sí|Si)\.?\s*){2,})/gi,
		''
	);
	// Pasada 2: fragmento residual al inicio del texto
	text = text.replace(
		/^[\s"']*[\wáéíóúñÁÉÍÓÚÑ "':]*\?\s*(?:Yes|No|Sí|Si)\.?\s*/i,
		''
	).trim();

	// 5) Cortar listas de "User Role:", "Client Goal:", "Reference Info:",
	//    "Context:", "Style:", "Customer's current request:", etc.
	//    Buscamos el ÚLTIMO punto que termina una de estas etiquetas y
	//    cortamos todo lo anterior.
	const labelRe = /(?:^|[\s.])(?:user role|client goal|customer goal|customer's current request|customer current request|context(?:\s+from\s+previous\s+examples)?|reference info|style|i need to know|the customer is interested|the draft|following the examples)\s*:?/gi;
	const labelMatches = [...text.matchAll(labelRe)];
	if (labelMatches.length > 0) {
		// Buscar el último "." que viene DESPUÉS del último label
		const lastLabel = labelMatches[labelMatches.length - 1];
		const afterLabel = text.slice(lastLabel.index! + lastLabel[0].length);
		// El primer punto+espacio+mayúscula después indica fin de esa sección
		const endOfLabel = afterLabel.search(/[.!?]\s+[¡¿"]?[A-ZÁÉÍÓÚÑ]/);
		if (endOfLabel >= 0) {
			text = afterLabel.slice(endOfLabel + 1).trim();
		}
	}

	// 6) Quitar prefijos comunes al inicio
	text = text.replace(
		/^\s*(?:asistente|assistant|respuesta|response|output|mensaje al cliente)\s*:\s*/i,
		''
	).trim();

	// 7) Quitar todos los asteriscos
	text = text.replace(/\*+/g, '').trim();

	// 8) Quitar líneas que sean solo encabezados (por si quedaron)
	const skipLine = [
		/^\s*(user role|client goal|customer goal|reference info|context|style|status|task|role|company data|protocol|constraints|output|customer|cliente|user|asistente|assistant|goal|tone|workflow|catalog|format)\s*:/i,
		/^\s*paso\s*\d+\s*:/i,
		/^\s*step\s*\d+\s*:/i,
		/^\s*[•\-]\s*(friendly|professional|emojis|spanish|max\s*\d+\s*words)/i,
		/^\s*max\s*\d+\s*(words|palabras)/i,
		/^\s*(yes|no|sí|si)\s*\.?\s*$/i,
		/^[\s_=#]{2,}$/,
	];
	text = text
		.split('\n')
		.filter((l) => {
			const t = l.trim();
			if (!t) return true;
			return !skipLine.some((p) => p.test(t));
		})
		.join('\n')
		.trim();

	// 9) Quitar duplicación al final.
	//    Caso A: "TEXTO TEXTO" (mismo string duplicado exacto)
	const fullDup = text.match(/^([\s\S]+?)\s*\1\s*$/);
	if (fullDup && fullDup[1].length > 30) {
		text = fullDup[1].trim();
	} else {
		// Caso B: las dos mitades son casi iguales (con leves diferencias
		// de puntuación). Usamos dedupeTail.
		text = dedupeTail(text);
	}

	// 9b) Deduplicación por oraciones: si el texto se puede partir por
	//     "¡" o ". " y la primera mitad es muy parecida a la segunda,
	//     quedarse con una. Esto atrapa casos donde Gemma escribe la
	//     respuesta dos veces seguidas con ligeras variaciones.
	text = dedupeBySentence(text);

	// 10) Compactar espacios
	text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

	return text;
}

// Detecta duplicación al final.
// Estrategia: busca la posición P tal que text[0..P] y text[P..end] son casi
// iguales (tolerando pequeñas variaciones de puntuación / espacios).
// Si la encuentra, devuelve text[0..P].
function dedupeTail(text: string): string {
	const len = text.length;
	if (len < 60) return text;

	// Buscar el inicio de una posible repetición.
	// La señal más clara: "¡" o letra mayúscula tras un signo de cierre (.!?)
	// o pegada a una letra minúscula seguida de mayúscula sin espacio.
	const candidatePositions: number[] = [];
	for (let i = Math.floor(len * 0.3); i < len * 0.7; i++) {
		const ch = text[i];
		const prev = text[i - 1];
		// "¡" o "¿" interior (señal fuerte de inicio de oración)
		if ((ch === '¡' || ch === '¿') && i > 30) {
			candidatePositions.push(i);
		}
		// Mayúscula precedida por puntuación de cierre sin espacio
		else if (
			/[A-ZÁÉÍÓÚÑ]/.test(ch) &&
			/[.!?]/.test(prev || '')
		) {
			candidatePositions.push(i);
		}
	}

	for (const p of candidatePositions) {
		const first = text.slice(0, p).trim();
		const second = text.slice(p).trim();
		if (first.length < 30 || second.length < 30) continue;

		const a = normalizeForCompare(first);
		const b = normalizeForCompare(second);
		const minLen = Math.min(a.length, b.length);
		const maxLen = Math.max(a.length, b.length);
		if (maxLen === 0) continue;

		// Casi iguales (≥90% del más largo coincide)
		if (minLen / maxLen > 0.9) {
			let diff = maxLen - minLen;
			for (let i = 0; i < minLen; i++) {
				if (a[i] !== b[i]) diff++;
				if (diff / maxLen > 0.1) break;
			}
			if (diff / maxLen <= 0.1) {
				return first;
			}
		}
	}

	return text;
}

function normalizeForCompare(s: string): string {
	return s
		.toLowerCase()
		.replace(/[¡¿!?,.;:"'()\s]+/g, ' ')
		.trim();
}

// Detecta cuando el texto contiene dos versiones casi idénticas de la misma
// respuesta (típico de Gemma: escribe el "Draft 2" y luego repite la versión
// "final" con cambios mínimos). Parte por "¡" o por oración completa y compara.
function dedupeBySentence(text: string): string {
	if (text.length < 60) return text;

	// Partir por marcadores de inicio de oración: ¡, ¿, o ". A" (mayúscula tras punto)
	const parts = text.split(/(?=¡[A-ZÁÉÍÓÚÑ])|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/);
	if (parts.length < 2) return text;

	// Si la primera mitad de partes es muy parecida a la segunda, quedarse con
	// la primera mitad.
	const mid = Math.floor(parts.length / 2);
	const firstHalf = parts.slice(0, mid).join(' ').trim();
	const secondHalf = parts.slice(mid).join(' ').trim();

	if (firstHalf.length > 30 && secondHalf.length > 30) {
		const a = normalizeForCompare(firstHalf);
		const b = normalizeForCompare(secondHalf);
		const minLen = Math.min(a.length, b.length);
		const maxLen = Math.max(a.length, b.length);
		if (maxLen > 0 && minLen / maxLen > 0.85) {
			// Calcular diferencias carácter por carácter
			let diff = 0;
			for (let i = 0; i < minLen; i++) {
				if (a[i] !== b[i]) diff++;
			}
			diff += maxLen - minLen;
			if (diff / maxLen < 0.1) {
				return firstHalf;
			}
		}
	}

	// También: dos oraciones consecutivas casi idénticas
	for (let i = 0; i < parts.length - 1; i++) {
		const a = normalizeForCompare(parts[i]);
		const b = normalizeForCompare(parts[i + 1]);
		if (a.length > 30 && b.length > 30) {
			const minLen = Math.min(a.length, b.length);
			const maxLen = Math.max(a.length, b.length);
			if (minLen / maxLen > 0.85) {
				let diff = Math.abs(a.length - b.length);
				for (let j = 0; j < minLen; j++) {
					if (a[j] !== b[j]) diff++;
				}
				if (diff / maxLen < 0.1) {
					// Quitar la copia (i+1)
					const newParts = [...parts.slice(0, i + 1), ...parts.slice(i + 2)];
					return newParts.join(' ').trim();
				}
			}
		}
	}

	return text;
}

// ─── Constructor de prompt estilo "conversación continua" ────────────────────
//
// CLAVE: en vez de un system prompt con secciones (que Gemma reescribe), le
// damos UN ÚNICO bloque tipo conversación que termina en "Asistente:" — esto
// hace que Gemma simplemente continúe el último turno del asistente, sin
// razonar en voz alta.

interface FewShotExample {
	cliente: string;
	asistente: string;
}

function buildGemmaPrompt(opts: {
	instruccion: string;
	ejemplos: FewShotExample[];
	historial: string;
	mensajeCliente: string;
}): { system: string; user: string } {
	// system: rol mínimo + nota de formato
	const system = `${opts.instruccion} Responde en español natural, en una o dos frases breves, sin asteriscos, sin encabezados, sin etiquetas, sin explicar tu razonamiento. IMPORTANTE: Responde SOLO el mensaje al cliente.`;

	// user: conversación continua con ejemplos + historial + mensaje actual
	const ejemplosTexto = opts.ejemplos
		.map((e) => `Cliente: ${e.cliente}\nAsistente: ${e.asistente}`)
		.join('\n\n');

	const historialTexto = opts.historial ? `${opts.historial}\n` : '';

	const user = `${ejemplosTexto}\n\n---\n\n${historialTexto}Cliente: ${opts.mensajeCliente}\nAsistente:`;

	return { system, user };
}

// ─── AGENTE BIENVENIDA (sin LLM) ─────────────────────────────────────────────

export class BienvenidaAgent implements IAgent {
	name = 'Bienvenida';

	async handle(_message: string, _context: any): Promise<AgentResponse> {
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
			productList = '';
		}

		const datos = `Cierre de ventas: Cristina, WhatsApp +57 318 740 8190. Compra al detal: contado o crédito. Compra al por mayor: área de distribuidores. Zona Putumayo tiene asesor dedicado. Sitio web: https://jlc-electronics.com/.${productList ? ` Productos relacionados: ${productList}` : ''}`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asesor comercial de Electrodomésticos JLC, cordial y breve, hablas español de Colombia. Datos que puedes usar: ${datos}`,
			ejemplos: [
				{
					cliente: 'Quiero saber el precio de una nevera',
					asistente:
						'¡Con gusto! Para darte el precio exacto, ¿desde qué ciudad escribes y qué tipo de nevera buscas (capacidad o marca)? ¿La compra sería al contado o a crédito?',
				},
				{
					cliente: 'que productos tienen disponibles',
					asistente:
						'Manejamos neveras, congeladores, lavadoras, televisores, y más. Puedes ver el catálogo en https://jlc-electronics.com/. ¿Buscas algo en particular para confirmarte disponibilidad?',
				},
				{
					cliente: 'congeladores',
					asistente:
						'¡Sí, tenemos congeladores! ¿Desde qué ciudad escribes y qué capacidad necesitas (en litros)? ¿Lo pagarías de contado o a crédito?',
				},
				{
					cliente: 'A crédito por favor',
					asistente:
						'Perfecto. Para iniciar el estudio de crédito necesito tres datos: tu nombre completo, número de cédula e ingresos mensuales. Luego Cristina (+57 318 740 8190) continúa la gestión.',
				},
				{
					cliente: 'Al contado',
					asistente:
						'¡Genial! Confírmame el modelo exacto y tu ciudad, y te paso precio y disponibilidad. Después te conecto con Cristina (+57 318 740 8190) para finalizar la compra.',
				},
				{
					cliente: 'Soy de Mocoa, Putumayo',
					asistente:
						'¡Bienvenido! Para Putumayo tenemos asesor dedicado. Cuéntame qué producto buscas y te paso el contacto directo del asesor de tu zona.',
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
		const datos = `Desde este chat no se accede a información personal del cliente. Canales oficiales: WhatsApp cartera +57 314 422 9949 y +57 315 721 2367. Línea telefónica +57 320 788 1108 (horario 12:30 p.m. a 2:30 p.m.). Correo para peticiones con soportes: callcenter5@electromillonaria.co.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de cartera de Electrodomésticos JLC. Tu rol es redirigir amablemente al cliente a los canales oficiales. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Cuánto debo de mi crédito?',
					asistente:
						'Desde esta línea no puedo acceder a tu información personal. Comunícate con cartera al WhatsApp +57 314 422 9949 o +57 315 721 2367 y con gusto te dan el detalle.',
				},
				{
					cliente: 'Ya pagué la cuota, ¿dónde envío el soporte?',
					asistente:
						'¡Gracias por avisar! Envía tu soporte de pago al WhatsApp de cartera: +57 314 422 9949 o +57 315 721 2367. Allí lo registran y te confirman.',
				},
				{
					cliente: 'Estoy atrasado, no puedo pagar este mes',
					asistente:
						'Entiendo. Te invito a comunicarte con cartera al +57 314 422 9949 para revisar opciones de reestructuración. También puedes llamar al +57 320 788 1108 entre 12:30 y 2:30 p.m.',
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
		const datos = `Servicio Técnico JLC: +57 320 788 1151. Servicio Técnico JLC (Diego): +57 320 788 1110. Web: https://jlc-electronics.com/servicio-tecnico/. Horario: lunes a sábado, 8:00 a.m. a 5:00 p.m.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de servicio técnico de Electrodomésticos JLC para clientes con electrodomésticos dañados o que necesitan mantenimiento. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: 'Mi lavadora no centrifuga',
					asistente:
						'Lamento la falla. ¿Me indicas la marca, modelo y, si lo sabes, el año de tu lavadora? Con esos datos te orientamos o agendamos la revisión.',
				},
				{
					cliente: 'Necesito mantenimiento para mi nevera Mabe',
					asistente:
						'¡Con gusto! ¿Me confirmas el modelo y el año aproximado? Luego puedes escribir al técnico al +57 320 788 1151 para agendar (lunes a sábado, 8 a.m. a 5 p.m.).',
				},
				{
					cliente: 'Es una nevera LG modelo GT44, no enfría',
					asistente:
						'Gracias por los datos. Escribe al WhatsApp +57 320 788 1151 o +57 320 788 1110 (Diego) para agendar la visita. Atienden lunes a sábado de 8 a.m. a 5 p.m.',
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

// ─── AGENTE REPUESTOS (corregir)────────────────────────────────────────────────────────

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

		const datos = `Sin stock: tiempo de pedido 3 a 5 días hábiles. Web: https://jlc-electronics.com/.${productInfo ? ` Repuestos relacionados: ${productInfo}` : ''}`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de repuestos de Electrodomésticos JLC. Ayudas a encontrar repuestos, precio y disponibilidad. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: 'Necesito un filtro para nevera',
					asistente:
						'¡Con gusto te ayudo! ¿Me indicas marca, modelo y año de la nevera? Así confirmo el repuesto exacto y la disponibilidad.',
				},
				{
					cliente: 'Es una nevera Mabe modelo RMA250',
					asistente:
						'Gracias. Voy a revisar disponibilidad del filtro para Mabe RMA250. Si hay stock te paso el precio; si no, el pedido tarda entre 3 y 5 días hábiles. ¿Te lo reservo?',
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
		const datos = `No hay listado de vacantes cargado actualmente. El interesado deja sus datos para quedar en base de datos: nombre completo, cargo de interés, ciudad. Puede enviar hoja de vida.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de recursos humanos de Electrodomésticos JLC. Atiendes a personas interesadas en trabajar en la empresa. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Tienen vacantes?',
					asistente:
						'¡Gracias por tu interés en trabajar con nosotros! En este momento no tengo el listado de vacantes a la mano, pero puedo registrar tu interés. ¿Me compartes tu nombre completo, cargo de interés y ciudad?',
				},
				{
					cliente: 'Soy Carlos Pérez, busco asesor comercial en Cali',
					asistente:
						'¡Excelente, Carlos! Quedas registrado. Si quieres, envía tu hoja de vida para adjuntarla a tu perfil y que RRHH te contacte cuando haya una vacante de asesor comercial en Cali.',
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
		const datos = `Datos a recolectar paso a paso: 1. NIT, 2. Nombre o razón social, 3. Teléfono, 4. Correo, 5. Rango de ventas estimado, 6. Departamento, 7. Ciudad. Pedir uno o dos por mensaje, no todos de golpe.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente del programa de distribuidores de Electrodomésticos JLC. Atiendes a interesados en ser distribuidores autorizados. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: 'Quiero ser distribuidor',
					asistente:
						'¡Bienvenido al programa de distribuidores JLC! Para iniciar el registro, ¿me compartes tu nombre o razón social y la ciudad donde operarías?',
				},
				{
					cliente: 'Soy Comercial XYZ SAS, en Medellín',
					asistente:
						'¡Excelente! Ahora, ¿me indicas tu NIT y un número de contacto?',
				},
				{
					cliente: 'NIT 901234567, teléfono 3001234567',
					asistente:
						'¡Perfecto! Por último, ¿cuál es tu correo electrónico y un rango aproximado de ventas mensuales? Con esto completamos tu solicitud.',
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
		const datos = `Opciones de pago: 1) En línea desde https://jlc-electronics.com/ (PSE, tarjeta, etc.). 2) En punto físico. 3) Crédito lo gestiona Cristina al WhatsApp +57 318 740 8190.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de medios de pago de Electrodomésticos JLC. Ayudas al cliente a saber cómo pagar. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Cómo puedo pagar?',
					asistente:
						'Tienes dos opciones: 1) En línea en https://jlc-electronics.com/ con PSE, tarjeta de crédito o débito. 2) En punto físico directamente en la tienda. ¿Cuál prefieres?',
				},
				{
					cliente: '¿Aceptan tarjeta de crédito?',
					asistente:
						'¡Sí! Al finalizar la compra en https://jlc-electronics.com/ puedes pagar con tarjeta de crédito, débito o PSE. ¿Ya tienes el producto seleccionado?',
				},
				{
					cliente: 'Quiero pagar a crédito',
					asistente:
						'¡Perfecto! El crédito lo gestiona Cristina. Escríbele al WhatsApp +57 318 740 8190 con el producto que te interesa y ella te guía paso a paso.',
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