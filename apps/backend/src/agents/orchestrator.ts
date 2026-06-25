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
import { generateResponse, generateMultimodalResponse } from '../utils/gemini.js';
import { cleanResponse } from './helpers.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';
import fs from 'fs/promises';
import path from 'path';

function safeMediaPath(fileName: string): string | null {
	const base = path.basename(fileName);
	if (base !== fileName || base.includes('..')) return null;
	return path.join(process.cwd(), 'media', base);
}

function sanitizarNumeros(texto: string): string {
	const AUTORIZADO = '3187408190';
	const patron = /(\+?57[\s-]*)?\b3\d{2}[\s-]*\d{3}[\s-]*\d{4}\b/g;
	return texto.replace(patron, (match) => {
		const soloDigitos = match.replace(/\D/g, '').replace(/^57/, '');
		if (soloDigitos === AUTORIZADO) return match;
		return '+57 318 740 8190';
	});
}

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

	/**
	 * Versión pública estricta: solo detecta saludos EXPLÍCITOS, sin el catch-all de < 5 chars.
	 * Usado por message.handler.ts para detectar nuevas sesiones sin falsos positivos.
	 */
	public esSaludo(message: string): boolean {
		return this.revisarPatronesSaludo(message, true);
	}

	private isGreetingOrVague(message: string, hasHistory: boolean): boolean {
		// Si ya hay historial, no es saludo inicial: dejamos que el clasificador decida.
		if (hasHistory) return false;

		return this.revisarPatronesSaludo(message, false);
	}

	/**
	 * Lógica central de detección de saludos/mensajes vagos.
	 * @param strict true = solo saludos explícitos (para nueva sesión), false = incluye catch-all < 5 chars (para primer mensaje)
	 */
	private revisarPatronesSaludo(message: string, strict: boolean): boolean {
		const m = message.toLowerCase().normalize('NFC').trim();

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
		];

		// Limpiar puntuación final para comparar
		const cleaned = m.replace(/[.,!?¡¿…]+$/g, '').trim();
		if (greetings.includes(cleaned)) return true;

		// En modo estricto: detectar saludos compuestos ("hola, buenas tardes", "holi, buenas noches")
		if (strict) {
			const parts = cleaned.split(/[,;]\s*/).map(p => p.trim()).filter(p => p.length > 0);
			if (parts.length > 1 && parts.every(p => greetings.includes(p))) return true;
		}

		// En modo NO estricto (primer mensaje, sin historial):
		//   - Saludos con coma o algo después corto
		//   - Patrones de presentación: "me llamo...", "soy...", etc.
		//   - Catch-all para mensajes muy cortos (< 5 chars) sin intención clara
		if (!strict) {
			const firstWord = cleaned.split(/[\s,]+/)[0];
			if (greetings.includes(firstWord) && cleaned.length < 30) return true;

			const presentationPatterns = [
				/^me\s+llamo/i, /^soy\s+[a-z]/i, /^mi\s+nombre/i,
				/^vengo\s+por/i, /^quisiera\s+info/i, /^busco\s+info/i,
			];
			for (const pattern of presentationPatterns) {
				if (pattern.test(cleaned) && cleaned.length < 40) return true;
			}

			// Muy corto y sin palabras clave de intención
			if (cleaned.length < 5) return true;
		}

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
		const m = message.toLowerCase().normalize('NFC');

		if (/\b(distribuidor|distribuidores|ser distribuidor|al por mayor|mayorista|mayoreo)\b/.test(m)) {
			return 'distribuidores';
		}
		if (/\b(vacante|empleo|trabajo|hoja de vida|cv|curriculum|currículum|aplicar a|aplicar al)\b/.test(m)) {
			return 'vacantes';
		}
		if (/\b(servicio t[eé]cnico|reparaci[oó]n|reparar|mantenimiento|no enciende|no funciona|no enfr[ií]a|no centrifuga|da[ñn]ado|da[ñn]ada|falla|aver[ií]a|garant[ií]a|cambio|reembolso|devoluci[oó]n|reclamaci[oó]n|t[eé]cnico\s+a\s+casa|mandar\s+t[eé]cnico)\b/.test(m)) {
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
		if (/\b(comprar|cotizar|cotizaci[oó]n|precio|cu[aá]nto cuesta|cu[aá]nto vale|televisor|televisores|tv|nevera|neveras|nevecones?|lavadora|lavadoras|congeladores?|exhibidores?|minibar|freidora|freidoras|horno|hornos|licuadora|licuadoras|cafeteras?|hervidor|ventiladores?|cocina|parlante|parlantes|sonido|audio|video|refrigeraci[oó]n|electrodom[eé]stico|electrodom[eé]sticos|contado|cr[eé]dito|financiar|cuotas|profesional|profesionales|tuber[ií]a|tuber[ií]as|calidad|garant[ií]a|negocio|pqr|pqrs|queja|reclamo|radicar)\b/.test(m) 
			|| (/\b(?:seguimiento|rastrear|gu[ií]a|tracking)\b/i.test(m) && /\b(?:compra|pedido|producto|env[ií]o)\b/i.test(m))
			|| /\b(?:ya\s+(?:compr[éeó]|pagu[éeó]|cancel[éeó]|complet[éeó])|compr[ée]\s+por\s+(?:internet|web|p[aá]gina|online|l[íi]nea)|(?:la|mi|una)\s+compra\s+(?:la|lo|las|los)\s+(?:realic[ée]|hice|compr[ée]|pag[ué])|hice\s+(?:una|mi|la)\s+(?:compra|pedido|pago|transferencia)|realic[ée]\s+(?:una|mi|la)\s+(?:compra|pedido|pago|transferencia)|adquir[ií]\s+(?:un|una|el|la))\b/i.test(m)) {
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
- "distribuidores" cubre: ser distribuidor, venta al mayor, mayorista. NO clasificar como distribuidores si el cliente dice "para negocio" o "uso comercial" refiriéndose al uso del producto (eso es ventas).
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
	): Promise<{ agentType: string; response: string; metadata?: Record<string, any> }> {
		const hasHistory = Array.isArray(context?.history) && context.history.length > 0 && context?.nuevaSesion !== true;

		// ─── IMAGEN DEL CLIENTE ────────────────────────────────────────────
		// 1) Analiza la imagen → descripción + tipo (producto/comprobante/daño/hoja de vida/otro)
		// 2) Guarda la info para la BD
		// 3) Enruta al agente correcto con el mensaje enriquecido
		if (context?.mediaFileName) {
			const mediaPath = safeMediaPath(context.mediaFileName);
			if (!mediaPath) {
				return {
					agentType: 'ventas',
					response: 'Disculpa, no pude procesar la imagen. ¿Puedes intentar de nuevo? 😊',
					metadata: { flujo: context?.flujo || null, agentType: 'ventas' },
				};
			}
			try {
				const imgBuffer = await fs.readFile(mediaPath);
				const base64 = imgBuffer.toString('base64');
				const mime = context.mediaMimeType || 'image/jpeg';
				const enFlujoPago = ['esperando_comprobante', 'pago_medios', 'pago_web', 'pago_completado', 'seleccion_pago'].includes(context?.flujo);

				// ── PASO 1: Analizar la imagen → JSON estructurado ────────────
				// Una sola llamada de visión que clasifica y describe.
				const systemAnalisis = `Analiza la imagen de un cliente de una tienda de electrodomésticos (JLC Electronics).
Responde SOLO con JSON válido, sin markdown ni texto extra:
{"tipo":"...","descripcion":"...","producto":"...","textoVisible":"..."}

Donde:
- tipo: uno de "comprobante_pago" | "producto" | "producto_dañado" | "hoja_de_vida" | "documento" | "otro"
  * "comprobante_pago": transferencia, recibo, pantallazo de pago, Nequi, PSE, consignación.
  * "producto": foto de un electrodoméstico que el cliente quiere comprar o consultar (nevera, lavadora, TV, vitrina, parlante, etc.).
  * "producto_dañado": electrodoméstico con falla visible, roto, con error en pantalla, o el cliente reporta daño.
  * "hoja_de_vida": CV, currículum.
  * "documento": cédula, factura u otro documento.
  * "otro": cualquier otra cosa.
- descripcion: 1 frase corta de qué muestra la imagen.
- producto: si tipo es "producto" o "producto_dañado", el tipo de electrodoméstico identificado (ej "vitrina refrigerante", "lavadora", "nevera no frost"). Si no aplica, "".
- textoVisible: número de transacción/referencia si es comprobante, o texto relevante visible. Si no hay, "".`;

				let analisis: any = {};
				try {
					const rawAnalisis = await generateMultimodalResponse(
						message === '[Imagen]' ? 'Analiza esta imagen' : message,
						base64, mime, systemAnalisis
					);
					const jsonMatch = rawAnalisis.match(/\{[\s\S]*\}/);
					if (jsonMatch) analisis = JSON.parse(jsonMatch[0]);
				} catch { /* análisis falló, seguir con heurística */ }

				const tipoImg = analisis?.tipo || (enFlujoPago ? 'comprobante_pago' : 'otro');

				// ── PASO 2: COMPROBANTE DE PAGO → cerrar venta ────────────────
				if (tipoImg === 'comprobante_pago' || enFlujoPago) {
					const systemPago = `Eres Sara, asesora de JLC Electronics. El cliente envió un comprobante de pago. Agradécele cálidamente y dile que el pago quedó registrado y que el equipo lo verifica para despachar. Máximo 2 frases, 1 emoji.`;
					const raw = await generateMultimodalResponse('Confirma recepción del comprobante', base64, mime, systemPago);
					const response = sanitizarNumeros(cleanResponse(raw));
					return {
						agentType: 'ventas',
						response,
						metadata: {
							flujo: null,
							agentType: 'ventas',
							notificarComprobante: true,
							pipelineStage: 'VENTA_CERRADA',
							comprobanteRef: analisis?.textoVisible || undefined,
						},
					};
				}

				// ── PASO 3: PRODUCTO DAÑADO → servicio técnico ────────────────
				if (tipoImg === 'producto_dañado') {
					const enriched = `${message === '[Imagen]' ? '' : message + ' '}[El cliente envió una foto de un producto con falla: ${analisis?.descripcion || 'electrodoméstico dañado'}${analisis?.producto ? ` (${analisis.producto})` : ''}]`;
					const result = await this.agents.servicio_tecnico.handle(enriched.trim(), context);
					return {
						agentType: 'servicio_tecnico',
						response: result.response,
						metadata: {
							...result.metadata,
							imagenTipo: 'producto_dañado',
							imagenDescripcion: analisis?.descripcion,
						},
					};
				}

				// ── PASO 4: HOJA DE VIDA → vacantes ───────────────────────────
				if (tipoImg === 'hoja_de_vida') {
					const enriched = `${message === '[Imagen]' ? '' : message + ' '}[El cliente envió su hoja de vida]`;
					const result = await this.agents.vacantes.handle(enriched.trim(), context);
					return {
						agentType: 'vacantes',
						response: result.response,
						metadata: { ...result.metadata, imagenTipo: 'hoja_de_vida' },
					};
				}

				// ── PASO 5: PRODUCTO → ventas con catálogo ────────────────────
				if (tipoImg === 'producto') {
					// Buscar en WooCommerce usando el producto identificado por visión
					let catProducts: any[] = [];
					const terminoBusqueda = analisis?.producto || (message === '[Imagen]' ? 'producto' : message.slice(0, 60));
					try {
						catProducts = await wooCommerceService.searchProducts(terminoBusqueda, 10);
					} catch { /* sin catalogo */ }

					const catalogoStr = catProducts.length > 0
						? catProducts.map((p: any) => `- ${p.name} | $${parseInt(p.price).toLocaleString('es-CO')}`).join('\n')
						: 'No se encontró ese producto en el catálogo.';

					const yaTieneCiudad = !!(context?.ciudad && context?.ciudadValidada);

					const systemDirect = `Eres Sara, asesora de JLC Electronics Colombia, la marca de los colombianos.

ESTILO: mensajes MUY cortos (máximo 2 frases), máximo 1 emoji, tono cálido y femenino. NO te presentes de nuevo ni saludes largo.

El cliente envió una foto de: ${analisis?.descripcion || 'un electrodoméstico'}.
INSTRUCCIONES:
- Nombra el producto usando SOLO el catálogo de abajo. NO inventes precios ni disponibilidad.
- Si no está en el catálogo, dilo con naturalidad y ofrece ayudar a buscar algo similar.
- NUNCA afirmes "envío gratis a toda Colombia"; la cobertura depende de la ciudad.
${yaTieneCiudad
	? `- El cliente está en ${context.ciudad}. Confirma el producto y pregunta si desea continuar con la compra.`
	: `- AÚN no sabemos la ciudad. Confirma el producto y pregunta UNA sola vez: "¿Desde qué ciudad nos escribes?".`}

CATÁLOGO:
${catalogoStr}

Responde corto.`;
					const raw = await generateMultimodalResponse(message, base64, mime, systemDirect);
					const responseText = sanitizarNumeros(cleanResponse(raw));

					const productoDetectado = catProducts[0];
					const metaImg: Record<string, any> = {
						agentType: 'ventas',
						imagenTipo: 'producto',
						imagenDescripcion: analisis?.descripcion,
						...(!productoDetectado ? { productoSolicitado: analisis?.producto || undefined } : {}),
						...(productoDetectado
							? {
								ultimaBusqueda: { results: catProducts.slice(0, 6), categoria: null, productoIndex: 0 },
							}
							: {}),
					};

					if (yaTieneCiudad) {
						metaImg.flujo = context?.flujo || null;
						metaImg.ciudad = context.ciudad;
						metaImg.ciudadValidada = true;
						metaImg.tieneCobertura = context?.tieneCobertura;
					} else {
						metaImg.flujo = 'esperando_ciudad';
					}

					return { agentType: 'ventas', response: responseText, metadata: metaImg };
				}

				// ── PASO 6: OTRO/DOCUMENTO → enriquecer y clasificar normal ──
				// No interceptamos: dejamos que el clasificador decida el agente,
				// pero inyectamos la descripción de la imagen en el mensaje.
				if (analisis?.descripcion) {
					context.imagenDescripcion = analisis.descripcion;
					context.mensajeEnriquecido = `${message === '[Imagen]' ? '' : message + ' '}[Imagen recibida: ${analisis.descripcion}]`.trim();
				}
				// cae al flujo normal de clasificación más abajo
			} catch {
				// Si falla la lectura/análisis, continuar con el flujo normal
			}
		}

		// ─── SALIDA DE EMERGENCIA (ESCAPE HATCH) ───
		// Si el usuario quiere cancelar o cambiar de tema, rompemos cualquier flujo activo
		const esEscape = /\b(?:cancelar|salir|volver|inicio|men[uú]|asesor|humano|otra cosa|ya no|no quiero)\b/i.test(message);
		let flujoActivo = context?.flujo;
		
		if (esEscape) {
			flujoActivo = null; // Romper el bucle
			if (context) context.flujo = null;
		}

		// ─── INTERRUPCIÓN DE FLUJO GUIADO ───
		// Detectar si el usuario hace una pregunta o cambia de tema mientras está en un flujo paso a paso
		let fueInterrumpido = false;
		let flujoOriginal = flujoActivo;
		if (flujoActivo && esInterrupcionFlujo(message, flujoActivo, context)) {
			flujoActivo = null; // Ignorar el flujo por este turno para poder responder la duda del cliente
			fueInterrumpido = true;
		}

		// ─── INTERRUPCIÓN DE FLUJOS PAUSADOS ───
		// Si el usuario ya está en un flujo pausado y escribe algo que no es ni sí ni no directos,
		// tratamos esto como una interrupción. Así el bot responde su pregunta libre con la IA
		// y luego le vuelve a ofrecer retomar el flujo pausado.
		const esPausado = flujoActivo === 'credito_pausado' || flujoActivo === 'pago_pausado' || flujoActivo === 'perfilando_pausado' || flujoActivo === 'esperando_ciudad_pausado' || flujoActivo === 'esperando_modalidad_pausado' || flujoActivo === 'repuestos_pausado';
		if (flujoActivo && esPausado) {
			const lowerMsg = message.toLowerCase().trim();
			const quiereContinuar = /\bs[ií]\b|\bdale\b|\bok\b|\bbueno\b|\bclaro\b|por favor|\bseguir\b|\bcontinuar\b|\breproducir\b/i.test(lowerMsg);
			const quiereCancelar = /\bno\b|cancelar|salir|\bya\s+no\b|\bno\s+quiero\b/i.test(lowerMsg);
			
			if (!quiereContinuar && !quiereCancelar) {
				fueInterrumpido = true;
				if (flujoActivo === 'credito_pausado') {
					flujoOriginal = 'credito';
				} else if (flujoActivo === 'pago_pausado') {
					flujoOriginal = context?.flujoAnterior || 'seleccion_pago';
				} else if (flujoActivo === 'perfilando_pausado') {
					flujoOriginal = 'perfilando';
				} else if (flujoActivo === 'esperando_ciudad_pausado') {
					flujoOriginal = 'esperando_ciudad';
				} else if (flujoActivo === 'esperando_modalidad_pausado') {
					flujoOriginal = 'esperando_modalidad';
				} else if (flujoActivo === 'repuestos_pausado') {
					flujoOriginal = 'repuestos';
				}
				flujoActivo = null;
				if (context) context.flujo = null;
			}
		}

		// Si hay un flujo activo en el contexto, respetar el agente actual
		// para no interrumpir procesos en curso (crédito, repuestos, etc.)
		let intent: IntentKey;

		if (flujoActivo) {
			// Mapear flujo activo al agente correspondiente
			if (/^credito/.test(flujoActivo) || flujoActivo === 'sin_cobertura' || flujoActivo === 'contado_sin_cobertura' || flujoActivo === 'esperando_ciudad' || flujoActivo === 'credito_perfilando' || flujoActivo === 'esperando_modalidad' || flujoActivo === 'perfilando_producto' || flujoActivo === 'perfilando_presupuesto' || flujoActivo === 'perfilando' || flujoActivo === 'seleccion_pago' || flujoActivo === 'seleccion_pago_ambiguo' || flujoActivo === 'pago_web' || flujoActivo === 'pago_web_paso' || flujoActivo === 'pago_medios' || flujoActivo === 'pago_fisico' || flujoActivo === 'pago_completado' || flujoActivo === 'esperando_comprobante' || flujoActivo === 'credito_pausado' || flujoActivo === 'pago_pausado' || flujoActivo === 'perfilando_pausado' || flujoActivo === 'esperando_ciudad_pausado' || flujoActivo === 'esperando_modalidad_pausado') {
				intent = 'ventas';
			} else if (/^repuesto/.test(flujoActivo) || flujoActivo === 'repuestos_pausado') {
				intent = 'repuestos';
			} else if (/^distribuidor/.test(flujoActivo)) {
				intent = 'distribuidores';
			} else {
				// Flujo desconocido → reclasificar normalmente
				intent = await this.classifyIntent(message, hasHistory);
			}
		} else {
			intent = await this.classifyIntent(context?.mensajeEnriquecido || message, hasHistory);

			// ── CORRECCIÓN: Si el intent es 'pagos' pero hay un producto activo
			// en el contexto de ventas, mantener en ventas para que el flujo de
			// pago integrado maneje la transacción (no el agente genérico de pagos).
			if (intent === 'pagos' && context?.ultimaBusqueda?.results?.length > 0 && context?.modalidad === 'contado') {
				intent = 'ventas';
			}
		}

		// Mensaje a usar: si la imagen fue tipo "otro/documento", se enriqueció
		// con la descripción para que el agente clasificado tenga el contexto.
		const mensajeFinal = context?.mensajeEnriquecido || message;

		const agent = this.agents[intent] || this.agents.ventas;
		const result = await agent.handle(mensajeFinal, context);

		let response = result.response;
		let metadata = result.metadata || {};

		// Si fue interrumpido, ofrecer retomar el flujo anterior y guardarlo como pausado
		// Solo si el agente NO inició un flujo nuevo (no pisa metadata.flujo)
		// flujo: null significa que el agente finalizó el flujo intencionalmente, también es cambio
		const agenteYaCambioFlujo = metadata != null && 'flujo' in metadata && metadata.flujo !== flujoOriginal;
		if (fueInterrumpido && flujoOriginal && !agenteYaCambioFlujo) {
			if (/^credito/.test(flujoOriginal)) {
				response += `\n\n¿Seguimos con tu solicitud de crédito? 😊`;
				metadata = {
					...metadata,
					flujo: 'credito_pausado',
					creditoData: context?.creditoData || {},
					creditoStep: context?.creditoStep || 1,
				};
			} else if (flujoOriginal === 'pago_web_paso' || flujoOriginal === 'pago_web' || flujoOriginal === 'seleccion_pago') {
				response += `\n\n¿Continuamos con los pasos de tu pago? 😊`;
				metadata = {
					...metadata,
					flujo: 'pago_pausado',
					flujoAnterior: flujoOriginal,
					productoURL: context?.productoURL || context?.ultimaBusqueda?.results?.[0]?.permalink,
				};
			} else if (flujoOriginal === 'perfilando') {
				response += `\n\n¿En qué más puedo ayudarte? 😊`;
				metadata = {
					...metadata,
					flujo: 'perfilando_pausado',
					perfilState: context?.perfilState,
				};
			} else if (flujoOriginal === 'esperando_ciudad') {
				response += `\n\n¿Me dices desde dónde nos escribes? 😊`;
				metadata = {
					...metadata,
					flujo: 'esperando_ciudad_pausado',
					pendingMessage: context?.pendingMessage || message,
				};
			} else if (flujoOriginal === 'esperando_modalidad') {
				response += `\n\n¿La compra sería contado o crédito? 😊`;
				metadata = {
					...metadata,
					flujo: 'esperando_modalidad_pausado',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				};
			} else if (flujoOriginal === 'seleccion_pago_ambiguo') {
				response += `\n\n¿Continuamos con tu compra? 😊`;
				metadata = {
					...metadata,
					flujo: 'pago_pausado',
					flujoAnterior: 'seleccion_pago_ambiguo',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
					ultimaBusqueda: context?.ultimaBusqueda,
				};
			} else if (flujoOriginal === 'repuestos') {
				response += `\n\n¿Seguimos con tu solicitud de repuestos? 😊`;
				metadata = {
					...metadata,
					flujo: 'repuestos_pausado',
					repuestoData: context?.repuestoData || {},
				};
			}
		}

		return {
			agentType: intent,
			response,
			metadata,
		};
	}
}

/**
 * Detecta si el mensaje actual es una interrupción del flujo guiado (una pregunta o un cambio de tema)
 */
function esInterrupcionFlujo(message: string, flujo: string, context?: any): boolean {
	const msg = message.toLowerCase().normalize('NFC').trim();

	// Exclusiones: respuestas a preguntas específicas del flujo de crédito o pago
	// Si son números cortos, confirmaciones simples o palabras clave esperadas, NO es interrupción
	if (/^\s*\d+\s*$/.test(msg)) return false; // opciones numéricas
	if (/^(?:si|sí|no|ok|vale|listo|entendido|dale|bueno|por favor|gracias)\s*$/i.test(msg)) return false; // respuestas simples

	// Si el flujo espera una ubicación y el usuario menciona una ciudad, no es interrupción
	if (flujo === 'esperando_ciudad' || flujo === 'esperando_ciudad_pausado') {
		if (/(?:desde|soy de|vivo en|estoy en|escribo desde|ubicado en|me encuentro en)\s+[a-záéíóúñü]{3,}/i.test(msg)) {
			return false;
		}
	}

	// Saludos explícitos (no deben interpretarse como respuestas de formulario, sino como interrupción para saludar)
	const greetings = [
		'hola', 'holaa', 'holaaa', 'holi', 'oli', 'ola', 'hello', 'hi', 'hey',
		'buenas', 'buenos dias', 'buenos días', 'buen dia', 'buen día',
		'buenas tardes', 'buenas noches', 'que tal', 'qué tal'
	];
	const cleaned = msg.replace(/[.,!?¡¿…]+$/g, '').trim();
	if (greetings.includes(cleaned)) return true;
	if (greetings.includes(cleaned.split(/[\s,]+/)[0])) {
		// Si el mensaje empieza con un saludo pero podría ser respuesta al flujo actual,
		// verificamos que no tenga contenido relevante más allá del saludo
		const sinSaludo = cleaned.replace(/^(?:hola|holaa|holaaa|holi|oli|ola|hello|hi|hey|buenas)\s*,?\s*/i, '').trim();
		if (sinSaludo.length < 5) return true;
		// Si hay contenido después del saludo, no es interrupción
		return false;
	}

	// Si es una pregunta explícita (tiene signos de interrogación)
	if (/[?¿]/.test(msg)) return true;

	// Si empieza con palabras clave de pregunta o ayuda
	if (/^(?:c[oó]mo|qu[eé]|cu[aá]nto|d[oó]nde|por\s*qu[eé]|cu[aá]l|tiene|tienen|venden|ayuda|info|informacion|asesor|humano|soporte)\b/.test(msg)) return true;

	// Palabras clave de interrupción general (características del producto, etc.)
	// En flujos de ventas/perfilando, estas palabras son respuestas naturales, no interrupciones
	if (flujo !== 'perfilando' && flujo !== 'perfilando_pausado') {
		if (/\b(?:garant[ií]a|precio|costo|valor|cuanto cuesta|especificaciones|medidas|dimensiones|envio|flete|cobertura)\b/.test(msg)) return true;
	}

	// Si menciona palabras clave asociadas a otros agentes
	if (/\b(distribuidor|distribuidores|ser distribuidor|al por mayor|mayorista|mayoreo)\b/.test(msg)) return true;
	if (/\b(vacante|empleo|trabajo|hoja de vida|cv|curriculum|currículum|aplicar a|aplicar al)\b/.test(msg)) return true;
	if (/\b(servicio t[eé]cnico|reparaci[oó]n|reparar|mantenimiento|no enciende|no funciona|no enfr[ií]a|no centrifuga|da[ñn]ado|da[ñn]ada|falla|aver[ií]a|garant[ií]a)\b/.test(msg)) return true;
	if (/\b(repuesto|repuestos|pieza|piezas|accesorio|accesorios|filtro|empaque|resistencia|motor de)\b/.test(msg)) return true;
	if (/\b(cartera|deuda|mora|cuota atrasada|atrasado|estado de cuenta|saldo|recordatorio de pago|cu[aá]nto debo|me debe|debo|paz y salvo|factura)\b/.test(msg)) return true;

	// Si estamos en flujo de crédito y no estamos en el paso de elegir el producto, y el usuario menciona un producto o pregunta catálogo
	if (/^credito/.test(flujo)) {
		const stepIndex = context?.creditoStep ?? 0;
		// El paso de elegir el producto es cuando creditoStep es 17 (skuProducto)
		const esPasoProducto = stepIndex === 17;
		if (!esPasoProducto) {
			if (/\b(nevera|neveras|nevecon|nevecones|lavadora|lavadoras|televisor|televisores|tv|congelador|congeladores|exhibidor|exhibidores|minibar|freidora|freidoras|horno|hornos|licuadora|licuadoras|cafetera|cafeteras|parlante|parlantes|cocina|estufa|cat[aá]logo|buscar|precio|cuesta|vale|comprar)\b/.test(msg)) {
				return true;
			}
		}
	}

	// Si estamos en flujo de pago web y preguntan por medios autorizados o transferencias
	if (flujo === 'pago_web_paso' || flujo === 'pago_web' || flujo === 'seleccion_pago') {
		if (/\b(?:transferencia|medios autorizados|bancolombia|nequi|daviplata|efectivo|punto fisico|tienda|cuenta)\b/.test(msg)) return true;
	}

	return false;
}

export const orchestrator = new Orchestrator();