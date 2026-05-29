import { IAgent, AgentResponse } from './types.js';
import { buildUserDataContext, buildGemmaPrompt, cleanResponse, formatHistory } from './helpers.js';
import { generateResponse } from '../utils/gemini.js';

const CAMPOS = ['nit', 'nombre', 'telefono', 'correo', 'rangoVentas', 'departamento', 'ciudad'] as const;

const VALIDACIONES: Record<string, (v: string) => boolean> = {
	nit: (v) => /^\d{6,12}(-\d)?$/.test(v.replace(/\s/g, '')),
	nombre: (v) => v.trim().length >= 3 && !/^\d+$/.test(v),
	telefono: (v) => /\d{7,}/.test(v.replace(/\D/g, '')),
	correo: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
	rangoVentas: (_) => true,
	departamento: (v) => v.trim().length >= 3,
	ciudad: (v) => v.trim().length >= 3,
};

const RANGOS_VENTAS: Record<string, string> = {
	'1': 'Menos de $5.000.000',
	'2': '$5.000.000 - $10.000.000',
	'3': '$10.000.001 - $20.000.000',
	'4': '$20.000.001 - $50.000.000',
	'5': 'Más de $50.000.000',
};

const ERRORES: Record<string, string> = {
	nit: 'El NIT debe tener entre 6 y 12 dígitos, con o sin guión de verificación (ej: 901234567-1).',
	nombre: 'Por favor escribe un nombre o razón social válida (mínimo 3 caracteres).',
	telefono: 'El teléfono debe tener al menos 7 dígitos. ¿Me lo escribes de nuevo?',
	correo: 'Parece que el correo no tiene un formato válido. ¿Me lo escribes de nuevo? 📧',
	rangoVentas: '',
	departamento: 'Por favor escribe el departamento donde operas (mínimo 3 caracteres).',
	ciudad: 'Por favor escribe la ciudad (mínimo 3 caracteres).',
};

const TRANSICIONES: Record<string, string> = {
	nit: '¡Gracias!',
	nombre: 'Perfecto.',
	telefono: 'Vamos muy bien',
	rangoVentas: 'Ya casi terminamos.',
	departamento: '¡Y por último!',
};

const MENSAJE_CORRECCION = '¿Qué campo quieres corregir? Dime cuál y te lo actualizo.';

export class DistribuidoresAgent implements IAgent {
	name = 'Distribuidores';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const lower = message.toLowerCase().trim();
		const distData: Record<string, any> = { ...(context?.distribuidorData ?? {}) };

		// ── Seguimiento post-registro ──
		if (context?.flujo === 'distribuidores_completado') {
			return this.handleSeguimiento(message, lower, context, distData);
		}

		// ── Confirmación de resumen ──
		if (context?.flujo === 'distribuidores_confirmar') {
			return this.handleConfirmacion(message, lower, context, distData);
		}

		// ── Recolección de datos ──
		if (context?.flujo === 'distribuidores_recoleccion') {
			return this.handleRecoleccion(message, lower, context, distData);
		}

		// ── Flujo inicial: elegir canal ──
		return this.handleCanal(message, lower, context, distData);
	}

	// ───────────────────────── Elegir canal ────────────────────────────────

	private async handleCanal(
		message: string,
		lower: string,
		_context: any,
		distData: any
	): Promise<AgentResponse> {
		if (lower === '1' || /web|formulario|link|p[aá]gina|en l[aá] web/i.test(lower)) {
			distData.canal = 'web';
			return {
				response:
					'¡Listo! Ingresa a https://jlc-electronics.com/#distribuidor y llena el formulario. Si tienes algún inconveniente, escríbeme y lo hacemos juntas por aquí. 😊',
				metadata: { agentType: 'distribuidores', flujo: 'distribuidores_web', distribuidorData: distData },
			};
		}

		if (
			lower === '2' ||
			/por aqu[ií]|whatsapp|contigo|paso a paso|gu[ií]a|aqui|ac[aá]/i.test(lower)
		) {
			distData.canal = 'whatsapp';
			return {
				response: '¡Perfecto! Vamos a registrarte paso a paso. ¿Cuál es tu NIT o número de identificación tributaria?',
				metadata: {
					agentType: 'distribuidores',
					flujo: 'distribuidores_recoleccion',
					distribuidorData: distData,
				},
			};
		}

		// Si es ambiguo, usar IA para interpretar
		const interpretacion = await this.interpretarCanal(message);
		if (interpretacion === 'web') {
			distData.canal = 'web';
			return {
				response:
					'¡Listo! Ingresa a https://jlc-electronics.com/#distribuidor y llena el formulario. Si tienes algún inconveniente, escríbeme y lo hacemos juntas por aquí. 😊',
				metadata: { agentType: 'distribuidores', flujo: 'distribuidores_web', distribuidorData: distData },
			};
		}
		if (interpretacion === 'whatsapp') {
			distData.canal = 'whatsapp';
			return {
				response: '¡Perfecto! Vamos a registrarte paso a paso. ¿Cuál es tu NIT o número de identificación tributaria?',
				metadata: {
					agentType: 'distribuidores',
					flujo: 'distribuidores_recoleccion',
					distribuidorData: distData,
				},
			};
		}

		// No se pudo determinar
		return {
			response:
				'¿Prefieres llenar el formulario en la web o que lo hagamos por aquí? 😊\n\n1️⃣ Web: https://jlc-electronics.com/#distribuidor\n2️⃣ Por WhatsApp paso a paso',
			metadata: { agentType: 'distribuidores', flujo: 'distribuidores', distribuidorData: distData },
		};
	}

	private async interpretarCanal(message: string): Promise<string | null> {
		try {
			const prompt = `Clasifica el siguiente mensaje como "web" (si el usuario prefiere hacerlo en la web, formulario, link, página) o "whatsapp" (si prefiere hacerlo por chat, paso a paso, con la asesora). Responde solo "web" o "whatsapp". Si no está claro, responde "null".

Mensaje: "${message.replace(/"/g, "'")}"
Respuesta:`;
			const raw = await generateResponse(prompt);
			const r = raw.toLowerCase().trim();
			if (r.includes('web')) return 'web';
			if (r.includes('whatsapp')) return 'whatsapp';
			return null;
		} catch {
			return null;
		}
	}

	// ───────────────────────── Recolección de datos ────────────────────────

	private async handleRecoleccion(
		message: string,
		_lower: string,
		_context: any,
		distData: any
	): Promise<AgentResponse> {
		// Encontrar el siguiente campo vacío
		const idx = CAMPOS.findIndex((c) => !distData[c]);

		// Todos los campos están llenos → mostrar resumen
		if (idx === -1) {
			return this.mostrarResumen(distData);
		}

		const campo = CAMPOS[idx];

		// Si ya tiene valor, es porque volvimos a este paso (ej: corrección)
		if (distData[campo]) {
			return this.preguntarCampo(campo, distData, idx);
		}

		// Validar el mensaje actual como respuesta para este campo
		const valor = this.limpiarValor(campo, message);
		if (!VALIDACIONES[campo](valor)) {
			const error = ERRORES[campo] || 'Ese valor no es válido. ¿Puedes intentar de nuevo?';
			return {
				response: `${error}`,
				metadata: { agentType: 'distribuidores', flujo: 'distribuidores_recoleccion', distribuidorData: distData },
			};
		}

		// Guardar valor
		const valorFinal = campo === 'rangoVentas' ? this.resolverRango(valor) : valor;
		distData[campo] = valorFinal;

		// Mostrar transición si aplica
		const transicion = TRANSICIONES[campo];

		// Siguiente campo
		const sigIdx = CAMPOS.findIndex((c) => !distData[c]);
		if (sigIdx === -1) {
			const resumen = this.mostrarResumen(distData);
			if (transicion) {
				resumen.response = `${transicion}\n\n${resumen.response}`;
			}
			return resumen;
		}

		const sigCampo = CAMPOS[sigIdx];

		// Si transición existe, agregarla antes de la pregunta
		let pregunta = this.preguntaParaCampo(sigCampo, sigIdx);
		if (transicion) {
			pregunta = `${transicion}\n\n${pregunta}`;
		}

		return {
			response: pregunta,
			metadata: { agentType: 'distribuidores', flujo: 'distribuidores_recoleccion', distribuidorData: distData },
		};
	}

	private limpiarValor(campo: string, message: string): string {
		if (campo === 'telefono') {
			return message.replace(/\D/g, '');
		}
		return message.trim();
	}

	private resolverRango(valor: string): string {
		const v = valor.trim();
		if (RANGOS_VENTAS[v]) return RANGOS_VENTAS[v];
		// Intentar match por texto
		const lower = v.toLowerCase();
		for (const [key, label] of Object.entries(RANGOS_VENTAS)) {
			if (lower.includes(key) || lower.includes(label.toLowerCase().slice(0, 10))) {
				return label;
			}
		}
		return v;
	}

	private preguntaParaCampo(campo: string, _idx: number): string {
		switch (campo) {
			case 'nit':
				return '¿Cuál es tu NIT o número de identificación tributaria?';
			case 'nombre':
				return '¿Nombre o razón social de tu negocio?';
			case 'telefono':
				return '¿Un número de teléfono de contacto? 📱';
			case 'correo':
				return '¿Tu correo electrónico? 📧';
			case 'rangoVentas':
				return (
					'¿En qué rango están tus ventas mensuales? 💰\n\n' +
					'1️⃣ Menos de $5.000.000\n' +
					'2️⃣ $5.000.000 – $10.000.000\n' +
					'3️⃣ $10.000.001 – $20.000.000\n' +
					'4️⃣ $20.000.001 – $50.000.000\n' +
					'5️⃣ Más de $50.000.000'
				);
			case 'departamento':
				return '¿En qué departamento operas?';
			case 'ciudad':
				return '¿Y la ciudad?';
			default:
				return '';
		}
	}

	private async preguntarCampo(campo: string, distData: any, idx: number): Promise<AgentResponse> {
		return {
			response: this.preguntaParaCampo(campo, idx),
			metadata: { agentType: 'distribuidores', flujo: 'distribuidores_recoleccion', distribuidorData: distData },
		};
	}

	// ───────────────────────── Resumen y confirmación ──────────────────────

	private mostrarResumen(distData: any): AgentResponse {
		return {
			response: `¡Listo! Estos son tus datos de registro:

📋 NIT: ${distData.nit || '—'}
🏢 Nombre: ${distData.nombre || '—'}
📱 Teléfono: ${distData.telefono || '—'}
📧 Correo: ${distData.correo || '—'}
💰 Ventas: ${distData.rangoVentas || '—'}
📍 Ubicación: ${distData.ciudad || '—'}, ${distData.departamento || '—'}

¿Todo está correcto? Si necesitas corregir algo, dime cuál.`,
			metadata: { agentType: 'distribuidores', flujo: 'distribuidores_confirmar', distribuidorData: distData },
		};
	}

	private async handleConfirmacion(
		message: string,
		lower: string,
		context: any,
		distData: any
	): Promise<AgentResponse> {
		const esAfirmativo = /^(s[ií]|sip|dale|ok|bueno|claro|correcto|perfecto)|todo\s+(bien|correcto|est[aá]\s+bien)|es\s+correcto|est[aá]\s+correcto|as[ií]\s+es|completo|listo|confirmado|terminado/i.test(lower);

		if (esAfirmativo) {
			distData.confirmado = true;
			return this.finalizarSolicitud(message, distData, context);
		}

		// Intentar detectar qué campo quiere corregir
		const campoCorregir = this.detectarCampoCorregir(lower);
		if (campoCorregir) {
			return {
				response: `¡Claro! ¿Cuál es el ${this.nombreCampo(campoCorregir)} correcto?`,
				metadata: {
					agentType: 'distribuidores',
					flujo: 'distribuidores_recoleccion',
					distribuidorData: { ...distData, [campoCorregir]: undefined },
				},
			};
		}

		// Si dijo que algo está mal pero no específica qué
		const algoMal = /no|mal|incorrecto|error|cambiar|corregir|modificar/i.test(lower);
		if (algoMal) {
			return {
				response: MENSAJE_CORRECCION,
				metadata: { agentType: 'distribuidores', flujo: 'distribuidores_confirmar', distribuidorData: distData },
			};
		}

		// Respuesta ambigua: mostrar resumen de nuevo
		return this.mostrarResumen(distData);
	}

	private detectarCampoCorregir(lower: string): string | null {
		const map: [RegExp, string][] = [
			[/\bnit\b|\bidentificaci[oó]n\b|\brut\b/, 'nit'],
			[/\bnombre\b|raz[oó]n social|negocio|empresa/, 'nombre'],
			[/\btel[eé]fono\b|celular|contacto|n[uú]mero/, 'telefono'],
			[/\bcorreo\b|email|e-mail|electr[oó]nico/, 'correo'],
			[/\bventas?\b|rango|ingresos/, 'rangoVentas'],
			[/\bdepartamento\b/, 'departamento'],
			[/\bciudad\b|municipio|ubicaci[oó]n/, 'ciudad'],
		];
		for (const [pattern, campo] of map) {
			if (pattern.test(lower)) return campo;
		}
		return null;
	}

	private nombreCampo(campo: string): string {
		const nombres: Record<string, string> = {
			nit: 'NIT',
			nombre: 'nombre o razón social',
			telefono: 'teléfono',
			correo: 'correo electrónico',
			rangoVentas: 'rango de ventas',
			departamento: 'departamento',
			ciudad: 'ciudad',
		};
		return nombres[campo] || campo;
	}

	// ───────────────────────── Finalizar solicitud ─────────────────────────

	private async finalizarSolicitud(message: string, distData: any, context?: any): Promise<AgentResponse> {
		const datos = `Solicitud de distribuidor registrada.
NIT: ${distData.nit}
Nombre: ${distData.nombre}
Teléfono: ${distData.telefono}
Correo: ${distData.correo}
Rango de ventas: ${distData.rangoVentas}
Departamento: ${distData.departamento}
Ciudad: ${distData.ciudad}
Instrucción: INDICA AL CLIENTE QUE SU SOLICITUD FUE REGISTRADA. NOVEDAD: nuestro equipo comercial va a revisar su perfil y se comunicará con él pronto. NO MENCIONAR STOCK, PLAZOS NI TIEMPOS DE ENTREGA.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente del programa de distribuidores de Electrodomésticos JLC. ${datos}`,
			ejemplos: [
				{
					cliente: 'Sí, todo está bien',
					asistente:
						'¡Tu solicitud quedó registrada! 🎉 Nuestro equipo comercial va a revisar tu perfil y se comunicará contigo pronto para coordinar los siguientes pasos. Muchas gracias por tu interés en ser parte de la familia JLC. 💙',
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
				agentType: 'distribuidores',
				flujo: 'distribuidores_completado',
				distribuidorData: distData,
				notificarDistribuidores: true,
			},
		};
	}

	// ───────────────────────── Seguimiento ─────────────────────────────────

	private async handleSeguimiento(
		message: string,
		lower: string,
		context: any,
		distData: any
	): Promise<AgentResponse> {
		const reclamo = /no me han (llamado|contactado|respondido)|nadie me (contact|ha llam)|sigo esperando|qu[eé] pas[oó] con mi/i;
		if (reclamo.test(lower)) {
			return {
				response:
					'Qué pena por la demora. Puedes comunicarte directamente con nuestro equipo comercial al +57 321 645 0110 o al +57 320 788 1141 para darle seguimiento a tu solicitud.',
				metadata: { agentType: 'distribuidores', flujo: 'distribuidores_completado', distribuidorData: distData },
			};
		}

		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Solicitud de distribuidor ya registrada. Cliente: ${distData.nombre || 'desconocido'}.${userDataCtx}
Instrucción: responde amablemente a la consulta del cliente sin volver a pedir datos personales. Si pregunta por seguimiento y no ha reclamado demora, indícale que su solicitud está en proceso.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente del programa de distribuidores de Electrodomésticos JLC. ${datos}`,
			ejemplos: [],
			historial: formatHistory(context?.history),
			mensajeCliente: message,
		});

		const raw = await generateResponse(user, system);
		const response = cleanResponse(raw);

		return {
			response,
			metadata: { agentType: 'distribuidores', flujo: 'distribuidores_completado', distribuidorData: distData },
		};
	}
}
