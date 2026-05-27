import { WAMessage } from '@whiskeysockets/baileys';
import prisma from '../db/index.js';
import { orchestrator } from '../agents/orchestrator.js';
import { extractAndSaveData } from '../agents/data-extractor.js';
import { sendMessage, resolvePhoneFromJid } from './whatsapp.js';
import logger from '../utils/logger.js';

function safeParseJson(str: string | null | undefined): any {
	if (!str) return {};
	try {
		return JSON.parse(str);
	} catch {
		return {};
	}
}

const CIUDADES_CONOCIDAS = [
	'pasto', 'tumaco', 'ipiales', 'samaniego', 'barbacoas', 'sandoná', 'sandona',
	'popayán', 'popayan', 'quilichao', 'miranda', 'puerto tejada', 'piendamó', 'piendamo',
	'mocoa', 'puerto asís', 'puerto asis', 'orito', 'sibundoy', 'villagarzón', 'villagarzon',
	'neiva', 'pitalito', 'garzón', 'garzon', 'campoalegre',
	'cali', 'buenaventura', 'palmira', 'tuluá', 'tulua', 'buga', 'cartago', 'jamundí', 'jamundi', 'yumbo',
	'el peñol', 'peñol', 'bogotá', 'bogota',
];

const DEPARTAMENTOS_CONOCIDOS = [
	'nariño', 'narino', 'cauca', 'putumayo', 'huila', 'valle', 'valle del cauca', 'cundinamarca',
];

function extraerUbicacion(mensaje: string): { ciudad: string | null; departamento: string | null } {
	const lower = mensaje.toLowerCase().trim();

	let ciudad: string | null = null;
	let departamento: string | null = null;

	const depEncontrado = DEPARTAMENTOS_CONOCIDOS.find((d) => lower.includes(d));
	if (depEncontrado) departamento = depEncontrado;

	const ciudadEncontrada = CIUDADES_CONOCIDAS.find((c) => lower.includes(c));
	if (ciudadEncontrada) ciudad = ciudadEncontrada;

	// Si no se encontró ciudad conocida pero sí departamento,
	// usar el texto completo como ciudad (ej: "el peñol nariño")
	if (!ciudad && departamento) {
		const idx = lower.indexOf(departamento);
		const antes = lower.slice(0, idx).trim();
		if (antes.length > 2) ciudad = antes;
	}

	// Patrones como "soy de X", "vivo en X"
	if (!ciudad && !departamento) {
		const patron = /(?:soy de|estoy en|vivo en|escribo desde|desde|ubicado en|me encuentro en)\s+([a-záéíóúñ\s]{3,30})/i;
		const match = mensaje.match(patron);
		if (match) {
			const texto = match[1].trim().toLowerCase();
			const dep2 = DEPARTAMENTOS_CONOCIDOS.find((d) => texto.includes(d));
			if (dep2) departamento = dep2;
			const ciu2 = CIUDADES_CONOCIDAS.find((c) => texto.includes(c));
			if (ciu2) ciudad = ciu2;
			if (!ciu2) ciudad = texto;
		}
	}

	return { ciudad, departamento };
}

/**
 * Maneja cada mensaje entrante de WhatsApp:
 * 1. Busca o crea el Contact en BD
 * 2. Persiste el mensaje INBOUND
 * 3. Obtiene el historial reciente como contexto
 * 4. Enruta al orquestador de agentes IA
 * 5. Persiste la respuesta OUTBOUND
 * 6. Actualiza el Lead con la etapa y módulo correctos
 * 7. Envía la respuesta por WhatsApp
 */
export async function handleIncomingMessage(msg: WAMessage): Promise<void> {
	const remoteJid = msg.key.remoteJid || '';
	const fromMe = !!msg.key.fromMe;

	logger.info({ msgFrom: remoteJid, msgFromMe: fromMe }, 'Message event received');

	// Ignorar mensajes del propio número
	if (fromMe) {
		logger.info('Ignoring message fromMe');
		return;
	}
	
	// Ignorar mensajes de grupos y broadcasts
	if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) {
		logger.info({ remoteJid }, 'Ignoring group or broadcast message');
		return;
	}

	// 1. Extraer el identificador único del JID (el que dice telefono lo ponemos como id)
	let phone = remoteJid;
	if (phone.includes('@s.whatsapp.net')) {
		phone = phone.replace('@s.whatsapp.net', '');
	} else if (phone.includes('@lid')) {
		phone = phone.replace('@lid', '');
	} else if (phone.includes('@c.us')) {
		phone = phone.replace('@c.us', '');
	}

	// 2. Intentar resolver el número de teléfono real
	const realPhone = await resolvePhoneFromJid(remoteJid);

	// Extraer el texto del mensaje admitiendo diferentes formatos de mensaje de Baileys
	const body = (
		msg.message?.conversation ||
		msg.message?.extendedTextMessage?.text ||
		msg.message?.imageMessage?.caption ||
		msg.message?.videoMessage?.caption ||
		''
	).trim();

	if (!body) {
		logger.warn({ phone }, 'Empty message body, ignoring');
		return;
	}

	logger.info({ phone, realPhone, body: body.slice(0, 80) }, 'Incoming WA message');

	try {
		const { response, agentType } = await processIncomingMessage(phone, body, realPhone);

		// 10. Enviar respuesta por WhatsApp (intentar aunque el status no sea 'connected')
		//     Baileys puede recibir mensajes incluso cuando isReady = false
		const sendTo = realPhone || phone;
		try {
			await sendMessage(sendTo, response);
			logger.info({ phone, realPhone, sendTo, agentType }, 'Response sent');
		} catch (err) {
			logger.warn({ phone, sendTo, agentType, error: err }, 'Failed to send WhatsApp response');
		}
	} catch (error) {
		logger.error({ error, phone }, 'Error handling incoming message');

		// Intentar enviar mensaje de error al usuario
		try {
			const fallbackResponse = 'Lo siento, hubo un problema procesando tu mensaje. Por favor intenta de nuevo en un momento.';
			await sendMessage(realPhone || phone, fallbackResponse);

				// Intentar buscar el contacto y persistir la respuesta de error de fallback en BD
			const contact = await prisma.contact.findUnique({
				where: { phone },
			});

			if (contact) {
				await prisma.message.create({
					data: {
						contactId: contact.id,
						direction: 'OUTBOUND',
						body: fallbackResponse,
						agentType: 'SYSTEM',
					},
				});
			}
		} catch (err) {
			logger.error({ err }, 'Failed to send or save fallback error message');
		}
	}
}

export async function processIncomingMessage(
	phone: string,
	body: string,
	realPhone: string | null = null
): Promise<{ response: string; agentType: string; contactId?: string; leadId?: string }> {
	// 1. Upsert del contacto
	const contact = await (prisma.contact as any).upsert({
		where: { phone },
		update: {
			...(realPhone !== phone ? { realPhone } : {})
		},
		create: { 
			phone,
			realPhone: realPhone !== phone ? realPhone : (phone.startsWith('158') && phone.length >= 14 ? null : phone)
		},
	});

	// 2. Obtener historial reciente (últimos 10 mensajes) ANTES de guardar el INBOUND
	//    para que el orquestador pueda detectar si es el primer mensaje (hasHistory = false)
	const history = await prisma.message.findMany({
		where: { contactId: contact.id },
		orderBy: { sentAt: 'desc' },
		take: 30,
	});

	// Guardamos INBOUND para persistencia; el routing usa `history` (sin este mensaje)
	// para detectar correctamente hasHistory en isGreetingOrVague
	await prisma.message.create({
		data: {
			contactId: contact.id,
			direction: 'INBOUND',
			body,
		},
	});

	// 4. Detectar nueva sesión: cliente que ya tenía conversaciones previas y vuelve a saludar
	//    Esto crea un nuevo Lead (instancia independiente) para preservar los datos anteriores.
	const tieneHistorial = history.length > 0;
	const esNuevaSesion = tieneHistorial && orchestrator.esSaludo(body);

	if (esNuevaSesion) {
		logger.info({ phone, contactId: contact.id }, 'Nueva sesión detectada — se creará un nuevo Lead');
	}

	// 5. Lead activo del contacto (el más reciente), omitido si es nueva sesión
	let lead = esNuevaSesion
		? null
		: await prisma.lead.findFirst({
			where: { contactId: contact.id },
			orderBy: { createdAt: 'desc' },
		});

	// 6. Cargar UserData persistido (datos recolectados por la IA progresivamente)
	let userDataRecord = lead
		? await prisma.userData.findUnique({ where: { leadId: lead.id } })
		: null;

	const userData = {
		ciudad: userDataRecord?.ciudad ?? null,
		departamento: userDataRecord?.departamento ?? null,
		nombre: userDataRecord?.nombre ?? null,
		cedula: userDataRecord?.cedula ?? null,
		productoSolicitado: userDataRecord?.productoSolicitado ?? null,
		direccion: userDataRecord?.direccion ?? null,
		telefono: userDataRecord?.telefono ?? null,
		presupuesto: userDataRecord?.presupuesto ?? null,
		extra: safeParseJson(userDataRecord?.extra),
	};

	// Intentar extraer ciudad y departamento directamente del mensaje actual
	const { ciudad: ciudadDelMensaje, departamento: deptoDelMensaje } = extraerUbicacion(body);
	if (ciudadDelMensaje && !userData.ciudad) {
		userData.ciudad = ciudadDelMensaje;
	}
	if (deptoDelMensaje && !userData.departamento) {
		userData.departamento = deptoDelMensaje;
	}

	// Guardar en UserData INMEDIATAMENTE si se detectó ubicación y el lead existe
	if (lead && (ciudadDelMensaje || deptoDelMensaje)) {
		const saveData: Record<string, any> = {};
		if (ciudadDelMensaje && !userDataRecord?.ciudad) saveData.ciudad = ciudadDelMensaje;
		if (deptoDelMensaje && !userDataRecord?.departamento) saveData.departamento = deptoDelMensaje;
		if (Object.keys(saveData).length > 0) {
			await prisma.userData.upsert({
				where: { leadId: lead.id },
				update: saveData,
				create: { leadId: lead.id, ...saveData },
			}).catch(e => logger.error({ error: e.message }, 'Failed to save location to UserData'));
		}
	}

	const context: Record<string, any> = {
		contactId: contact.id,
		phone,
		leadId: lead?.id,
		stage: lead?.stage ?? 'INITIAL',
		module: lead?.module ?? 'VENTAS',
		history: history.reverse().map((m) => ({
			direction: m.direction,
			body: m.body,
			sentAt: m.sentAt,
		})),
		userData,
		nuevaSesion: esNuevaSesion,
	};

	// Si ya tenemos ciudad guardada, pre-poblamos el contexto
	// para que los agentes no vuelvan a preguntar
	if (userData.ciudad) {
		context.ciudad = userData.ciudad;
		context.ciudadValidada = true;
	}

	// Restaurar flujo y pendingMessage desde UserData.extra
	// para que el agente sepa que estábamos esperando ciudad/producto/etc.
	const extra = userData.extra ?? null;
	if (extra?.flujo && typeof extra.flujo === 'string') context.flujo = extra.flujo;
	if (extra?.pendingMessage) context.pendingMessage = extra.pendingMessage;
	if (extra?.ultimaBusqueda) context.ultimaBusqueda = extra.ultimaBusqueda;
	if (extra?.perfilState) context.perfilState = extra.perfilState;
	if (typeof extra?.tieneCobertura === 'boolean') context.tieneCobertura = extra.tieneCobertura;
	if (extra?.modalidad) context.modalidad = extra.modalidad;
	if (extra?.flujoAnterior) context.flujoAnterior = extra.flujoAnterior;
	if (extra?.creditoOptions) context.creditoOptions = extra.creditoOptions;
	if (extra?.creditoData) context.creditoData = extra.creditoData;
	if (typeof extra?.creditoStep === 'number') context.creditoStep = extra.creditoStep;
	if (extra?.productoURL) context.productoURL = extra.productoURL;
	if (extra?.productoCompra) context.productoCompra = extra.productoCompra;

	// 7. Enrutar al orquestador
	const { agentType, response, metadata } = await orchestrator.route(body, context);

	// 8. Persistir respuesta OUTBOUND
	await prisma.message.create({
		data: {
			contactId: contact.id,
			direction: 'OUTBOUND',
			body: response,
			agentType,
		},
	});

	// 9. Crear o actualizar lead
	const moduleMap: Record<string, string> = {
		ventas: 'VENTAS',
		cartera: 'CARTERA',
		servicio_tecnico: 'SERVICIO_TECNICO',
		repuestos: 'REPUESTOS',
		vacantes: 'VACANTES',
		distribuidores: 'DISTRIBUIDORES',
		pagos: 'MEDIOS_DE_PAGO',
	};

	const crmModule = moduleMap[agentType] ?? 'VENTAS';

	if (!lead) {
		lead = await prisma.lead.create({
			data: {
				contactId: contact.id,
				stage: 'INITIAL',
				type: 'CONSULTA',
				module: crmModule,
			},
		});
	} else if (lead.module !== crmModule) {
		// Si el módulo cambió, el orquestador reasignó al contacto
		lead = await prisma.lead.update({
			where: { id: lead.id },
			data: { module: crmModule },
		});
	}

	// 10. Guardar datos recolectados por la IA en UserData
	if (lead) {
		const ud: Record<string, any> = {};

		// ── Notificaciones internas (punto físico, escalamiento) ──────────
		if (metadata?.notificarPuntoFisico || metadata?.escalado) {
			const WA_ESCALAMIENTO = process.env.WA_ESCALAMIENTO || '573187408190';
			const ciudadInfo = metadata?.ciudad || userData.ciudad || 'ciudad no especificada';
			const productoInfo = metadata?.productoCompra || userData.productoSolicitado || 'producto pendiente';
			const nombreInfo = userData.nombre || 'nombre pendiente';

			let notifMsg = '';
			if (metadata?.notificarPuntoFisico) {
				notifMsg = `🏪 PUNTO FÍSICO\nCliente: ${nombreInfo}\nCiudad: ${ciudadInfo}\nProducto: ${productoInfo}\nTeléfono: ${phone}\nQuiere pagar en punto físico. Requiere asistencia.`;
			} else if (metadata?.escalado) {
				notifMsg = `⚠️ ESCALAMIENTO\nCliente: ${nombreInfo}\nCiudad: ${ciudadInfo}\nProducto: ${productoInfo}\nTeléfono: ${phone}\nNo pudo completar el pago web. Requiere asistencia.`;
			}

			if (notifMsg) {
				try {
					const { sendMessage: sendWADirect } = await import('./whatsapp.js');
					await sendWADirect(WA_ESCALAMIENTO, notifMsg);
					logger.info({ phone, tipo: metadata?.notificarPuntoFisico ? 'punto_fisico' : 'escalamiento' }, 'Notificación interna enviada');
				} catch (e) {
					logger.error({ error: e }, 'Error enviando notificación interna');
				}
			}
		}

		// Prioridad: metadata del agente > detección directa del mensaje > UserData previo
		if (metadata?.ciudad) {
			ud.ciudad = metadata.ciudad;
		} else if (userData.ciudad && userData.ciudad !== userDataRecord?.ciudad) {
			ud.ciudad = userData.ciudad;
		}
		if (metadata?.departamento) {
			ud.departamento = metadata.departamento;
		} else if (userData.departamento && userData.departamento !== userDataRecord?.departamento) {
			ud.departamento = userData.departamento;
		}

		const credito = metadata?.creditoData;
		if (credito?.nombres) ud.nombre = credito.nombres;
		if (credito?.cedula) ud.cedula = credito.cedula;
		if (credito?.producto) ud.productoSolicitado = credito.producto;

		const repuesto = metadata?.repuestoData;
		if (repuesto?.nombreCliente) ud.nombre = repuesto.nombreCliente;
		if (repuesto?.repuesto) ud.productoSolicitado = repuesto.repuesto;

		if (metadata?.productoCompra) ud.productoSolicitado = metadata.productoCompra;
		if (metadata?.productoSolicitado && !ud.productoSolicitado) ud.productoSolicitado = metadata.productoSolicitado;

		// Datos personales continuos (nombre, cédula, dirección, teléfono, presupuesto)
		if (metadata?.nombreCliente) ud.nombre = metadata.nombreCliente;
		if (metadata?.cedulaCliente) ud.cedula = metadata.cedulaCliente;
		if (metadata?.direccion) ud.direccion = metadata.direccion;
		if (metadata?.telefono) ud.telefono = metadata.telefono;
		if (metadata?.presupuesto) ud.presupuesto = metadata.presupuesto;

		const extra = { ...safeParseJson(userDataRecord?.extra) };
		const mergedExtra = { ...extra, ...metadata };
		const udHasData = Object.keys(ud).length > 0;

		if (udHasData) {
			await prisma.userData.upsert({
				where: { leadId: lead.id },
				update: { ...ud, extra: JSON.stringify(mergedExtra) },
				create: { leadId: lead.id, ...ud, extra: JSON.stringify(mergedExtra) },
			});
		} else if (metadata) {
			await prisma.userData.upsert({
				where: { leadId: lead.id },
				update: { extra: JSON.stringify(mergedExtra) },
				create: { leadId: lead.id, extra: JSON.stringify(mergedExtra) },
			});
		}

		// 11. IA extractora de datos (post-procesamiento)
		// Analiza el historial completo y extrae datos del cliente que el
		// agente conversacional pudo haber omitido. También mueve el pipeline.
		extractAndSaveData(
			lead.id,
			contact.id,
			body,
			history.map((m) => ({ direction: m.direction, body: m.body, sentAt: m.sentAt })),
			userData,
			agentType,
			response
		).catch(e => logger.error({ error: e.message }, 'DataExtractor falló (no crítico)'));
	}

	return { response, agentType, contactId: contact.id, leadId: lead?.id };
}