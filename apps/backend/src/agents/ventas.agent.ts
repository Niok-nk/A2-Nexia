import { IAgent, AgentResponse, CreditoData, CreditoStep } from './types.js';
import {
	CATEGORIAS_RE,
	PROFILING_STEPS,
	resolverRespuestaPerfil,
	detectarCategoria,
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
 * Intenta hacer match de un mensaje de usuario con un producto de la lista.
 * Soporta: ordinales masc/fem, índice numérico corto, specs numéricas en el nombre, nombre parcial.
 */
function matchProductoDesdeMsg(msg: string, productos: any[]): any | null {
	if (!productos || productos.length === 0) return null;
	const lowerMsg = msg.toLowerCase().trim();

	// 1. Ordinal explícito (masculino y femenino)
	const ORDINALS: Array<[RegExp, number]> = [
		[/\b(?:primer[oa]|primera\s+opci[oó]n|el\s+primero|la\s+primera|uno|1[aº]?)\b/, 0],
		[/\b(?:segund[oa]|segunda\s+opci[oó]n|el\s+segundo|la\s+segunda|dos|2[aº]?)\b/, 1],
		[/\b(?:tercer[oa]|tercera\s+opci[oó]n|el\s+tercero|la\s+tercera|tres|3[aº]?)\b/, 2],
		[/\b(?:cuart[oa]|cuarta\s+opci[oó]n|el\s+cuarto|la\s+cuarta|cuatro|4[aº]?)\b/, 3],
		[/\b(?:quint[oa]|quinta\s+opci[oó]n|el\s+quinto|la\s+quinta|cinco|5[aº]?)\b/, 4],
	];
	for (const [re, idx] of ORDINALS) {
		if (re.test(lowerMsg) && idx < productos.length) {
			return productos[idx];
		}
	}

	// 2. Índice numérico corto ("1", "2", "3" — máx 2 caracteres para no confundir con specs)
	const shortNum = parseInt(lowerMsg, 10);
	if (!isNaN(shortNum) && lowerMsg.length <= 2 && shortNum >= 1 && shortNum <= productos.length) {
		return productos[shortNum - 1];
	}

	// 3. Nombre parcial: el mensaje incluye parte del nombre del producto o viceversa
	const byName = productos.find((p: any) => {
		const nameLower = p.name.toLowerCase();
		return nameLower.includes(lowerMsg) || lowerMsg.includes(nameLower.slice(0, 20));
	});
	if (byName) return byName;

	// 4. Número de specs presente en el mensaje que aparece en el nombre del producto
	//    Ej: "55" matchea "Televisor JLC 55 pulgadas"
	const numbersInMsg = lowerMsg.match(/\b\d{2,}\b/g);
	if (numbersInMsg && numbersInMsg.length > 0) {
		const candidates = productos.filter((p: any) =>
			numbersInMsg.some((num: string) => p.name.toLowerCase().includes(num))
		);
		if (candidates.length >= 1) return candidates[0];
	}

	return null;
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
							const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar';
							return `${i + 1}️⃣ *${p.name}* - ${precio}`;
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
					response: '¡Excelente! Sigamos. ¿Desde qué ciudad o municipio nos escribes? 📍',
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_ciudad',
						pendingMessage: context?.pendingMessage,
					},
				};
			} else {
				context.flujo = null;
				return {
					response: 'Entendido, cancelamos la consulta. ¿En qué más te puedo ayudar hoy? 😊',
					metadata: { agentType: 'ventas', flujo: null },
				};
			}
		}

		if (context?.flujo === 'esperando_modalidad_pausado') {
			const quiereContinuar = /s[ií]|dale|ok|bueno|claro|por favor|seguir|continuar/i.test(lower);
			if (quiereContinuar) {
				context.flujo = 'esperando_modalidad';
				return {
					response: '¡Súper! Cuéntame, ¿la compra sería al *contado* o a *crédito*?',
					metadata: {
						agentType: 'ventas',
						flujo: 'esperando_modalidad',
						ciudad: context?.ciudad,
						ciudadValidada: true,
						tieneCobertura: context?.tieneCobertura,
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
			if (quiereContinuar) {
				context.flujo = 'perfilando';
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
			
			// Usar helper centralizado de matching (soporta ordinales masc/fem, specs, nombre parcial)
			const selected: any = matchProductoDesdeMsg(opcion, ultimosProductos);

			if (selected) {
				const precioStr = selected.price ? ` tiene un valor de *$${Number(selected.price).toLocaleString('es-CO')}*` : '';
				const linkStr = selected.permalink ? `\nAquí tienes el enlace del producto:\n${selected.permalink}` : '';
				const ciudadStr = context?.ciudad ? ` con envío gratis a ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
				const opcionPuntoFisico = context?.tieneCobertura ? '\n3️⃣ Paga en un punto físico' : '';
				
				return {
					response: `¡Perfecto! El *${selected.name}*${precioStr}${ciudadStr}.${linkStr}\n\n¿Cómo prefieres realizar el pago? 💳\n1️⃣ Por transferencia bancaria (medios autorizados)\n2️⃣ Directamente en nuestra página web (PSE, Tarjeta, Nequi)${opcionPuntoFisico}\n\nEscríbeme el número de tu opción y te doy las instrucciones paso a paso. 😊`,
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
				return {
					response: `¡Qué bien! A ${ciudadCap} te llega con envío gratis 🚚\n\n¿La compra sería al *contado* o a *crédito*?`,
					metadata: {
						agentType: 'ventas',
						ciudad: ciudadDetectada,
						ciudadValidada: true,
						tieneCobertura: true,
						flujo: 'esperando_modalidad',
					},
				};
			}

			return {
				response: `${getSaludo()} ¡Qué bien! En ${ciudadCap} no tenemos cobertura directa, el envío sería por Coordinadora (el flete se cobra al hacer el pedido).\n\nCuéntame, ¿qué producto o referencia buscas? 😊`,
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

		// ── SI ESTAMOS ESPERANDO MODALIDAD (contado / crédito) ─────────────
		if (context?.flujo === 'esperando_modalidad') {
			const quiereCredito = /cr[eé]dito|a cr[eé]dito|financiar|financiaci[oó]n|cuotas|pagar a cuotas|1/i.test(lower);
			const quiereContado = /contado|efectivo|pago inmediato|precio de contado|contadito|2/i.test(lower);

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
					},
				};
			}

			if (quiereContado) {
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
				},
			};
		}

		// ── PASO 1: Validar cobertura si aún no se hizo (mejoras #2 y #4) ─────
		if (!context?.ciudadValidada) {
			const ciudadDetectada = await extraerCiudadDelMensaje(message);

			if (!ciudadDetectada) {
				return {
					response: `Para poder ayudarte mejor, ¿desde qué ciudad o municipio nos escribes? 📍`,
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
					},
				};
			}

			context = {
				...context,
				ciudadValidada: true,
				ciudad: ciudadDetectada,
				tieneCobertura: false,
			};
			return {
				response: `${getSaludo()} En ${ciudadDetectada} no tenemos cobertura directa, el envío sería por Coordinadora (el flete se cobra al hacer el pedido).\n\nCuéntame, ¿qué producto o referencia buscas? 😊`,
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
		const quiereComprar = /\b(?:comprar(?:lo|la)?|lo quiero|la quiero|quiero esa|quiero esta|quiero ese|quiero este|quiero comprar|c[oó]mo (?:compro|hago|puedo pagar|le hago|le hago para pagar|pago)|quiero pagar|proceder|concretar|compralo|c[oó]mpralo|reservar|apartar|d[áa]le|confirmo compra|ya lo quiero|me gusta esa|me gusta esta|me gusta ese|esa me gusta|esta me gusta|si continuemos|si sigamos|sigamos adelante|seguimos|continuemos)\b|\bcompr(?:o|ar)\s+(?:esa|esta|este|ese|eso|esas|esos|estes)\b|\b(?:el de \d+|la de \d+|el primero|el segundo|la primera|la segunda|me quedo con|me interesa el|me interesa la|prefiero el|prefiero la|lo compro|la compro|eso quiero|eso me sirve|eso me gusta|me gusta el|me gusta la|me llevo el|me llevo la)\b|\b(?:el (?:de \d+|primero|segundo)|la (?:de \d+|primera|segunda))\b/i.test(message) && context?.ultimaBusqueda?.results?.length > 0;

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
				// Usar helper centralizado (ordinales masc/fem, specs, nombre parcial)
				const matchResult = matchProductoDesdeMsg(message, ultimosProductos);
				
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
			const pasoActual = context?.pasoWeb ?? 1;
			const pasos = [
				'Abre el enlace del producto y dale clic en "Añadir al carrito" o "Comprar".',
				'En el carrito, selecciona tu departamento y dale "Actualizar". Ahí te aparecen los municipios y ciudades.',
				'Selecciona tu municipio, pon el código postal y dale "Actualizar" de nuevo. Ahí se calcula el flete y confirmas si tienes envío gratis.',
				'Revisa que todo esté bien y dale "Proceder al pago". Rellena tus datos personales.',
				'Elige tu método de pago en Wompi (PSE, tarjeta, Nequi) y confirma. ¡Listo, ya quedó! 🎉',
			];
			if (pasoActual <= pasos.length) {
				const pasoMsg = `Paso ${pasoActual} de ${pasos.length}: ${pasos[pasoActual - 1]}`;
				const siguiente = pasoActual < pasos.length
					? '\n\nDime "listo" cuando termines o "ayuda" si tienes algún problema. 😊'
					: '\n\n¿Lograste completar el pago? Si tuviste algún inconveniente, cuéntame y te ayudo.';
				return {
					response: pasoMsg + siguiente,
					metadata: {
						agentType: 'ventas',
						flujo: pasoActual < pasos.length ? 'pago_web_paso' : 'pago_completado',
						pasoWeb: pasoActual + 1,
						ciudad: context?.ciudad,
						ciudadValidada: true,
						productoURL: context?.productoURL,
					},
				};
			}
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
			const quiereAyuda = /\bs[íi]\b|sip|dale|ok|bueno|claro|si gracias|si por favor/i.test(lower);
			if (quiereAyuda) {
				return {
					response: `Paso 1: Añade el producto al carrito de compras.\n\nCuando termines, dime "listo" para continuar con el siguiente paso.`,
					metadata: {
						agentType: 'ventas',
						flujo: 'pago_web_paso',
						pasoWeb: 2,
						ciudad: context?.ciudad,
						ciudadValidada: true,
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

		// ── PASO 5: Flujo de selección de pago ──────────────────────────────
		if (context?.flujo === 'seleccion_pago') {
			const opcion = message.trim();
			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			const productoURL = context?.productoURL ?? ultimosProductos[0]?.permalink;

			if (/1|transferencia|medios de pago|medios autorizados/i.test(opcion)) {
				return {
					response: `Estos son nuestros medios de pago autorizados:\nhttps://jlc-electronics.com/wp-content/uploads/2026/05/Medios_de_pago.jpeg\n\nAhí verás todas las cuentas disponibles (Bancolombia, Davivienda, Nequi, etc.). Una vez realices la transferencia, por favor compárteme tu nombre completo, número de cédula y el comprobante de pago para programar tu envío gratis de inmediato.\n\n¿Pudiste completar el pago o te surgió alguna duda? 😊`,
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
						nextStage: 'PROPOSAL',
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
								...datosPersonales,
							},
						};
					}
				}
			}
		}

		// ── Flujo normal de ventas (mostrar productos) ──────────────────────
		const ciudadStr = context?.ciudad ? `En ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
		const envioStr = context?.tieneCobertura
			? 'tienes envío gratis'
			: 'pago de contado (flete por Coordinadora a cargo del cliente)';

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
						const terminoReSearch = busquedaGuardada.categoria || context?.terminoBusqueda || '';
						if (terminoReSearch) {
							products = [];
							terminoBusqueda = terminoReSearch;
						} else {
							productoIndex = products.length;
						}
					}
				}
			} else {
				return {
					response: `${ciudadStr} ${envioStr}. ¿Qué referencia o modelo buscas? Así te muestro lo que tenemos disponible 😊`,
					nextStage: 'PROPOSAL',
					metadata: { agentType: 'ventas', ciudad: context?.ciudad, ciudadValidada: context?.ciudadValidada },
				};
			}
		}

		if (products.length === 0) {
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

					if ((!products || products.length === 0) && esConsultaProducto) {
						const nombreProducto = busquedaMatch?.[1]?.trim().toLowerCase() || terminoBusqueda.toLowerCase();
						return {
							response: `En este momento no tenemos ${nombreProducto} disponible en nuestro catálogo. ¿Hay algo más en lo que te pueda ayudar? 😊`,
							nextStage: 'PROPOSAL',
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
							nextStage: 'PROPOSAL',
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
			nextStage: 'PROPOSAL',
			metadata: {
				agentType: 'ventas',
				productosEncontrados: hayProductos,
				ciudadValidada: context?.ciudadValidada,
				ciudad: context?.ciudad,
				modalidad: context?.modalidad,
				tieneCobertura: context?.tieneCobertura,
				productoSolicitado: productoBuscado,
				ultimaBusqueda: products.length > 0
					? { results: products.slice(0, 6), productoIndex, categoria: detectarCategoria(terminoBusqueda) || undefined }
					: undefined,
				...datosPersonales,
			},
		};
	}
}
