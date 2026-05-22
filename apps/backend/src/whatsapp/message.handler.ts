import { WAMessage } from '@whiskeysockets/baileys';
import prisma from '../db/index.js';
import { orchestrator } from '../agents/orchestrator.js';
import { sendMessage, getStatus, resolvePhoneFromJid } from './whatsapp.js';
import logger from '../utils/logger.js';

function safeParseJson(str: string | null | undefined): any {
	if (!str) return {};
	try {
		return JSON.parse(str);
	} catch {
		return {};
	}
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
	
	// Ignorar mensajes de grupos
	if (remoteJid.endsWith('@g.us')) {
		logger.info('Ignoring group message');
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

		// 2. Persistir mensaje INBOUND
		await prisma.message.create({
			data: {
				contactId: contact.id,
				direction: 'INBOUND',
				body,
			},
		});

		// 3. Obtener historial reciente (últimos 10 mensajes)
		const history = await prisma.message.findMany({
			where: { contactId: contact.id },
			orderBy: { sentAt: 'desc' },
			take: 10,
		});

		// 4. Lead activo del contacto (el más reciente)
		let lead = await prisma.lead.findFirst({
			where: { contactId: contact.id },
			orderBy: { createdAt: 'desc' },
		});

		// 5. Cargar UserData persistido (datos recolectados por la IA progresivamente)
		let userDataRecord = lead
			? await prisma.userData.findUnique({ where: { leadId: lead.id } })
			: null;

		const userData = {
			ciudad: userDataRecord?.ciudad ?? null,
			departamento: userDataRecord?.departamento ?? null,
			nombre: userDataRecord?.nombre ?? null,
			cedula: userDataRecord?.cedula ?? null,
			productoSolicitado: userDataRecord?.productoSolicitado ?? null,
			extra: safeParseJson(userDataRecord?.extra),
		};

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
		};

		// Si ya tenemos ciudad guardada, pre-poblamos el contexto
		// para que los agentes no vuelvan a preguntar
		if (userData.ciudad) {
			context.ciudad = userData.ciudad;
			context.ciudadValidada = true;
		}

		// 6. Enrutar al orquestador
		const { agentType, response, metadata } = await orchestrator.route(body, context);

		// 7. Persistir respuesta OUTBOUND
		await prisma.message.create({
			data: {
				contactId: contact.id,
				direction: 'OUTBOUND',
				body: response,
				agentType,
			},
		});

		// 8. Crear o actualizar lead
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

		// 9. Guardar datos recolectados por la IA en UserData
		if (lead && metadata) {
			const ud: Record<string, any> = {};
			if (metadata.ciudad) ud.ciudad = metadata.ciudad;
			if (metadata.departamento) ud.departamento = metadata.departamento;

			const credito = metadata.creditoData;
			if (credito?.nombres) ud.nombre = credito.nombres;
			if (credito?.cedula) ud.cedula = credito.cedula;
			if (credito?.producto) ud.productoSolicitado = credito.producto;

			const repuesto = metadata.repuestoData;
			if (repuesto?.nombreCliente) ud.nombre = repuesto.nombreCliente;
			if (repuesto?.repuesto) ud.productoSolicitado = repuesto.repuesto;

			const extra = { ...safeParseJson(userDataRecord?.extra) };
			const mergedExtra = { ...extra, ...metadata };
			const udHasData = Object.keys(ud).length > 0;

			if (udHasData) {
				await prisma.userData.upsert({
					where: { leadId: lead.id },
					update: { ...ud, extra: JSON.stringify(mergedExtra) },
					create: { leadId: lead.id, ...ud, extra: JSON.stringify(mergedExtra) },
				});
			} else {
				// Aún sin campos específicos, guardar extra para depuración
				await prisma.userData.upsert({
					where: { leadId: lead.id },
					update: { extra: JSON.stringify(mergedExtra) },
					create: { leadId: lead.id, extra: JSON.stringify(mergedExtra) },
				});
			}
		}

		// 10. Enviar respuesta por WhatsApp solo si está conectado
		if (getStatus() === 'connected') {
			await sendMessage(phone, response);
			logger.info({ phone, agentType, leadId: lead.id }, 'Response sent');
		} else {
			logger.warn({ phone, agentType }, 'WhatsApp not connected, response not sent');
		}
	} catch (error) {
		logger.error({ error, phone }, 'Error handling incoming message');

		// Intentar enviar mensaje de error al usuario solo si está conectado
		if (getStatus() === 'connected') {
			try {
				const fallbackResponse = 'Lo siento, hubo un problema procesando tu mensaje. Por favor intenta de nuevo en un momento.';
				await sendMessage(phone, fallbackResponse);

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
}
