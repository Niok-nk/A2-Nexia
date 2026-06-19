import prisma from '../db/index.js';
import { generateResponse } from '../utils/gemini.js';
import { detectarPagoConfirmado } from './helpers.js';
import logger from '../utils/logger.js';

/**
 * Determina el stage del pipeline basado en los datos reales de UserData y el agente.
 * Reglas determinísticas, NO depende de la IA.
 */
function determinarPipelineStage(userData: Record<string, any>, ultimaRespuesta: string, historial: string): string {
	const tieneNombre = !!userData?.nombre;
	const tieneCedula = !!userData?.cedula;
	const tieneDireccion = !!userData?.direccion;
	const tieneTelefono = !!userData?.telefono;
	const tieneProducto = !!userData?.productoSolicitado;
	const tienePresupuesto = !!userData?.presupuesto;
	const tieneCiudad = !!userData?.ciudad;

	// VENTA_CERRADA: solo cuando el cliente confirma que YA pagó
	if (tieneProducto && detectarPagoConfirmado(historial.slice(-300))) {
		return 'VENTA_CERRADA';
	}

	// VENTA_CERRADA opción B: el asistente confirmó recibo de pago o comprobante
	if (/\b(?:recib[ií] tu comprobante|confirm[ée] el pago|pago verificado|n[uú]mero de gu[ií]a|gu[ií]a de env[ií]o)\b/i.test(ultimaRespuesta)) {
		return 'VENTA_CERRADA';
	}

	// PRESUPUESTO_LISTO: producto + presupuesto
	if (tieneProducto && tienePresupuesto) {
		return 'PRESUPUESTO_LISTO';
	}

	// CONTACTO_COMPLETO: nombre + cédula + al menos un dato de contacto
	if (tieneNombre && tieneCedula && (tieneDireccion || tieneTelefono)) {
		return 'CONTACTO_COMPLETO';
	}

	// PRODUCTO_INTERES: sabemos qué producto busca
	if (tieneProducto) {
		return 'PRODUCTO_INTERES';
	}

	// CIUDAD_VALIDADA: tenemos ciudad
	if (tieneCiudad) {
		return 'CIUDAD_VALIDADA';
	}

	return 'INITIAL';
}

/**
 * Agente extractor de datos (IA backend).
 * No habla con el cliente. Lee el historial de la conversación y extrae
 * datos concretos para guardarlos en UserData.
 * El pipeline stage se determina por reglas, no por la IA.
 */
export async function extractAndSaveData(
	leadId: string,
	_contactId: string,
	_body: string,
	history: Array<{ direction: string; body: string; sentAt: Date }>,
	currentUserData: Record<string, any>,
	_agentType: string,
	responseText: string
): Promise<void> {
	try {
		const historial = history
			.slice(-12)
			.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
			.join('\n');

		const userDataStr = Object.entries(currentUserData)
			.filter(([_, v]) => v != null && v !== '' && v !== '{}')
			.map(([k, v]) => `${k}: ${v}`)
			.join('\n');

		// ── 1. Extraer datos del historial con IA ──────────────────────────
		const prompt = `Eres un extractor y corrector de datos de clientes de JLC Electronics.
Tu tarea es leer minuciosamente el HISTORIAL de la conversación mensaje por mensaje, analizar el contexto y:
1. Extraer nuevos datos del cliente que haya mencionado explícitamente.
2. Detectar y CORREGIR cualquier incongruencia, error o contradicción entre los DATOS ACTUALES de la base de datos y lo dicho más recientemente por el cliente en el HISTORIAL (ejemplo: si el cliente corrigió la ortografía de su nombre, cambió de ciudad de destino, cambió su número de cédula, modificó su presupuesto o se decidió por un producto/referencia distinta).

Tu prioridad absoluta es garantizar que los datos guardados sean congruentes, veraces y reflejen la última decisión o aclaración del cliente.

DATOS ACTUALES EN BASE DE DATOS:
${userDataStr || '(ninguno)'}

HISTORIAL DE CONVERSACIÓN:
${historial}

--- INSTRUCCIONES ---
Extrae datos nuevos o actualizados/corregidos que el cliente haya mencionado.

Campos a procesar (solo si están en el historial):
- nombre: nombre completo del cliente (corregir si hay cambios o errores de ortografía)
- cedula: número de cédula, solo dígitos (corregir si se digitó mal antes)
- direccion: dirección de despacho (corregir si el cliente la cambia)
- telefono: teléfono de contacto (corregir si especifica uno diferente)
- presupuesto: presupuesto aproximado en pesos (corregir si cambia de opinión)
- productoSolicitado: nombre LIMPIO del producto o categoría que el cliente busca comprar.
  REGLAS ESTRICTAS para productoSolicitado:
  * Extrae SOLO el tipo de producto o nombre de referencia/modelo, SIN frases extra.
  * Ejemplos correctos: "nevera", "lavadora", "televisor 55 pulgadas", "Lavadora Mabe 16kg"
  * Ejemplos INCORRECTOS (no hagas esto): "esta JLC de 400 litros", "quiero esa nevera", "el producto de JLC"
  * Si el cliente menciona una referencia exacta de un producto ya mostrado, usa solo el nombre del modelo.
  * Si es una categoría general ("nevera", "lavadora"), usa solo esa palabra.
  * Si el cliente cambia de producto, actualiza con el nombre limpio del nuevo producto.
- ciudad: ciudad donde está o desea el envío (corregir si se cambia de destino)
- departamento: departamento donde está o desea el envío (corregir si cambia)

Responde SOLO con JSON válido, sin markdown, sin bloques de código, sin explicaciones ni texto extra:
{"datos":{}}

Ejemplo si hay datos nuevos o corregidos: {"datos":{"nombre":"Carlos Arturo","ciudad":"Medellín","productoSolicitado":"nevera"}}
Si todos los datos actuales son correctos y no hay nada nuevo ni incongruente que corregir: {"datos":{}}`;

		const raw = await generateResponse(prompt);

		// Extraer el PRIMER objeto JSON completo del texto
		function extraerPrimerJson(texto: string): string {
			const inicio = texto.indexOf('{');
			if (inicio < 0) return texto;
			let profundidad = 0;
			for (let i = inicio; i < texto.length; i++) {
				if (texto[i] === '{') profundidad++;
				else if (texto[i] === '}') profundidad--;
				if (profundidad === 0) return texto.slice(inicio, i + 1);
			}
			return texto.slice(inicio);
		}

		const jsonStr = extraerPrimerJson(raw);
		const parsed = JSON.parse(jsonStr);
		const datos: Record<string, string> = parsed.datos || {};

		// ── 2. Guardar solo campos nuevos en UserData ──────────────────────
		const CAMPOS_VALIDOS = new Set(['ciudad', 'departamento', 'nombre', 'cedula', 'productoSolicitado', 'presupuesto', 'direccion', 'telefono']);
		const updateData: Record<string, any> = {};
		for (const [key, value] of Object.entries(datos)) {
			if (CAMPOS_VALIDOS.has(key) && value && String(value) !== String(currentUserData[key] ?? '')) {
				updateData[key] = String(value);
			}
		}

		if (Object.keys(updateData).length > 0) {
			await prisma.userData.upsert({
				where: { leadId },
				update: updateData,
				create: { leadId, ...updateData },
			});
			logger.info({ leadId, updateData }, 'DataExtractor: UserData actualizado');
		}

		// ── 3. Leer UserData actualizada de la DB para pipeline ────────────
		const freshUserData = await prisma.userData.findUnique({ where: { leadId } });
		const merged = { ...currentUserData, ...updateData, ...(freshUserData || {}) };

		// ── 4. Determinar pipeline stage por reglas (determinístico) ───────
		const stage = determinarPipelineStage(merged, responseText, historial);

		// Leer lead actual para no retroceder
		const lead = await prisma.lead.findUnique({ where: { id: leadId } });
		if (!lead) return;

		const stages = ['INITIAL', 'CIUDAD_VALIDADA', 'PRODUCTO_INTERES', 'CONTACTO_COMPLETO', 'PRESUPUESTO_LISTO', 'VENTA_CERRADA', 'RECHAZADO'];
		const idxActual = stages.indexOf(lead.stage);
		const idxNuevo = stages.indexOf(stage);

		// Solo avanzar, nunca retroceder
		if (idxNuevo > idxActual) {
			await prisma.lead.update({
				where: { id: leadId },
				data: { stage },
			});
			logger.info({ leadId, stageAnterior: lead.stage, stageNuevo: stage }, 'DataExtractor: Pipeline avanzado');
		}
	} catch (error: any) {
		logger.error({ err: error, leadId, msg: error?.message || String(error) }, 'DataExtractor: Error (no crítico)');
	}
}
