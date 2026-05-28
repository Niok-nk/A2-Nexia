import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';

export class RepuestosAgent implements IAgent {
	name = 'Repuestos';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const lower = message.toLowerCase().trim();
		const repuestoData: Record<string, any> = { ...(context?.repuestoData ?? {}) };

		// ── Post-solicitud: seguimiento o respuesta libre ──
		if (context?.flujo === 'repuestos_completado') {
			return this.handleSeguimiento(message, lower, context, repuestoData);
		}

		// ── Step 4: Solicitando datos personales ──
		if (context?.flujo === 'repuestos_datos') {
			return this.handleDatosPersonales(message, lower, context, repuestoData);
		}

		// ── Step 3.5: Preguntar qué pieza/repuesto necesita ──
		if (context?.flujo === 'repuestos_pieza') {
			return this.handlePieza(message, context, repuestoData);
		}

		// ── Step 3: Confirmación de producto ──
		if (context?.flujo === 'repuestos_confirmar') {
			return this.handleConfirmacion(message, lower, context, repuestoData);
		}

		// ── Step 1-2: Flujo inicial ──
		const tieneProducto = repuestoData.productoConfirmado || repuestoData.referenciaManual;

		if (tieneProducto) {
			// Tiene producto, preguntar qué pieza necesita
			return this.pedirPieza(repuestoData);
		}

		// Primera vez: guardar lo que dijo y preguntar modelo
		if (!repuestoData.repuesto) {
			repuestoData.repuesto = message.trim();
			return {
				response: '¿Cuál es el modelo o referencia de tu electrodoméstico? Lo encuentras en la placa trasera del equipo. 😊',
				metadata: { agentType: 'repuestos', flujo: 'repuestos', repuestoData },
			};
		}

		// Ya tiene repuesto capturado → buscar en WooCommerce
		return this.buscarProducto(message, context, repuestoData);
	}

	// ─────────────────────────── Buscar producto ────────────────────────────

	private async buscarProducto(message: string, _context: any, repuestoData: any): Promise<AgentResponse> {
		const query = message.trim() || repuestoData.repuesto || '';

		try {
			const products = await wooCommerceService.searchProducts(query, 5);
			const match = products.length > 0 ? products[0] : null;

			if (match) {
				repuestoData.productoEncontrado = {
					nombre: match.name,
					id: match.id,
				};
				return {
					response: `Encontré tu producto:\n📋 *${match.name}*\n\n¿Es este tu electrodoméstico? Responde Sí o No.`,
					metadata: { agentType: 'repuestos', flujo: 'repuestos_confirmar', repuestoData },
				};
			}
		} catch {
			// Error de conexión, continuar
		}

		// No se encontró
		return {
			response: 'No hay problema. ¿Puedes escribirme el nombre exacto o la referencia que aparece en la placa de tu equipo?',
			metadata: { agentType: 'repuestos', flujo: 'repuestos_confirmar', repuestoData },
		};
	}

	// ───────────────────────── Confirmar producto ───────────────────────────

	private async handleConfirmacion(
		message: string,
		lower: string,
		_context: any,
		repuestoData: any
	): Promise<AgentResponse> {
		// Si estamos preguntando por ref manual y contesta sí
		if (repuestoData.referenciaManual || !repuestoData.productoEncontrado) {
			repuestoData.referenciaManual = repuestoData.referenciaManual || message.trim();
			return this.pedirPieza(repuestoData);
		}

		const esAfirmativo = /^(s[ií]|sip|dale|ok|bueno|claro|sis[aa]|correcto|exacto|ese\s*(es|mismo)|esa\s*(es|misma))/i.test(lower);

		if (esAfirmativo) {
			repuestoData.productoConfirmado = true;
			return this.pedirPieza(repuestoData);
		}

		// Negativo o ambiguo → pedir referencia manual
		repuestoData.productoEncontrado = undefined;
		return {
			response: 'No hay problema. ¿Puedes escribirme el nombre exacto o la referencia que aparece en la placa de tu equipo?',
			metadata: { agentType: 'repuestos', flujo: 'repuestos_confirmar', repuestoData },
		};
	}

	// ───────────────────────── Preguntar pieza ──────────────────────────────

	private pedirPieza(repuestoData: any): AgentResponse {
		return {
			response: '¿Qué repuesto o pieza necesitas específicamente? (ej: empaque, filtro, resistencia, motor, etc.) 😊',
			metadata: { agentType: 'repuestos', flujo: 'repuestos_pieza', repuestoData },
		};
	}

	private async handlePieza(message: string, _context: any, repuestoData: any): Promise<AgentResponse> {
		repuestoData.repuesto = message.trim();
		return {
			response: '¡Perfecto! Para registrar tu solicitud necesito tu nombre completo y número de cédula. 😊',
			metadata: { agentType: 'repuestos', flujo: 'repuestos_datos', repuestoData },
		};
	}

	// ───────────────────────── Datos personales ─────────────────────────────

	private async handleDatosPersonales(
		message: string,
		_lower: string,
		context: any,
		repuestoData: any
	): Promise<AgentResponse> {
		const cedulaMatch = message.match(/\b(\d{5,12})\b/);
		const cedula = cedulaMatch ? cedulaMatch[1] : null;

		const nombre = message
			.replace(/\b(cc|C\.C|cedula|cedula de ciudadania|documento|identificacion|num|numero|número)\s*:?\s*\d{5,12}\s*/gi, '')
			.replace(/\b\d{5,12}\b/g, '')
			.replace(/,/g, '')
			.trim();

		// Ambos ya están
		if (repuestoData.nombreCliente && repuestoData.cedulaCliente) {
			return this.finalizarSolicitud(message, repuestoData, context);
		}

		// Primer intento
		if (!repuestoData.nombreCliente && !repuestoData.cedulaCliente) {
			if (nombre && cedula) {
				repuestoData.nombreCliente = nombre;
				repuestoData.cedulaCliente = cedula;
				return this.finalizarSolicitud(message, repuestoData, context);
			}
			if (nombre && !cedula) {
				repuestoData.nombreCliente = nombre;
				return {
					response: `Gracias, ${nombre.split(' ')[0]}. ¿Me recuerdas también tu número de cédula? 😊`,
					metadata: { agentType: 'repuestos', flujo: 'repuestos_datos', repuestoData },
				};
			}
			if (cedula && !nombre) {
				repuestoData.cedulaCliente = cedula;
				return {
					response: 'Gracias. ¿Y tu nombre completo? 😊',
					metadata: { agentType: 'repuestos', flujo: 'repuestos_datos', repuestoData },
				};
			}
			return {
				response: '¿Cuál es tu nombre completo y número de cédula? (ej: Juan Pérez, 1085344923) 😊',
				metadata: { agentType: 'repuestos', flujo: 'repuestos_datos', repuestoData },
			};
		}

		// Tiene nombre, falta cédula
		if (repuestoData.nombreCliente && !repuestoData.cedulaCliente) {
			if (cedula) {
				repuestoData.cedulaCliente = cedula;
				return this.finalizarSolicitud(message, repuestoData, context);
			}
			return {
				response: `Gracias, ${repuestoData.nombreCliente.split(' ')[0]}. ¿Me recuerdas tu número de cédula? 😊`,
				metadata: { agentType: 'repuestos', flujo: 'repuestos_datos', repuestoData },
			};
		}

		// Tiene cédula, falta nombre
		if (cedula && !repuestoData.nombreCliente) {
			// El mensaje actual es el nombre
			repuestoData.nombreCliente = message.replace(/\b\d{5,12}\b/g, '').replace(/,/g, '').trim();
			return this.finalizarSolicitud(message, repuestoData, context);
		}

		return this.finalizarSolicitud(message, repuestoData, context);
	}

	// ───────────────────────── Finalizar solicitud ──────────────────────────

	private async finalizarSolicitud(message: string, repuestoData: any, context?: any): Promise<AgentResponse> {
		const productInfo = repuestoData.productoEncontrado
			? `Producto encontrado: "${repuestoData.productoEncontrado.nombre}".`
			: repuestoData.referenciaManual
				? `Referencia manual del cliente: "${repuestoData.referenciaManual}".`
				: 'Sin información de producto.';

		const datos = `Solicitud de repuesto registrada.
${productInfo}
Repuesto/pieza solicitada: "${repuestoData.repuesto || 'No especificado'}".
Solicitante: ${repuestoData.nombreCliente}, CC ${repuestoData.cedulaCliente}.
Sin stock: tiempo de pedido 3 a 5 días hábiles.
Web: https://jlc-electronics.com/.
Instrucción: indica al cliente que su solicitud fue registrada y que un asesor de repuestos se comunicará con él para confirmar disponibilidad y precio.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de repuestos de Electrodomésticos JLC. ${datos}`,
			ejemplos: [
				{
					cliente: 'Necesito un empaque para nevera JLC modelo JLC-325',
					asistente:
						'¡Listo, Juan! Tu solicitud quedó registrada. Un asesor de repuestos se va a comunicar contigo para verificar la disponibilidad y darte el precio. 🙌',
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
				agentType: 'repuestos',
				flujo: 'repuestos_completado',
				repuestoData,
				notificarRepuestos: true,
			},
		};
	}

	// ───────────────────────── Seguimiento ──────────────────────────────────

	private async handleSeguimiento(
		message: string,
		lower: string,
		context: any,
		repuestoData: any
	): Promise<AgentResponse> {
		const reclamo = /no me han (llamado|contactado|respondido)|nadie me (contact|ha llam)|ya pasaron|qu[eé] pas[oó] con mi|sigo esperando|qu[eé] hay de mi/i;
		if (reclamo.test(lower)) {
			return {
				response:
					'Qué pena por la demora. Puedes comunicarte directamente con el asesor de repuestos al +57 320 784 2144 para darle seguimiento a tu solicitud.',
				metadata: { agentType: 'repuestos', flujo: 'repuestos_completado', repuestoData },
			};
		}

		// Respuesta normal con IA
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Solicitud de repuesto ya registrada. Cliente: ${repuestoData.nombreCliente || 'desconocido'}.${userDataCtx}
Instrucción: responde amablemente a la consulta del cliente sin volver a pedir datos personales. Si pregunta por seguimiento y no ha reclamado demora, indícale que su solicitud está en proceso.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de repuestos de Electrodomésticos JLC. ${datos}`,
			ejemplos: [],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'repuestos', flujo: 'repuestos_completado', repuestoData },
		};
	}
}
