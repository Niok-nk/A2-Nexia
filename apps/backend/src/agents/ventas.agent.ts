import { IAgent, AgentResponse, CreditoData, CreditoStep } from './types.js';
import {
	CATEGORIAS_RE,
	PROFILING_STEPS,
	resolverRespuestaPerfil,
	detectarCategoria,
	extraerProductoConIA,
	detectarShortcuts,
	obtenerTerminoBusquedaDesdePerfil,
	camposPerfilCompletados,
	formatHistory,
	cleanResponse,
	buildUserDataContext,
	buildGemmaPrompt,
	verificarCobertura,
	extraerCiudadDelMensaje,
	detectarCiudadConIA,
	AGENT_NAME,
	getSaludo,
	resolverOpcion
} from './helpers.js';
import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';
import { sendMessage as sendWA } from '../whatsapp/whatsapp.js';

// ─── PASOS DEL FORMULARIO DE CRÉDITO ─────────────────────────────────────────

export const CREDITO_STEPS: CreditoStep[] = [
	{ field: 'nombres',            pregunta: '¿Cómo te llamas? (nombre completo)' },
	{ field: 'cedula',             pregunta: '¿Cuál es tu número de cédula?' },
	{ field: 'celular',            pregunta: '¿Un celular donde te pueda contactar?' },
	{ field: 'direccion',          pregunta: '¿Cuál es tu dirección con barrio?' },
	{
		field: 'tipoVivienda',
		pregunta: '¿Tu vivienda es...?\n1️⃣ Propia\n2️⃣ Arriendo\n3️⃣ Anticrés\n4️⃣ Familiar',
		opciones: ['Propia', 'Arriendo', 'Anticrés', 'Familiar'],
	},
	{ field: 'departamento',       pregunta: '¿En qué departamento vives?' },
	{ field: 'ciudad',             pregunta: '¿Y la ciudad? Si aplica, incluye la vereda.' },
	{
		field: 'personasACargo',
		pregunta: '¿Cuántas personas tienes a cargo?\n1️⃣ 1\n2️⃣ 2\n3️⃣ 3\n4️⃣ 4\n5️⃣ 5 o más',
		opciones: ['1', '2', '3', '4', '5 o más'],
	},
	{ field: 'empresa',            pregunta: '¿En qué empresa trabajas? Si eres independiente, cuéntame tu actividad.' },
	{ field: 'cargo',              pregunta: '¿Qué cargo tienes?' },
	{ field: 'experienciaLaboral', pregunta: '¿Cuánto tiempo llevas ahí?' },
	{
		field: 'estadoCivil',
		pregunta: '¿Estado civil?\n1️⃣ Soltero/a\n2️⃣ Casado/a\n3️⃣ Unión libre\n4️⃣ Viudo/a',
		opciones: ['Soltero/a', 'Casado/a', 'Unión libre', 'Viudo/a'],
	},
	{ field: 'ingresosMensuales',  pregunta: '¿Cuánto ganas al mes aproximadamente?' },
	{ field: 'gastosMensuales',    pregunta: '¿Y cuánto gastas al mes más o menos?' },
	{ field: 'otrosIngresos',      pregunta: '¿Tienes otros ingresos? Si no, escribe "No".' },
	{
		field: 'reportadoDataCredito',
		pregunta: '¿Estás reportado en DataCrédito?\n1️⃣ Sí\n2️⃣ No\n3️⃣ No sé',
		opciones: ['Sí', 'No', 'No sé'],
	},
	{
		field: 'dispuestoSaldarDeuda',
		pregunta: '¿Estarías dispuesto/a a saldar esa deuda para aspirar a un nuevo crédito?\n1️⃣ Sí\n2️⃣ No',
		opciones: ['Sí', 'No'],
	},
	{ field: 'producto',           pregunta: '¿Qué producto te gustaría financiar?' },
	{ field: 'skuProducto',        pregunta: 'Por último, ¿tienes el código o referencia del producto? Lo ves debajo del nombre en la página. Si no lo tienes, escribe "No sé".' },
];

export function formatearResumenCredito(data: CreditoData): string {
	return `
🟦 SOLICITUD DE CRÉDITO - JLC Electronics

👤 Datos personales
- Nombre: ${data.nombres} ${data.apellidos || ''}
- Cédula: ${data.cedula}
- Celular: ${data.celular}
- Dirección: ${data.direccion}
- Tipo de vivienda: ${data.tipoVivienda}
- Departamento: ${data.departamento}
- Ciudad: ${data.ciudad}
- Personas a cargo: ${data.personasACargo}
- Estado civil: ${data.estadoCivil}

💼 Información laboral
- Empresa: ${data.empresa}
- Cargo: ${data.cargo}
- Experiencia: ${data.experienciaLaboral}

💰 Información financiera
- Ingresos mensuales: ${data.ingresosMensuales}
- Gastos mensuales: ${data.gastosMensuales}
- Otros ingresos: ${data.otrosIngresos}
- Reportado en DataCrédito: ${data.reportadoDataCredito}
- Dispuesto a saldar deuda: ${data.dispuestoSaldarDeuda}

🛒 Producto de interés
- Producto: ${data.producto}
- SKU / Referencia: ${data.skuProducto}
`.trim();
}

export async function enviarResumenWhatsApp(resumen: string): Promise<void> {
	const WHATSAPP_CARTERA = process.env.WA_CARTERA || '573007215438';
	await sendWA(WHATSAPP_CARTERA, resumen);
}

/**
 * Usa Inteligencia Artificial para entender exactamente qué producto eligió el cliente
 * analizando el último mensaje del asistente para mantener el contexto real de lo ofrecido.
 */
async function matchProductoDesdeMsg(msg: string, productos: any[], lastAssistantMsg: string = ''): Promise<any | null> {
	if (!productos || productos.length === 0) return null;
	const lowerMsg = msg.toLowerCase().trim();

	// 1. Camino rápido: si escribe exactamente "1", "2", etc.
	const shortNum = parseInt(lowerMsg, 10);
	if (!isNaN(shortNum) && lowerMsg.length <= 2 && shortNum >= 1 && shortNum <= productos.length) {
		return productos[shortNum - 1];
	}

	// 2. IA para interpretar natural language robustamente
	const listaStr = productos.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
	const system = `Eres un sistema experto de análisis de intenciones comerciales.
Lista MÁXIMA de productos en la base de datos (con sus índices correctos):
${listaStr}

Lo que el asistente le acaba de decir al cliente:
"${lastAssistantMsg}"

El cliente respondió: "${msg}"

REGLAS:
- Determina qué producto de la lista seleccionó el cliente, BASADO EN LO QUE LE OFRECIÓ EL ASISTENTE.
- Si el cliente dice "la primera", se refiere a la primera opción mencionada en el mensaje del asistente, busca cuál de la lista corresponde a esa opción.
- RESPONDE ÚNICAMENTE CON EL NÚMERO DE ÍNDICE DEL PRODUCTO EN LA BASE DE DATOS (1, 2, 3...).
- Si la respuesta es ambigua o no selecciona ningún producto, responde "0".
- NO des explicaciones, solo el número.`;

	try {
		const raw = await generateResponse(msg, system);
		const match = raw.match(/\d+/);
		const num = match ? parseInt(match[0], 10) : NaN;
		if (!isNaN(num) && num >= 1 && num <= productos.length) {
			return productos[num - 1];
		}
	} catch (e) {
		console.error("[Ventas] Error en matchProductoDesdeMsg con IA:", e);
	}

	return null;
}

async function generarMensajeSinCobertura(ciudad: string, mensajeUsuario: string): Promise<string> {
	const ctx = mensajeUsuario
		? `El usuario mencionó su ciudad (${ciudad}) y previamente dijo: "${mensajeUsuario}".`
		: `El usuario dijo que es de ${ciudad}.`;
	try {
		return await generateResponse(
			ctx,
			`Eres un asesor de ventas amable y natural. El usuario es de ${ciudad}, donde NO tenemos cobertura directa pero podemos enviar por transportadora (el flete va incluido en el precio total, el cliente paga de contado todo incluido). Redacta un mensaje personalizado (máximo 2 oraciones) que:
- NO diga "qué bien" ni "excelente" (porque no hay cobertura directa)
- Informe amablemente que no tenemos cobertura directa pero que enviamos por transportadora (flete a cargo del cliente dentro del pago total)
- NO menciones "pago contra entrega", "contra entrega" ni "pagar al recibir"
- Pregunte qué producto o referencia busca
- Use un tono natural, no robotizado
NO incluyas saludos formales, solo el cuerpo del mensaje.`
		);
	} catch {
		return `En ${ciudad.charAt(0).toUpperCase() + ciudad.slice(1)} no tenemos cobertura directa, pero podemos enviarte por transportadora (el flete va incluido en el pago total). ¿Qué producto o referencia buscas? 😊`;
	}
}

export class VentasAgent implements IAgent {
	name = 'Ventas';

	// ── Flujo de crédito paso a paso ──────────────────────────────────────────
	private async manejarFlujoCredito(
		message: string,
		context: any
	): Promise<AgentResponse> {
		const creditoData: CreditoData = {
			...context?.creditoData,
			...(context?.userData?.nombre ? { nombres: context.userData.nombre } : {}),
			...(context?.userData?.cedula ? { cedula: context.userData.cedula } : {}),
			...(context?.userData?.direccion ? { direccion: context.userData.direccion } : {}),
			...(context?.userData?.departamento ? { departamento: context.userData.departamento } : {}),
			...(context?.userData?.ciudad ? { ciudad: context.userData.ciudad } : {}),
			...(context?.userData?.productoSolicitado ? { producto: context.userData.productoSolicitado } : {}),
		};
		const stepIndex: number = context?.creditoStep ?? 0;

		if (stepIndex > 0) {
			const stepAnterior = CREDITO_STEPS[stepIndex - 1];

			if (stepAnterior.field === 'nombres') {
				const textoLimpio = message.trim();
				if (textoLimpio.length >= 2 && !/^\d+$/.test(textoLimpio) && !/^[\p{Emoji}\s]+$/u.test(textoLimpio)) {
					creditoData.nombres = textoLimpio;
				}
				if (!creditoData.nombres) {
					return {
						response: 'Disculpa, no logré captar tu nombre. ¿Me lo escribes de nuevo? 😊',
						metadata: {
							agentType: 'ventas',
							flujo: 'credito',
							creditoData,
							creditoStep: stepIndex,
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
						},
					};
				}
			} else if (stepAnterior.field === 'skuProducto' && context?.creditoOptions) {
				const num = parseInt(message.trim(), 10);
				const opciones = context.creditoOptions as Array<{ sku: string; name: string }>;
				if (!isNaN(num) && num >= 1 && num <= opciones.length) {
					const seleccion = opciones[num - 1];
					creditoData.skuProducto = seleccion.sku;
					creditoData.producto = seleccion.name;
				} else {
					const term = message.toLowerCase().trim();
					const match = opciones.find(o => o.name.toLowerCase().includes(term));
					if (match) {
						creditoData.skuProducto = match.sku;
						creditoData.producto = match.name;
					} else {
						creditoData.skuProducto = message.trim();
					}
				}
			} else {
				const valor = stepAnterior.opciones
					? resolverOpcion(message, stepAnterior.opciones)
					: message.trim();
				creditoData[stepAnterior.field] = valor;
			}
		}

		const camposFaltantes = CREDITO_STEPS.filter((s) => !creditoData[s.field]);

		if (camposFaltantes.length > 0) {
			const siguientePaso = camposFaltantes[0];
			const indexReal = CREDITO_STEPS.findIndex(
				(s) => s.field === siguientePaso.field
			);

			const completados = CREDITO_STEPS.length - camposFaltantes.length;
			let transicion = '';
			if (completados === 1) transicion = '¡Gracias! ';
			else if (completados === 3) transicion = 'Vamos muy bien 💪 ';
			else if (completados === 6) transicion = 'Ya casi terminamos la parte personal. ';
			else if (completados === 11) transicion = 'Casi listo, solo faltan unos pocos datos más. ';
			else if (completados >= 15) transicion = '¡Ya casi terminamos! ';
			else if (completados > 0 && completados % 3 === 0) transicion = 'Perfecto. ';

			if (siguientePaso.field === 'skuProducto') {
				const queryTerm = creditoData.producto || 'electrodomestico';
				let matchedProducts: any[] = [];
				try {
					matchedProducts = await wooCommerceService.searchProducts(queryTerm, 5);
				} catch (e) {
					console.error('Failed to search WooCommerce in credit flow', e);
				}

				if (matchedProducts && matchedProducts.length > 0) {
					const opciones = matchedProducts.map((p) => ({
						sku: p.sku || String(p.id),
						name: p.name,
					}));
					const listStr = matchedProducts
						.map((p, i) => {
							return `${i + 1}️⃣ *${p.name}*`;
						})
						.join('\n');
					
					return {
						response: `${transicion}Para tu solicitud de crédito, encontré estos modelos disponibles en JLC Electronics. ¿Cuál de estos te gustaría financiar? Escríbeme el número de tu opción: 😊\n\n${listStr}\n\nSi prefieres otro, dime el nombre o escribe "otro".`,
						metadata: {
							agentType: 'ventas',
							flujo: 'credito',
							creditoData,
							creditoStep: indexReal + 1,
							creditoOptions: opciones,
						},
					};
				}
			}

			return {
				response: `${transicion}${siguientePaso.pregunta}`,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					creditoData,
					creditoStep: indexReal + 1,
				},
			};
		}

		const resumen = formatearResumenCredito(creditoData);

		try {
			await enviarResumenWhatsApp(resumen);
		} catch {
			console.error('Error enviando resumen de crédito por WhatsApp');
		}

		return {
			response: `¡Listo! 🎉 Tu solicitud fue enviada a nuestro equipo comercial. Un asesor se comunicará contigo pronto para continuar el proceso de crédito. Si tienes preguntas urgentes, puedes escribir al WhatsApp +57 318 740 8190.`,
			nextStage: 'TRANSFER',
			shouldTransfer: true,
			metadata: {
				agentType: 'ventas',
				flujo: 'credito_completado',
				modalidad: null,
				creditoData,
			},
		};
	}

	// ── Handle principal ──────────────────────────────────────────────────────
	async handle(message: string, context: any): Promise<AgentResponse> {
		const lower = message.toLowerCase().trim();

		// ── Flujo de esperando_ciudad o esperando_modalidad pausado ──────────
		if (context?.flujo === 'esperando_ciudad_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			if (quiereContinuar) {
				context.flujo = 'esperando_ciudad';
				return {
					response: '¡Excelente! Sigamos. ¿Desde dónde nos escribes? 📍😊',
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_ciudad',
						pendingMessage: context?.pendingMessage,
					},
				};
			} else {
				context.flujo = null;
				return {
					response: 'Entendido, cancelamos la consulta. ¿En qué más te puedo ayudar hoy? 😊✨',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		if (context?.flujo === 'esperando_modalidad_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			if (quiereContinuar) {
				context.flujo = 'esperando_modalidad';
			return {
				response: '¡Súper! Cuéntame, ¿la compra sería al *contado* o a *crédito*? 💙',
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_modalidad',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
					pendingMessage: context?.pendingMessage,
				},
			};
			} else {
				context.flujo = null;
				return {
					response: 'Listo, dejamos de lado el proceso. ¿Qué otra duda o consulta tienes? 😊',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		// ── Flujo: Problema con la página web ──────────────────────────────────
		if (context?.flujo === 'problema_web') {
			const pd = context.problemaWebData || {};
			const detallesSuficientes = (pd.detalle?.length ?? 0) > 15 || pd.causa;
			if (detallesSuficientes) {
				return this.finalizarProblemaWeb(message, context);
			}
			return {
				response: 'Cuéntame más, ¿qué pasó exactamente? ¿Te apareció algún mensaje de error, en qué parte de la página ibas o qué estabas tratando de hacer? Así puedo entender mejor y ayudarte. 😊',
				metadata: {
					agentType: 'ventas',
					flujo: 'problema_web',
					problemaWebData: pd,
				},
			};
		}

		// Detectar problema web desde mensaje libre (sin flujo activo)
		const esProblemaWeb = !context?.flujo && /(?:problem[aeo]|error|fall[oóae]|no\s*(?:funcion[ae]|carg[aeo]|abre|sirve|dej[ao]|pued[eo])|pagina\s*(?:no|da|tien)|web\s*(?:no|mal|error)|trab[ae]ad[ao]|congel[ao]|se\s*(?:qued[oó]|trab[oó])|no\s*(?:carg[ao]|proces[oa]|redireccion[ae]|muestra))\b/i.test(lower);

		if (esProblemaWeb) {
			return {
				response: '¡Ay no, qué pena que estés teniendo inconvenientes con la página! 😟 Cuéntame, ¿qué estabas haciendo cuando se presentó el problema? ¿Te apareció algún mensaje de error? Así puedo revisar y ayudarte mejor. 💙',
				metadata: {
					agentType: 'ventas',
					flujo: 'problema_web',
					problemaWebData: { detalle: message },
				},
			};
		}

		// ── Flujo de crédito activo o pausado ──────────────────────────────────
		if (context?.flujo === 'credito' || context?.flujo === 'credito_pausado') {
			if (context?.flujo === 'credito_pausado') {
				const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar|reproducir/i.test(lower);
				if (quiereContinuar) {
					context.flujo = 'credito';
				} else {
					context.flujo = null;
					return {
						response: 'Entendido, cancelamos el proceso de crédito. ¿En qué más te puedo ayudar hoy? 😊',
						metadata: { agentType: 'ventas', flujo: null, modalidad: null },
					};
				}
			}
			if (context.flujo === 'credito') {
				return this.manejarFlujoCredito(message, context);
			}
		}

		// ── Flujo de pago o perfilando pausado ─────────────────────────────────
		if (context?.flujo === 'pago_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			if (quiereContinuar) {
				context.flujo = context.flujoAnterior || 'seleccion_pago';
			} else {
				context.flujo = null;
				return {
					response: 'Listo, dejamos de lado el pago. ¿Qué otra duda o consulta tienes? 😊',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		if (context?.flujo === 'perfilando_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			const mencionaProducto = context?.ultimaBusqueda?.results?.length > 0 && (
				/\b(?:primero|primera|segundo|segunda|tercero|tercera|[1-3])\b/i.test(lower) ||
				/(?:me (?:interesa|gusta|llama|llam[oó])|quiero|prefiero|ese|esa|este|esta|ese modelo|esa referencia)/i.test(lower)
			);
			if (quiereContinuar) {
				context.flujo = 'perfilando';
			} else if (mencionaProducto) {
				context.flujo = null;
			} else {
				context.flujo = null;
				return {
					response: 'Perfecto, cuéntame entonces en qué producto estás interesado y te busco las mejores opciones. 😊',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		// ── Flujo de selección de pago ambiguo (Mejora #21 de info.md) ─────────
		if (context?.flujo === 'seleccion_pago_ambiguo') {
			const opcion = message.trim();
			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			
			// Extraer último mensaje del asistente para contexto
			const history = context?.history || [];
			const assistantMsgs = history.filter((h: any) => h.role === 'model');
			const lastAssistantMsg = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].parts[0].text : '';

			// Usar IA para interpretar cuál producto seleccionó
			const selected: any = await matchProductoDesdeMsg(opcion, ultimosProductos, lastAssistantMsg);

			if (selected) {
				const precioStr = selected.price ? ` tiene un valor de *$${Number(selected.price).toLocaleString('es-CO')}*` : '';
				const linkStr = selected.permalink ? `\nAquí tienes el enlace del producto:\n${selected.permalink}` : '';
				const ciudadStr = context?.ciudad ? ` con envío gratis a ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
				const opcionPuntoFisico = context?.tieneCobertura ? '\n3️⃣ Paga en un punto físico' : '';
				
				return {
					response: `¡Perfecto! El *${selected.name}*${precioStr}${ciudadStr}.${linkStr}\n\n¿Cómo prefieres realizar el pago? 💳\n1️⃣ Por transferencia bancaria (medios autorizados)\n2️⃣ Directamente en nuestra página web (PSE, Tarjeta, Nequi)${opcionPuntoFisico}\n\nEscríbeme el número de tu opción y te doy las instrucciones paso a paso. 😊`,
					nextStage: 'PROPOSAL',
					metadata: {
						agentType: 'ventas',
						flujo: 'seleccion_pago',
						modalidad: 'contado',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						productoCompra: selected.name,
						productoURL: selected.permalink,
						ultimaBusqueda: context?.ultimaBusqueda,
					},
				};
			} else {
				const listaNombres = ultimosProductos.slice(0, 3).map((p: any, i: number) => {
					const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar';
					return `${i + 1}️⃣ *${p.name}* (${precio})`;
				}).join('\n');
				return {
					response: `Disculpa, no logré captar tu elección. Por favor escríbeme el número de la opción que prefieres:\n\n${listaNombres}`,
					metadata: {
						agentType: 'ventas',
						flujo: 'seleccion_pago_ambiguo',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						ultimaBusqueda: context?.ultimaBusqueda,
					},
				};
			}
		}

		// ── Pre-poblar ciudad desde UserData si ya está guardada ─────────────
		if (!context?.ciudad && context?.userData?.ciudad) {
			context = {
				...context,
				ciudad: context.userData.ciudad,
				ciudadValidada: true,
				departamento: context.userData.departamento ?? undefined,
			};
		}

		// ── SI ESTAMOS ESPERANDO CIUDAD, procesar primero (PASO 2) ─────────
		if (context?.flujo === 'esperando_ciudad') {
			let ciudadDetectada = await extraerCiudadDelMensaje(message);
			if (!ciudadDetectada) {
				ciudadDetectada = await detectarCiudadConIA(message);
			}
			if (!ciudadDetectada) {
				const limpio = message.trim().replace(/[.,!?¡¿]+$/g, '');
				if (limpio.length >= 3 && limpio.length <= 30) {
					ciudadDetectada = limpio.toLowerCase();
				}
			}

			if (!ciudadDetectada) {
				return {
					response: `No logré identificar tu ciudad. ¿Puedes escribirla de nuevo? 📍`,
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_ciudad',
						pendingMessage: context?.pendingMessage,
					},
				};
			}

			const cobertura = await verificarCobertura(ciudadDetectada);
			const ciudadCap = ciudadDetectada.charAt(0).toUpperCase() + ciudadDetectada.slice(1);

			if (cobertura === 'cobertura') {
				const msgOriginal = context?.pendingMessage || '';
				const yaDijoCredito = /\b(?:cr[eé]dito|financiar|cuotas|a cuotas|financiaci[oó]n)\b/i.test(msgOriginal);
				if (yaDijoCredito) {
					return {
						response: `¡Qué bien! A ${ciudadCap} te llega con envío gratis 🚚\n\n¡Dale, te ayudo con el crédito! 📋 Para armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
						metadata: {
							agentType: 'ventas',
							ciudad: ciudadDetectada,
							ciudadValidada: true,
							tieneCobertura: true,
							flujo: 'credito',
							modalidad: 'credito',
							creditoData: {},
							creditoStep: 1,
						},
					};
				}
			return {
				response: `¡Qué bien! A ${ciudadCap} te llega con envío gratis 🚚\n\n¿La compra sería al *contado* o a *crédito*?`,
				metadata: {
					agentType: 'ventas',
					ciudad: ciudadDetectada,
					ciudadValidada: true,
					tieneCobertura: true,
					flujo: 'esperando_modalidad',
					pendingMessage: context?.pendingMessage,
					productoSolicitado: context?.userData?.productoSolicitado || context?.pendingMessage || undefined,
					ultimaBusqueda: context?.ultimaBusqueda,
					terminoBusqueda: context?.terminoBusqueda,
				},
			};
			}

			const msgSinCobertura = (await generarMensajeSinCobertura(ciudadCap, context?.pendingMessage || '')).trim();
			return {
				response: msgSinCobertura,
				metadata: {
					agentType: 'ventas',
					ciudad: ciudadDetectada,
					ciudadValidada: true,
					tieneCobertura: false,
					modalidad: 'contado',
					flujo: null,
					productoSolicitado: context?.userData?.productoSolicitado || context?.pendingMessage || undefined,
					ultimaBusqueda: context?.ultimaBusqueda,
					terminoBusqueda: context?.terminoBusqueda,
				},
			};
		}

		// ── SI ESTAMOS ESPERANDO MODALIDAD (contado / crédito) ─────────────
		if (context?.flujo === 'esperando_modalidad') {
			const quiereCredito = /cr[eé]dito|a cr[eé]dito|financiar|financiaci[oó]n|cuotas|pagar a cuotas|^\s*1\s*$/i.test(lower);
			const quiereContado = /contado|efectivo|pago inmediato|precio de contado|contadito|^\s*2\s*$/i.test(lower);

			if (quiereCredito) {
				return {
					response: `¡Dale, te ayudo con el crédito! 📋\n\nPara armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
					metadata: {
						agentType: 'ventas',
						flujo: 'credito',
						modalidad: 'credito',
						creditoData: {},
						creditoStep: 1,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						productoSolicitado: context?.userData?.productoSolicitado || context?.pendingMessage || undefined,
					},
				};
			}

			if (quiereContado) {
				const msgOriginal = context?.pendingMessage || '';
				const terminoIA = await extraerProductoConIA(msgOriginal);
				if (terminoIA) {
					let products: any[] = [];
					try {
						products = await wooCommerceService.searchProducts(terminoIA, 20);
					} catch { /* continuar sin productos */ }
					if (products.length > 0) {
						const cat = detectarCategoria(msgOriginal) || 'otra';
						const shortcuts = detectarShortcuts(msgOriginal, cat);
						const pasos = PROFILING_STEPS[cat] || PROFILING_STEPS.otra;
						const camposOk = camposPerfilCompletados(shortcuts);
						if (camposOk < pasos.length) {
							const primerPaso = pasos.find(p => !shortcuts[p.field]);
							if (primerPaso) {
								return {
									response: `¡Perfecto! ${primerPaso.pregunta}`,
									metadata: {
										agentType: 'ventas',
										flujo: 'perfilando',
										perfilState: { categoria: cat, step: 1, answers: shortcuts, terminoOriginal: terminoIA },
										ciudad: context?.ciudad,
										ciudadValidada: true,
										tieneCobertura: context?.tieneCobertura,
										modalidad: 'contado',
										productosPreCargados: products,
									},
								};
							}
						}
						const lista = products.slice(0, 6).map((p, i) => `${i + 1}. *${p.name}* — $${parseInt(p.price).toLocaleString('es-CO')}`).join('\n');
						return {
							response: `¡Perfecto! Estos son algunos productos que encontré:\n\n${lista}\n\n¿Te gusta alguno? Cuéntame cuál para darte más detalles 😊`,
							metadata: {
								agentType: 'ventas',
								modalidad: 'contado',
								ciudad: context?.ciudad,
								ciudadValidada: true,
								tieneCobertura: context?.tieneCobertura,
								terminoBusqueda: terminoIA,
								ultimaBusqueda: { results: products, categoria: cat, productoIndex: 0 },
								flujo: null,
							},
						};
					}
				}
				return {
					response: `¡Perfecto! Cuéntame, ¿qué estás buscando? 😊`,
					metadata: {
						agentType: 'ventas',
						modalidad: 'contado',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						flujo: null,
					},
				};
			}

			return {
				response: `Disculpa, no entendí. ¿La compra sería al *contado* o a *crédito*?\n\nResponde *1* o *contado* si pagas de contado, o *2* o *crédito* si deseas financiar.`,
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_modalidad',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
					pendingMessage: context?.pendingMessage,
				},
			};
		}

		// ── PASO 1: Validar cobertura si aún no se hizo (mejoras #2 y #4) ─────
		if (!context?.ciudadValidada) {
			const ciudadDetectada = await extraerCiudadDelMensaje(message);

			if (!ciudadDetectada) {
				const esPrimeraVez = !context?.history?.length && !context?.nuevaSesion;
				const saludo = getSaludo();
				const intro = esPrimeraVez
					? `${saludo} 👋 Soy ${AGENT_NAME}, tu asesora en JLC Electronics, la marca de los colombianos.\n\n`
					: '';
				return {
					response: `${intro}¿Desde dónde nos escribes? 📍`,
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_ciudad',
						pendingMessage: message,
					},
				};
			}

			const cobertura = await verificarCobertura(ciudadDetectada);

			if (cobertura === 'cobertura') {
				context = {
					...context,
					ciudadValidada: true,
					ciudad: ciudadDetectada,
					tieneCobertura: true,
				};
				return {
					response: `¡Qué bien! A ${ciudadDetectada.charAt(0).toUpperCase() + ciudadDetectada.slice(1)} te llega con envío gratis 🚚\n\n¿La compra sería al *contado* o a *crédito*?`,
					metadata: {
						agentType: 'ventas',
						ciudad: ciudadDetectada,
						ciudadValidada: true,
						tieneCobertura: true,
						flujo: 'esperando_modalidad',
						pendingMessage: message,
					},
				};
			}

			context = {
				...context,
				ciudadValidada: true,
				ciudad: ciudadDetectada,
				tieneCobertura: false,
			};
			const msgSinCobertura = (await generarMensajeSinCobertura(ciudadDetectada, context?.pendingMessage || '')).trim();
			return {
				response: msgSinCobertura,
				metadata: {
					agentType: 'ventas',
					ciudad: ciudadDetectada,
					ciudadValidada: true,
					tieneCobertura: false,
					modalidad: 'contado',
					flujo: null,
				},
			};
		}

		// ── PASO 3: Si eligió crédito → iniciar formulario ──────────────────
		const pideCredito = /\b(?:cr[eé]dito|financiar|cuotas|a cuotas|financiaci[oó]n|quiero.*(?:cr[eé]dito|financiar|cuotas)|financiame|me financias|a cr[eé]dito|cr[eé]dito directo)\b/i.test(message);
		if (pideCredito && context?.modalidad !== 'credito') {
			const nuevaModalidad = 'credito';
			return {
				response: `¡Dale, te ayudo con el crédito! 📋\n\nPara armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					modalidad: nuevaModalidad,
					creditoData: {},
					creditoStep: 1,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}
		if (context?.modalidad === 'credito' && context?.flujo !== 'credito_completado') {
			return {
				response: `¡Dale, te ayudo con el crédito! 📋\n\nPara armar tu solicitud necesito algunos datos. Empecemos con lo básico:\n\n¿Cómo te llamas? (nombre completo)`,
				metadata: {
					agentType: 'ventas',
					flujo: 'credito',
					modalidad: 'credito',
					creditoData: {},
					creditoStep: 1,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}

		// ── PASO 4: Detectar intención de compra ─────────────────────────────
		const quiereComprar = /\b(?:comprar(?:lo|la)?|lo quiero|la quiero|quiero(?: esa| esta| ese| este| comprar)?|c[oó]mo (?:compro|hago|puedo pagar|le hago|le hago para pagar|pago)|quiero pagar|proceder|concretar|compralo|c[oó]mpralo|reservar|apartar|d[áa]le|confirmo compra|ya lo quiero|me gusta(?: esa| esta| ese| el| la)?|esa me gusta|esta me gusta|si continuemos|si sigamos|sigamos adelante|seguimos|continuemos)\b|\bcompr(?:o|ar)\s+(?:esa|esta|este|ese|eso|esas|esos|estes)\b|\b(?:el de \d+|la de \d+|el primero|el segundo|la primera|la segunda|me quedo con|me interesa(?: el| la)?|prefiero(?: el| la)?|lo compro|la compro|eso quiero|eso me sirve|eso me gusta|me llevo(?: el| la)?)\b|\b(?:el (?:de \d+|primero|segundo)|la (?:de \d+|primera|segunda))\b/i.test(message) && context?.ultimaBusqueda?.results?.length > 0;

		const puedeComprar = context?.modalidad === 'contado' || 
			(context?.ultimaBusqueda?.results?.length > 0 && context?.modalidad !== 'credito');

		if (quiereComprar && puedeComprar) {
			const tieneCobertura = context?.tieneCobertura;
			const opcionPuntoFisico = tieneCobertura
				? '\n3️⃣ Paga en un punto físico'
				: '';

			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			let productoSolicitado: string | undefined;
			let productoURL: string | undefined;
			let pPrice: string | undefined;
			if (ultimosProductos.length === 1) {
				productoSolicitado = ultimosProductos[0].name;
				productoURL = ultimosProductos[0].permalink;
				pPrice = ultimosProductos[0].price;
			} else if (ultimosProductos.length > 1) {
				// Extraer último mensaje del asistente para contexto
				const history = context?.history || [];
				const assistantMsgs = history.filter((h: any) => h.role === 'model');
				const lastAssistantMsg = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].parts[0].text : '';

				// Usar IA para interpretar cuál producto seleccionó
				const matchResult = await matchProductoDesdeMsg(message, ultimosProductos, lastAssistantMsg);
				
				if (!matchResult) {
					// No se pudo identificar → preguntar con lista numerada
					const listaNombres = ultimosProductos.slice(0, 3).map((p: any, i: number) => {
						const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar';
						return `${i + 1}️⃣ *${p.name}* (${precio})`;
					}).join('\n');
					
					return {
						response: `¡Ay, qué bien! Pero para darte las instrucciones exactas necesito saber cuál te llevas 😊 Escríbeme el número:\n\n${listaNombres}`,
						metadata: {
							agentType: 'ventas',
							flujo: 'seleccion_pago_ambiguo',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
							ultimaBusqueda: context?.ultimaBusqueda,
						},
					};
				}
				
				productoSolicitado = matchResult.name;
				productoURL = matchResult.permalink;
				pPrice = matchResult.price;
			}

			const precioStr = pPrice ? ` tiene un valor de *$${Number(pPrice).toLocaleString('es-CO')}*` : '';
			const linkStr = productoURL ? `\nAquí tienes el enlace del producto:\n${productoURL}` : '';
			const ciudadStr = context?.ciudad ? ` con envío gratis a ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
			
			const opcionesMsg = `¡Excelente elección! El *${productoSolicitado || 'producto'}*${precioStr}${ciudadStr}.${linkStr}\n\nPara continuar con tu compra, ¿cómo prefieres realizar el pago? 💳\n1️⃣ Por transferencia bancaria (medios autorizados)\n2️⃣ Directamente en nuestra página web (PSE, Tarjeta, Nequi)${opcionPuntoFisico}\n\nEscríbeme el número de tu opción y te doy las instrucciones paso a paso. 😊`;

			return {
				response: opcionesMsg,
				metadata: {
					agentType: 'ventas',
					flujo: 'seleccion_pago',
					modalidad: 'contado',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura,
					...(productoSolicitado ? { productoCompra: productoSolicitado } : {}),
					...(productoURL ? { productoURL } : {}),
				},
			};
		}

		// ── PASO 4b: Consulta genérica sobre cómo pagar ─────────────────────
		const preguntaPago = /\b(?:c[oó]mo (?:pagar|pago|puedo pagar|hago para pagar)|medios de pago|formas de pago|d[oó]nde pago|puedo pagar)\b/i.test(message);
		if (preguntaPago && context?.modalidad === 'contado' && !context?.flujo?.startsWith('pago_') && context?.flujo !== 'seleccion_pago') {
			const tieneCobertura = context?.tieneCobertura;
			return {
				response: `Claro, estas son las opciones:\n1️⃣ Medios de pago autorizados\n2️⃣ Paga directamente en nuestra página web${tieneCobertura ? '\n3️⃣ Paga en un punto físico' : ''}\n¿Cuál prefieres?`,
				nextStage: 'PROPOSAL',
				metadata: {
					agentType: 'ventas',
					flujo: 'seleccion_pago',
					modalidad: 'contado',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura,
				},
			};
		}

		// ── PASO 4c: Seguimiento paso a paso para pago web ──────────────────
		if (context?.flujo === 'pago_web_paso') {
			const pasoActual: number = context?.pasoWeb ?? 1;

			// Pasos reales del checkout JLC Electronics
			const PASOS_WEB = [
				'Abre el enlace del producto y dale clic en el botón *Añadir al carrito* 🛒',
				'Ya en el carrito, busca la sección *"Calcula el envío"*. Selecciona tu *departamento* y dale clic en *Actualizar*. Así se habilitan las ciudades.',
				'Ahora selecciona tu *ciudad/municipio*, escribe tu *código postal* y vuelve a dar clic en *Actualizar*. Ahí te aparece el valor del flete (o "Envío gratis" si aplica). 😊',
				'Dale clic en el botón *Proceder al pago*. Se abre el formulario — llena todos tus datos (nombre, cédula, teléfono, dirección) y luego dale *Realizar el pedido*.',
				'Por último, selecciona tu método de pago en *Wommpi* (PSE, tarjeta de crédito, Nequi, Bancolombia, y más). Confirma el pago y ¡listo! 🎉',
			];

			const avanzar = /\b(?:listo|ya|hecho|ok|okay|sip|dale|s[íï]|siguiente|continu[ae]|lo hice|ya lo hice|ya est[aá]|ya termin[eé]|hice clic|le di|le doy|di clic|puse|escrib[íï]|ya puse|lo vi|me abri[oó]|me aparece|me sali[oó])\b/i.test(lower);

			if (avanzar) {
				if (pasoActual >= PASOS_WEB.length) {
					// Último paso completado → esperar comprobante
					return {
						response: `¡Genial! 🎉 Cuando aparezca la confirmación de pago, compárteme el comprobante o número de transacción por aquí (foto o pantallazo) y nuestro equipo te confirma el despacho de inmediato.`,
						metadata: {
							agentType: 'ventas',
							flujo: 'esperando_comprobante',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							productoURL: context?.productoURL,
						},
					};
				}
				const siguiente = pasoActual + 1;
				return {
					response: `Paso ${siguiente} de ${PASOS_WEB.length}: ${PASOS_WEB[siguiente - 1]}\n\nDime “listo” cuando termines o cuéntame si tienes alguna duda. 😊`,
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_web_paso',
						pasoWeb: siguiente,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						productoURL: context?.productoURL,
					},
				};
			}

			// El usuario escribe algo libre → responder con Gemini y recordar el paso
			const userDataStr2 = buildUserDataContext(context?.userData);
			const { system: sys2, user: usr2 } = buildGemmaPrompt({
				instruccion: `Eres Sara, asesora virtual de JLC Electronics Colombia. El cliente está en el proceso de pago en la página web (Paso ${pasoActual} de ${PASOS_WEB.length}: "${PASOS_WEB[pasoActual - 1]}"). Tiene una duda o comentario sobre ese proceso. Respóndele de forma breve y cálida en español colombiano femenino. NO recomiendes otros productos.\n${userDataStr2}`,
				ejemplos: [],
				historial: formatHistory(context?.history),
				mensajeCliente: message,
			});
			const rawWp = await generateResponse(usr2, sys2);
			const respWp = cleanResponse(rawWp);
			return {
				response: `${respWp}\n\n_(Paso ${pasoActual} de ${PASOS_WEB.length}: ${PASOS_WEB[pasoActual - 1]} — dime “listo” cuando termines 😊)_`,
				metadata: {
					agentType: 'ventas',
					flujo: 'pago_web_paso',
					pasoWeb: pasoActual,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					productoURL: context?.productoURL,
				},
			};
		}

		// ── Manejo de pago completado o fallido ───────────────────────────────
		if (context?.flujo === 'pago_completado') {
			const noPudo = /no\s*(?:pude|puedo|logr[eé]|me\s*dej[oó])|problema|error|fallo|fall[oó]|no\s*sirv[eió]/i.test(lower);
			if (noPudo) {
				const ciudadCap = context?.ciudad ? context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1) : '';
				const productoInfo = context?.productoURL || 'producto pendiente';
				const notificacion = `⚠️ Cliente desde ${ciudadCap} no pudo completar el pago web.\nProducto: ${productoInfo}\nRequiere asistencia.`;
				try {
					const WA_ESCALAMIENTO = process.env.WA_ESCALAMIENTO || '573187408190';
					await sendWA(WA_ESCALAMIENTO, notificacion);
				} catch { /* no bloquear */ }

				return {
					response: `No te preocupes, ya le notifiqué a nuestro equipo comercial para que te ayude directamente. Un asesor te va a escribir por aquí en un momentico. 💪`,
					metadata: {
						agentType: 'ventas',
						flujo: null,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						escalado: true,
					},
				};
			}
			return {
				response: `¡Qué bien! 🎉 Para confirmar tu pago, compárteme el comprobante o número de transacción por aquí (foto o pantallazo). Nuestro equipo lo verifica y te programamos el envío lo antes posible.`,
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_comprobante',
					ciudad: context?.ciudad,
					ciudadValidada: true,
				},
			};
		}

		if (context?.flujo === 'pago_web') {
			const quiereAyuda = /\bs[íi]\b|sip|dale|ok|bueno|claro|si gracias|si por favor|me acompañas|guíame|ayúdame|paso a paso/i.test(lower);
			if (quiereAyuda) {
				return {
					response: `¡Con mucho gusto te acompaño! 😊\n\nPaso 1 de 5: Abre el enlace del producto y dale clic en el botón *Añadir al carrito* 🛒\n\nDime "listo" cuando lo hayas hecho.`,
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_web_paso',
						pasoWeb: 1,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						productoURL: context?.productoURL,
					},
				};
			}
			return {
				response: `Perfecto, cualquier duda me avisas. 😊`,
				metadata: {
					agentType: 'ventas',
					flujo: null,
					ciudad: context?.ciudad,
					ciudadValidada: true,
				},
			};
		}

		// ── PASO 4d: Confirmación de pago realizado ──
		const yaPago = /\b(?:ya pagu[eé]|pago realizado|ya transfer[ií]|ya realic[eé] el pago|ya hice el pago|pago hecho|listo el pago|comprobante enviado)\b/i.test(message);
		if (yaPago && context?.modalidad === 'contado') {
			return {
				response: `¡Perfecto! Para confirmar tu pago, ¿me puedes compartir el comprobante o el número de transacción? (Puedes enviar una captura de pantalla / pantallazo o foto). 😊\n\nUna vez enviado, nuestro equipo verificará el pago en un tiempo máximo de 1 hora y procederemos con el despacho inmediato de tu pedido con envío gratis. En ese momento te enviaremos el número de guía para que puedas rastrearlo.`,
				metadata: {
					agentType: 'ventas',
					flujo: 'esperando_comprobante',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}

		// ── PASO 4e: Ya estamos esperando el comprobante ────────────────────
		if (context?.flujo === 'esperando_comprobante') {
			const productoSolicitado = context?.productoSolicitado || context?.userData?.productoSolicitado || 'tu producto';
			const ciudad = context?.ciudad || context?.userData?.ciudad || '';
			const tieneCiudad = !!ciudad;
			const responseParts = [
				`¡Ay, qué chévere! Ya recibí tu comprobante, así que voy a confirmar el pago de ${productoSolicitado} para dejarla reservada y lista para el envío${tieneCiudad ? ` a ${ciudad}` : ''}. Tan pronto el equipo lo verifique, te estaré contando. ¡Muchas gracias por tu compra! 😊`,
			];
			return {
				response: responseParts.join('\n\n'),
				metadata: {
					agentType: 'ventas',
					flujo: null,
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}

		// ── PASO 5: Flujo de selección de pago ──────────────────────────────
		if (context?.flujo === 'seleccion_pago') {
			const opcion = message.trim();
			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			const productoURL = context?.productoURL ?? ultimosProductos[0]?.permalink;

			if (/1|transferencia|medios de pago|medios autorizados/i.test(opcion)) {
				return {
					response: `Estos son nuestros medios de pago autorizados:\nhttps://jlc-electronics.com/wp-content/uploads/2026/05/Medios_de_pago.jpeg\n\nAhí verás todas las cuentas disponibles (Bancolombia, Davivienda, Nequi, etc.). Una vez realices la transferencia, por favor compárteme tu nombre completo, número de cédula y el comprobante de pago${context?.tieneCobertura ? ' para programar tu envío gratis' : ' y coordinamos el despacho por transportadora'} de inmediato.\n\n¿Pudiste completar el pago o te surgió alguna duda? 😊`,
					nextStage: 'PROPOSAL',
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_medios',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						productoURL,
					},
				};
			}
			if (/2|p[aá]gina web|web|en l[íi]nea|online/i.test(opcion)) {
				const productLink = productoURL
					? `\n\nLink del producto:\n${productoURL}`
					: '';
				return {
					response: `Puedes pagar directamente en nuestra página web.${productLink}\n\n¿Quieres que te acompañe paso a paso con el proceso?`,
					nextStage: 'PROPOSAL',
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_web',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						productoURL,
					},
				};
			}
			if (context?.tieneCobertura && /3|punto físico|físico|tienda/i.test(opcion)) {
				return {
					response: `¡Claro! Para reservarte el producto en el punto más cercano, necesito tu nombre completo y número de cédula. 😊`,
					nextStage: 'PROPOSAL',
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_fisico',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						notificarPuntoFisico: true,
					},
				};
			}
			return {
				response: `Por favor elige una opción:\n1️⃣ Medios de pago autorizados\n2️⃣ Paga directamente en nuestra página web${context?.tieneCobertura ? '\n3️⃣ Paga en un punto físico' : ''}\n¿Cuál prefieres?`,
				metadata: {
					agentType: 'ventas',
					flujo: 'seleccion_pago',
					ciudad: context?.ciudad,
					ciudadValidada: true,
					tieneCobertura: context?.tieneCobertura,
				},
			};
		}

		// ── PASO 6: Detectar datos personales del cliente ──────────────────
		const datosPersonales: Record<string, string> = {};
		const cedulaMatch = message.match(/\b\d{5,12}\b/);
		if (cedulaMatch) datosPersonales.cedulaCliente = cedulaMatch[0];

		const nombreMatch = message.match(/^(?:mi nombre es|soy|me llamo)\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s]+)/i);
		if (nombreMatch) datosPersonales.nombreCliente = nombreMatch[1].trim();

		if (message.length > 5 && message.split(/[,;]/).length >= 2 && datosPersonales.cedulaCliente) {
			const partes = message.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
			if (partes.length >= 2 && !datosPersonales.nombreCliente) {
				datosPersonales.nombreCliente = partes[0];
			}
			if (partes.length >= 3) {
				datosPersonales.direccion = partes.slice(2).join(', ');
			}
		}

		// ── PASO 7: Motor de perfilamiento por categoría ────────────────────
		const perfilState = context?.perfilState as { categoria: string; step: number; answers: Record<string, string> } | undefined;

		if (context?.flujo === 'perfilando' && perfilState) {
			const pasos = PROFILING_STEPS[perfilState.categoria] || PROFILING_STEPS.otra;
			const pasoActual = pasos[perfilState.step - 1];
			if (pasoActual) {
				perfilState.answers[pasoActual.field] = resolverRespuestaPerfil(message, pasoActual.field);
				perfilState.step++;
			}

			const camposOk = camposPerfilCompletados(perfilState.answers);

			if (camposOk >= pasos.length || perfilState.step > pasos.length) {
				const terminoBusqueda = (perfilState as any).terminoOriginal || obtenerTerminoBusquedaDesdePerfil(perfilState.categoria, perfilState.answers);
				if (context?.productosPreCargados?.length > 0) {
					const products = context.productosPreCargados;
					const lista = products.slice(0, 6).map((p: any, i: number) => `${i + 1}. *${p.name}* — $${parseInt(p.price).toLocaleString('es-CO')}`).join('\n');
					return {
						response: `¡Perfecto! Estos son algunos productos que encontré:\n\n${lista}\n\n¿Te gusta alguno? Cuéntame cuál para darte más detalles 😊`,
						metadata: {
							agentType: 'ventas',
							modalidad: 'contado',
							ciudad: context?.ciudad,
							ciudadValidada: true,
							tieneCobertura: context?.tieneCobertura,
							terminoBusqueda,
							ultimaBusqueda: { results: products, categoria: perfilState.categoria, productoIndex: 0 },
							flujo: null,
							presupuesto: perfilState.answers.presupuesto,
							productoSolicitado: terminoBusqueda,
						},
					};
				}
				context = { ...context, flujo: null, terminoBusqueda };
				if (perfilState.answers.presupuesto) {
					datosPersonales.presupuesto = perfilState.answers.presupuesto;
				}
			} else {
				const siguientePaso = pasos[perfilState.step - 1];
				return {
					response: siguientePaso.pregunta,
					metadata: {
						agentType: 'ventas',
						flujo: 'perfilando',
						perfilState,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
						modalidad: context?.modalidad,
						...datosPersonales,
					},
				};
			}
		}

		const CATEGORIAS = CATEGORIAS_RE;
		const esCategoriaSola = CATEGORIAS.test(message) && message.split(/\s+/).length <= 4;
		const esBusquedaCategoria = CATEGORIAS.test(message) && /(?:busco|quiero|necesito|me interesa|tiene[ns]?|hay|venden|muestra|quisiera|info de|informacion de|precio de|precios de|cuesta|cuestan|vale|valen|consulta|tambi[eé]n)/i.test(message);
		const categoriaGeneral = esCategoriaSola || esBusquedaCategoria;

		if (categoriaGeneral) {
			const nuevaCategoria = detectarCategoria(message);
			const categoriaAnterior = context?.ultimaBusqueda?.categoria;
			if (nuevaCategoria && categoriaAnterior && nuevaCategoria !== categoriaAnterior) {
				context = {
					...context,
					ultimaBusqueda: undefined,
					terminoBusqueda: undefined,
					perfilState: undefined,
					flujo: null,
				};
			}
		}
		const catDetectada = detectarCategoria(message);
		if ((categoriaGeneral || catDetectada) && context?.flujo !== 'perfilando') {
			const cat = catDetectada;
			if (cat) {
				const terminoParaBuscar = message.toLowerCase().replace(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa)\s*/gi, '').trim();
				let productosDisponibles: any[] = [];
				try {
					productosDisponibles = await wooCommerceService.searchProducts(terminoParaBuscar, 20);
					if (productosDisponibles.length === 0) {
						productosDisponibles = await wooCommerceService.searchProducts(cat, 20);
					}
				} catch { /* continuar sin productos */ }

				if (productosDisponibles.length === 0) {
					return {
						response: `En este momento no tenemos ${terminoParaBuscar} disponible en nuestro catálogo. ¿Hay algo más en lo que te pueda ayudar? 😊`,
						metadata: {
							agentType: 'ventas',
							ciudadValidada: context?.ciudadValidada,
							ciudad: context?.ciudad,
							modalidad: context?.modalidad,
							tieneCobertura: context?.tieneCobertura,
							productoSolicitado: terminoParaBuscar,
							...datosPersonales,
						},
					};
				}

				const shortcuts = detectarShortcuts(message, cat);
				const pasos = PROFILING_STEPS[cat] || PROFILING_STEPS.otra;
				const campos = camposPerfilCompletados(shortcuts);

				if (campos >= pasos.length) {
					const terminoBusqueda = terminoParaBuscar;
					context = { ...context, terminoBusqueda };
				} else {
					const primerPaso = pasos.find(p => !shortcuts[p.field]);
					if (primerPaso) {
						const prodMatch = message.match(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa|info de|informacion de)\s*(?:un[oa]?|unas?|disponible|esta|este|esa|ese)?\s*([a-záéíóúñÁÉÍÓÚÑ][a-záéíóúñÁÉÍÓÚÑ\s]{2,40})/i);
						return {
							response: primerPaso.pregunta,
							metadata: {
								agentType: 'ventas',
								flujo: 'perfilando',
								perfilState: {
									categoria: cat,
									step: pasos.indexOf(primerPaso) + 1,
									answers: shortcuts,
									terminoOriginal: prodMatch ? prodMatch[1].trim().toLowerCase() : terminoParaBuscar
								},
								ciudad: context?.ciudad,
								ciudadValidada: true,
								tieneCobertura: context?.tieneCobertura,
								modalidad: context?.modalidad,
								productosPreCargados: productosDisponibles,
								productoSolicitado: terminoParaBuscar,
								ultimaBusqueda: { results: productosDisponibles, categoria: cat, productoIndex: 0 },
								...datosPersonales,
							},
						};
					}
				}
			}
		}

		// ── Preguntas sobre la identidad del agente ─────────────────────────
		if (/c[oó]mo te llamas|qui[eé]n eres|te llamas|como te llam|como es tu nombre|cu[aá]l es tu nombre|eres humana|eres robot|eres inteligencia|qui[eé]n soy|qui[eé]n es sara|sara qui[eé]n|presentate|pres[eé]ntate/i.test(message)) {
			return {
				response: `Soy ${AGENT_NAME}, tu asesora virtual de JLC Electronics, la marca de los colombianos. 😊 ¿En qué te puedo ayudar?`,
				metadata: {
					agentType: 'ventas',
					ciudadValidada: context?.ciudadValidada,
					ciudad: context?.ciudad,
				},
			};
		}

		// ── Despedidas ───────────────────────────────────────────────────────
		if (/^(?:chao|adi[oó]s|bye|nos vemos|hasta luego|hasta pronto|cuídese|cuídate|gracias.*(?:chao|adi[oó]s|bye)|ya me voy|me retiro|buenas noches|buen día|buena tarde|que tengas buen|que est[eé]s bien|fue un placer|un placer|nos hablamos|luego|despu[eé]s te escribo|quedo atenta|quedo atento|gracias por todo|muchas gracias.*(?:adi[oó]s|bye|chao)|me voy|chao gracias|adi[oó]s gracias)\s*$/i.test(message.trim().toLowerCase())) {
			return {
				response: `¡Hasta luego! ${context?.userData?.nombre ? `Fue un placer ayudarte, ${context.userData.nombre.split(/\s+/)[0]}. ` : ''}Cuando necesites algo más, aquí estaré. ¡Cuídate mucho! 😊`,
				metadata: {
					agentType: 'ventas',
					flujo: null,
					ciudadValidada: context?.ciudadValidada,
					ciudad: context?.ciudad,
				},
			};
		}

		// ── Flujo normal de ventas (mostrar productos) ──────────────────────
		const ciudadStr = context?.ciudad ? `En ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
		const envioStr = context?.tieneCobertura
			? 'tienes envío gratis'
			: 'pago de contado (flete por transportadora incluido en el pago total)';

		const pideMas = /(?:tienes\s*mas|hay\s*m[áa]s|m[áa]s\s*opciones|otr[oa]s?\s*opciones|quiero\s*ver\s*m[áa]s|mu[ée]strame\s*m[áa]s|busco\s*otr[oa]|alg[úu]n\s*otr[oa]|otr[oa]s?\s*opciones|diferente)/i.test(message);
		const pideMasEconomico = /(?:m[áa]s\s*(?:econ[oó]mic[oa]s?|barat[oa]s?|econ[oó]mic[oa])|algo\s*(?:m[áa]s\s*)?(?:econ[oó]mico|barato)|m[áa]s\s*barato|menos\s*costoso|de\s*menor\s*precio|hay\s*(?:algo\s*)?m[áa]s\s*barat)/i.test(message);

		let products: any[] = [];
		let hayProductos = false;
		let productoIndex = 0;
		let terminoBusqueda = context?.terminoBusqueda || message;

		const STOPWORDS_PRODUCTO = /\s+(?:de|del|la|el|los|las|un|una|unos|unas|por|para|con|que|y|o|en|a|al|JLC|Electronics|marca|modelo|referencia|producto|electrodoméstico|electrodomestico)\b.*/i;
		const busquedaMatch = message.match(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa|info de|informacion de)\s*(?:un[oa]?|unas?|disponible|esta|este|esa|ese)?\s*([a-záéíóúñÁÉÍÓÚÑ][a-záéíóúñÁÉÍÓÚÑ\s]{2,40})/i);
		let productoBuscado: string;
		if (busquedaMatch) {
			productoBuscado = busquedaMatch[1].trim()
				.replace(STOPWORDS_PRODUCTO, '')
				.replace(/\s{2,}/g, ' ')
				.trim();
			if (productoBuscado.length < 3) productoBuscado = terminoBusqueda;
		} else {
			productoBuscado = terminoBusqueda;
		}

		const preguntaSeguimiento = /(?:especificaciones?|caracter[ií]sticas?|detalles?|d[ée]tal|cu[aá]nto cuesta|cu[aá]nto vale|cu[aá]l es|en qu[eé] se diferencia|diferencia|c[oó]mo es|descr[ií]belo|dimensiones|medidas|capacidad|color|modelo|referencia|precio|m[aá]s info|m[aá]s informaci[oó]n|primero|segunda?|tercero|este|ese|aquel|me gusta|prefiero|quiero|detalles|garantia|la primera opci[oó]n|el primero|la primera)/i.test(message) && context?.ultimaBusqueda?.results?.length > 0;

		if (preguntaSeguimiento) {
			products = context.ultimaBusqueda.results.slice(0, 6);
			hayProductos = true;
			// Conservar el término y categoría de búsqueda originales
			productoBuscado = context?.ultimaBusqueda?.categoria || context?.terminoBusqueda || 'producto';
		}

		if (pideMas || pideMasEconomico) {
			const busquedaGuardada = context?.ultimaBusqueda;
			if (busquedaGuardada?.results?.length > 0) {
				products = busquedaGuardada.results;

				if (pideMasEconomico) {
					products = [...products].sort((a: any, b: any) => {
						const pa = parseFloat(a.price || '999999999');
						const pb = parseFloat(b.price || '999999999');
						return pa - pb;
					});
					productoIndex = 0;
					
					const catBusqueda = busquedaGuardada.categoria || context?.terminoBusqueda || '';
					if (catBusqueda) {
						try {
							const masProductos = await wooCommerceService.searchProducts(catBusqueda, 20);
							if (masProductos?.length > 0) {
								const idsExistentes = new Set(products.map((p: any) => p.id));
								const nuevos = masProductos.filter((p: any) => !idsExistentes.has(p.id));
								products = [...products, ...nuevos].sort((a: any, b: any) => {
									const pa = parseFloat(a.price || '999999999');
									const pb = parseFloat(b.price || '999999999');
									return pa - pb;
								});
							}
						} catch { /* continuar con lo que tenemos */ }
					}
				} else {
					productoIndex = (busquedaGuardada.productoIndex ?? 0) + 1;
					if (productoIndex >= products.length) {
						let terminoReSearch = busquedaGuardada.categoria || context?.terminoBusqueda || '';
						if (!terminoReSearch) {
							const primerProd = products[0]?.name || '';
							const catMatch = primerProd.match(/(?:Nevera|Lavadora|Televisor|TV|Congelador|Parlante|Licuadora|Horno|Microondas|Estufa|Ventilador|Aire|Plancha|Aspiradora)/i);
							if (catMatch) terminoReSearch = catMatch[0].toLowerCase();
						}
						if (terminoReSearch) {
							try {
								const masProductos = await wooCommerceService.searchProducts(terminoReSearch, 20);
								if (masProductos?.length > 0) {
									const idsExistentes = new Set(products.map((p: any) => p.id));
									const nuevos = masProductos.filter((p: any) => !idsExistentes.has(p.id));
									if (nuevos.length > 0) {
										products = [...products, ...nuevos];
										productoIndex = busquedaGuardada.productoIndex ?? 0;
									} else {
										productoIndex = products.length;
									}
								} else {
									productoIndex = products.length;
								}
							} catch {
								productoIndex = products.length;
							}
						} else {
							productoIndex = products.length;
						}
					}
				}
			} else {
				return {
					response: `${ciudadStr} ${envioStr}. ¿Qué referencia o modelo buscas? Así te muestro lo que tenemos disponible 😊`,
					metadata: { agentType: 'ventas', ciudad: context?.ciudad, ciudadValidada: context?.ciudadValidada },
				};
			}
		}

		if (products.length === 0) {
			// Si ya hay resultados de una búsqueda anterior y el mensaje actual
			// no contiene un término de producto claro, reusar los anteriores
			const productoPrevio = context?.userData?.productoSolicitado || context?.productoSolicitado;
			if (context?.ultimaBusqueda?.results?.length > 0 && !/comprar|cotizar|busco|quiero|necesito|hay|venden|tienes/i.test(message)) {
				products = context.ultimaBusqueda.results.slice(0, 6);
				hayProductos = true;
				productoBuscado = context?.ultimaBusqueda?.categoria || context?.terminoBusqueda || 'producto';
			} else if (productoPrevio && !productoBuscado.includes(productoPrevio) && productoBuscado === terminoBusqueda && terminoBusqueda === message) {
				// El mensaje actual no parece contener un producto, usar el producto previo de UserData
				productoBuscado = productoPrevio;
				terminoBusqueda = productoPrevio;
			}

			const esConsultaProducto = /(?:tiene[ns]?|hay|venden|busco|quiero|necesito|me interesa|consulta|precio|cu[aá]nto)/i.test(message);

			if (context?.productosPreCargados?.length > 0) {
				products = context.productosPreCargados;
				hayProductos = true;
			} else {
				try {
					if (!products || products.length === 0) {
						products = await wooCommerceService.searchProducts(terminoBusqueda, 20);
					}

					if (!products || products.length === 0) {
						const palabrasClave = terminoBusqueda
							.toLowerCase()
							.replace(/[.,!?¡¿]+/g, '')
							.split(/\s+/)
							.filter((w: string) => w.length > 3)
							.filter((w: string) => !['para', 'con', 'mas', 'más', 'que', 'una', 'uno', 'las', 'los', 'del', 'por', 'pero', 'esta', 'todo', 'como', 'entre', 'sobre', 'cuando', 'donde', 'tiene', 'ser', 'desde', 'hasta', 'cada'].includes(w));

						for (const keyword of palabrasClave) {
							const results = await wooCommerceService.searchProducts(keyword, 20);
							if (results && results.length > 0) {
								products = results;
								break;
							}
						}
					}

					if (!products || products.length === 0) {
						const categoriaFallback = await detectarCategoria(message);
						if (categoriaFallback) {
							const results = await wooCommerceService.searchProducts(categoriaFallback, 20);
							if (results?.length > 0) products = results;
						}
					}

					if ((!products || products.length === 0) && esConsultaProducto) {
						const nombreProducto = busquedaMatch?.[1]?.trim().toLowerCase() || terminoBusqueda.toLowerCase();
						return {
							response: `En este momento no tenemos ${nombreProducto} disponible en nuestro catálogo. ¿Hay algo más en lo que te pueda ayudar? 😊`,
							metadata: {
								agentType: 'ventas',
								ciudadValidada: context?.ciudadValidada,
								ciudad: context?.ciudad,
								...datosPersonales,
							},
						};
					}

					if (!products || products.length === 0) {
						return {
							response: `Cuéntame, ¿qué producto te gustaría ver? Tenemos neveras, lavadoras, televisores, congeladores, parlantes, y más. 😊`,
							metadata: {
								agentType: 'ventas',
								ciudadValidada: context?.ciudadValidada,
								ciudad: context?.ciudad,
								modalidad: context?.modalidad,
								tieneCobertura: context?.tieneCobertura,
								...datosPersonales,
							},
						};
					}

					hayProductos = products?.length > 0;
				} catch {
					// products = []
				}
			}
		}

		const productListStr = products.length > 0
			? products.slice(0, 6).map((p: any, i: number) => {
				const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar precio';
				// Limpiar descripción HTML y truncar a 200 chars para dar contexto al LLM
				const rawDesc: string = (p.short_description || p.description || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
				const desc = rawDesc.length > 200 ? rawDesc.slice(0, 197) + '...' : rawDesc;
				return `${i + 1}. ${p.name} - ${precio}\n   Enlace: ${p.permalink}${desc ? `\n   Detalles: ${desc}` : ''}`;
			}).join('\n\n')
			: 'No se encontraron productos.';

		const userDataStr = buildUserDataContext(context?.userData);

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres ${AGENT_NAME}, asesora comercial y experta en electrodomésticos de JLC Electronics Colombia.
Personalidad y Estilo:
- Tono 100% cálido, cercano, servicial y FEMENINO. Eres como una amiga que asesora con criterio y cariño.
- Español colombiano natural (usa expresiones como "¡Ay, qué chévere!", "Te cuento que...", "Mira, te recomiendo...", "Qué pena pero...", "¡Ay, me alegra!").
- EVITA palabras masculinas o de jerga: NO uses "bacano", "buenazo", "genial" — usa "chévere", "qué maravilla", "ideal", "perfecto".
- Muestra criterio y opinión propia sobre los productos para guiar al cliente.
- Mensajes cortos tipo WhatsApp (máximo 1-3 frases por respuesta). Nada de listados enormes.
- IMPORTANTE: Usa el género gramatical correcto según el producto. Televisores y ventiladores son MASCULINOS ("el de 55 pulgadas", "el ventilador"). Neveras y lavadoras son FEMENINAS ("la nevera de 20 pies"). NO digas "la de 55 pulgadas" para un televisor.

${ciudadStr ? `Ciudad del cliente: ${ciudadStr}.` : ''} ${envioStr ? `Condición de envío: ${envioStr}.` : ''}
${userDataStr}
REGLAS DE CATÁLOGO:
- Si el cliente pregunta por detalles, especificaciones, características o diferencias de un producto que YA está en el CATÁLOGO, respóndele usando la información de "Detalles" del catálogo. NO hagas una nueva búsqueda.
- Si el cliente menciona "la primera opción", "el de 55", "el primero", o algo similar, identifica a qué producto del catálogo se refiere y dale la información pedida.
- Recomienda máximo 1-2 productos del CATÁLOGO con nombre, precio y enlace.
- Si hay productos, preséntalos de forma natural y breve.
- Si NO hay productos en el catálogo, dilo honestamente.
- NUNCA inventes productos, precios ni disponibilidad.
- NUNCA compartas direcciones de agencias físicas.
- NUNCA contradigas la condición de envío ya comunicada al cliente.
- Si el cliente ya dio datos (nombre, cédula, ciudad, presupuesto), úsalos sin pedirlos de nuevo.
- Si el cliente pide un producto NUEVO o diferente al anterior, ayúdale con eso.
- PROHIBIDO confirmar envío o despacho si el cliente no ha pagado. Di "tan pronto se confirme el pago".
- Si el cliente dice que ya pagó, pide el comprobante o número de transacción.
- NUNCA compartas números de WhatsApp de cartera, correos de facturación ni números de soporte de pago.
- NUNCA digas "generé tu orden de compra" ni "tu orden quedó lista". Di que el producto queda reservado pendiente a su pago.
- Si NO encontraste el producto exacto que busca, NO le recomiendes productos de otra categoría.
- NUNCA recomiendes productos que el cliente NO pidió.`,
			ejemplos: [
				{
					cliente: 'Busco una nevera',
					asistente: 'Tenemos varias opciones en neveras. Te recomiendo la Nevera JLC No Frost 251L por $1.399.900. ¿Te interesa o quieres ver más opciones?',
				},
				{
					cliente: 'también quiero una lavadora',
					asistente: 'Claro, tenemos lavadoras también. Te recomiendo la Lavadora JLC Automática 16kg. ¿Quieres que te la busque?',
				},
				{
					cliente: 'y no hay más?',
					asistente: 'Déjame verificar si tenemos otras opciones disponibles en este momento.',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const catalogPrompt = `\n\nCATÁLOGO DE PRODUCTOS:\n${productListStr}\n\n---\nResponde al cliente según las reglas anteriores.`;

		const raw = await generateResponse(user + catalogPrompt, system);
		const response = cleanResponse(raw);

		return {
			response,
			...(preguntaSeguimiento ? { nextStage: 'PROPOSAL' } : {}),
			metadata: {
				agentType: 'ventas',
				productosEncontrados: hayProductos,
				ciudadValidada: context?.ciudadValidada,
				ciudad: context?.ciudad,
				modalidad: context?.modalidad,
				tieneCobertura: context?.tieneCobertura,
				...(productoBuscado.length < 30 && productoBuscado.split(/\s+/).length <= 5 && !/[?¿]/.test(productoBuscado) ? { productoSolicitado: productoBuscado } : {}),
				ultimaBusqueda: products.length > 0
					? { results: products.slice(0, 6), productoIndex, categoria: detectarCategoria(terminoBusqueda) || undefined }
					: undefined,
				...datosPersonales,
			},
		};
	}

	// ── Finalizar: Problema con la página web ──────────────────────────────────
	private async finalizarProblemaWeb(message: string, context: any): Promise<AgentResponse> {
		const pd = context?.problemaWebData || {};
		pd.nombreCliente = context?.userData?.nombre || pd.nombreCliente || '';
		pd.cedulaCliente = context?.userData?.cedula || pd.cedulaCliente || '';
		pd.ciudad = context?.userData?.ciudad || context?.ciudad || pd.ciudad || '';

		const notaJson = JSON.stringify({
			tipo: 'PROBLEMA_WEB',
			fecha: new Date().toISOString(),
			cliente: pd.nombreCliente,
			cedula: pd.cedulaCliente,
			telefono: context?.telefono || '',
			ciudad: pd.ciudad,
			detalle: pd.detalle || message,
			causa: pd.causa || '',
		});

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres Sara, asesora virtual de JLC Electronics Colombia. El cliente reportó un problema con la página web. Datos: ${notaJson}. Instrucción: Responde con un mensaje cálido, empático, en español colombiano femenino. Dile que su reporte ya fue enviado a nuestro equipo especializado y que un asesor se comunicará con él en breve. NO le pidas más datos, NI soluciones técnicas, NI que intente de nuevo. Solo empatía y que será contactado. Usa emojis variados.`,
			ejemplos: [
				{
					cliente: 'No pude pagar, la página no cargó',
					asistente: '¡Ay, qué pena que hayas tenido ese inconveniente! 😟 Ya quedó registrado tu reporte y nuestro equipo especializado va a revisarlo. En breve un asesor se comunicará contigo para ayudarte. ¡Gracias por avisarnos! 💙🙌',
				},
			],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: {
				agentType: 'ventas',
				flujo: null,
				notificarProblemaWeb: true,
				problemaWebData: pd,
				notaJson,
			},
		};
	}
}
