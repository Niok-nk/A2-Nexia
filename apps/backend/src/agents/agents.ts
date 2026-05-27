import { generateResponse } from '../utils/gemini.js';
import { wooCommerceService } from '../woocommerce/woocommerce.service.js';

import { sendMessage as sendWA } from '../whatsapp/whatsapp.js';
import categoriasData from './categorias-generales.json';

// ─── Construir términos de búsqueda desde categorias-generales.json ────────────

interface CatItem { nombre: string; url: string; }
interface SubCat { nombre: string; items?: CatItem[]; }
interface Categoria { nombre: string; subcategorias: SubCat[]; }
interface Catalogo { categorias: Categoria[]; }

const catalogo = categoriasData as unknown as Catalogo;

/** Extrae todos los nombres de items (singular) y genera variantes de búsqueda */
function buildCategoriaPatterns(): RegExp {
	const terminos: string[] = [];
	const alias: Record<string, string[]> = {
		'televisores': ['tv', 'televisor'],
		'neveras': ['nevera', 'refrigerador', 'refri', 'neumático'],
		'lavadoras': ['lavadora', 'lavadoras automáticas', 'lavadoras semiautomáticas', 'lavasecadora'],
		'congeladores': ['congelador'],
		'nevecones': ['nevecon'],
		'minibar': ['minibar', 'bar'],
		'freidora': ['freidora', 'freidoras', 'freidora de aire'],
		'parlantes portables': ['parlante', 'parlantes', 'bocina', 'altavoz'],
		'torres de sonido': ['torre de sonido', 'torre de audio'],
		'cabinas': ['cabina', 'cabina de sonido'],
		'cafeteras': ['cafetera'],
		'licuadora': ['licuadora', 'licuadoras'],
		'ollas arroceras': ['olla arrocera', 'arrocera'],
		'ollas presión': ['olla presión', 'olla a presión', 'olla pitadora'],
	};

	// Extraer nombres del JSON
	for (const cat of catalogo.categorias) {
		for (const sub of cat.subcategorias) {
			if (sub.nombre) terminos.push(sub.nombre.toLowerCase());
			for (const item of sub.items || []) {
				const name = item.nombre.toLowerCase();
				terminos.push(name);
				// Agregar alias si existen
				if (alias[name]) terminos.push(...alias[name]);
			}
		}
	}

	// Limpiar y deduplicar
	const unicos = [...new Set(terminos.map(t => t.trim().replace(/[^a-záéíóúñ\s]+/g, '')))]
		.filter(t => t.length > 2);

	// Ordenar de más largos a más cortos para que coincida primero "lavadoras semiautomáticas"
	unicos.sort((a, b) => b.length - a.length);

	// Escapar caracteres especiales para regex
	const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = unicos.map(s => escapar(s)).join('|');
	return new RegExp(`\\b(?:${pattern})\\b`, 'i');
}

const CATEGORIAS_RE = buildCategoriaPatterns();

// ─── Motor de perfilamiento por categoría ──────────────────────────────────

interface ProfilingStep {
	field: string;
	pregunta: string;
}

const PROFILING_STEPS: Record<string, ProfilingStep[]> = {
	lavadora: [
		{ field: 'presupuesto', pregunta: '¿Tienes un presupuesto en mente para la lavadora? Así te muestro las que más te gusten 💕' },
	],
	televisor: [
		{ field: 'presupuesto', pregunta: 'Cuéntame, ¿cuánto pensabas invertir en tu nuevo televisor? Así te recomiendo los mejores 📺✨' },
	],
	nevera: [
		{ field: 'presupuesto', pregunta: '¿Qué presupuesto tienes para tu nevera? Para mostrarte las opciones que más te encanten 💙' },
	],
	audio: [
		{ field: 'presupuesto', pregunta: '¿Cuánto quieres gastar en tu equipo de sonido? Así te traigo las mejores opciones 🎵😊' },
	],
	cocina: [
		{ field: 'presupuesto', pregunta: '¿Tienes un presupuesto pensado para lo que buscas? Así te ayudo a encontrar justo lo que necesitas 👩‍🍳✨' },
	],
	ventilador: [
		{ field: 'presupuesto', pregunta: '¿Qué presupuesto manejas para tu ventilador? Te muestro las opciones disponibles 🌬️💕' },
	],
	congelador: [
		{ field: 'presupuesto', pregunta: '¿Cuánto pensabas invertir en tu congelador? Así te enseño las alternativas que tenemos ❄️😊' },
	],
	vitrina: [
		{ field: 'presupuesto', pregunta: '¿Qué presupuesto tienes para tu vitrina? Te muestro las que tenemos disponibles 🏪✨' },
	],
	exhibidor: [
		{ field: 'presupuesto', pregunta: 'Cuéntame tu presupuesto para el exhibidor y te muestro opciones chéveres 🏪💕' },
	],
	minibar: [
		{ field: 'presupuesto', pregunta: '¿Tienes un presupuesto en mente para el minibar? Así te enseño los que más te gusten 🧊😊' },
	],
	otra: [
		{ field: 'presupuesto', pregunta: '¿Qué presupuesto manejas? Así te ayudo a encontrar justo lo que buscas 💕' },
	],
};

function resolverRespuestaPerfil(msg: string, field: string): string {
	const lower = msg.toLowerCase().trim();

	if (field === 'presupuesto') {
		if (/menos|bajo|barato|econ[oó]mico/i.test(lower)) return 'bajo';
		if (/medio|moderado|normal/i.test(lower)) return 'medio';
		if (/nevecon|alto|sin l[ií]mite|lo que sea|no importa|ilimitado/i.test(lower)) return 'alto';
		const numVal = lower.match(/([\d.]+)/);
		if (numVal) {
			const valor = parseFloat(numVal[1].replace(/\./g, ''));
			if (valor < 1000000) return 'bajo';
			if (valor < 2500000) return 'medio';
			return 'alto';
		}
		return 'medio';
	}
	return msg;
}

function detectarCategoria(msg: string): string | null {
	const lower = msg.toLowerCase();
	if (/lavadora|lavadoras|secadora|lavar/i.test(lower)) return 'lavadora';
	if (/televisor|televisores|tv|pantalla|smart/i.test(lower)) return 'televisor';
	if (/nevera|neveras|nevecon|nevecones|refrigerador/i.test(lower)) return 'nevera';
	if (/ventilador|ventiladores|aire|acondicionado|climatizacion|climatizaci[oó]n|aire acondicionado port[aá]til|clima/i.test(lower)) return 'ventilador';
	if (/congelador|congeladores/i.test(lower)) return 'congelador';
	if (/vitrina|vitrinas/i.test(lower)) return 'vitrina';
	if (/exhibidor|exhibidores/i.test(lower)) return 'exhibidor';
	if (/minibar|mini\s*bar/i.test(lower)) return 'minibar';
	if (/cabina|cabinas|parlante|parlantes|torre de sonido|torres de sonido|sonido|audio|bafle|bocina/i.test(lower)) return 'audio';
	if (/cafetera|cafeteras|freidora|freidoras|hervidor|hervidores|horno|hornos|licuadora|licuadoras|olla|ollas|arrocera|exprimidor/i.test(lower)) return 'cocina';
	if (CATEGORIAS_RE.test(msg)) return 'otra';
	return null;
}

function detectarShortcuts(message: string, categoria: string): Record<string, string> {
	const lower = message.toLowerCase();
	const answers: Record<string, string> = {};

	if (categoria === 'nevera') {
		if (/nevecon|nevecones|doble puerta|side by side|french door/i.test(lower)) {
			answers.presupuesto = 'alto';
		}
	}
	if (/barato|econ[oó]mico|menos/i.test(lower)) answers.presupuesto = 'bajo';
	if (/lo que sea|sin l[ií]mite|no importa|indistinto|el mejor|necesario/i.test(lower)) answers.presupuesto = 'alto';
	return answers;
}

function obtenerTerminoBusquedaDesdePerfil(categoria: string, answers: Record<string, string>): string {
	if (categoria === 'nevera') {
		if (answers.presupuesto === 'alto') return 'nevecon';
		return 'nevera';
	}
	if (categoria === 'cocina') return 'electrodomesticos cocina';
	if (categoria === 'audio') return 'parlante';
	return categoria;
}

function camposPerfilCompletados(answers: Record<string, string>): number {
	return Object.keys(answers).filter(k => !!answers[k]).length;
}

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
		.slice(-20)
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

	// 0) Pre-limpieza de líneas de razonamiento interno del modelo (fuga de CoT en inglés)
	const lines = text.split('\n');
	const cleanedLines = lines.filter(line => {
		const t = line.toLowerCase().trim();
		if (t.includes('input message:') || t.includes('task:') || t.includes('result:') || t.includes('determination:') || t.includes('revised draft:') || t.includes('final polish:') || t.includes('checking constraints:')) {
			return false;
		}
		return true;
	});
	text = cleanedLines.join('\n').trim();

	// 0b) CRÍTICO: Detectar fuga masiva de razonamiento (caso Gemma real).
	//    Si el texto contiene patrones de auto-evaluación interna junto con
	//    contenido duplicado, extraer solo la primera respuesta limpia.
	const fugaMasiva = /(?:Warm\/Clear\/Direct|Colombian Spanish|Payment\/Shipping|asterisks\/formatting|I must prioritize|the system prompt|the asstant|Revised Draft|Final Polish|Double check)/i;
	if (fugaMasiva.test(text)) {
		// Buscar la primera oración coherente en español antes de la fuga
		const oraciones = text.split(/(?<=[.!?])\s+/);
		const limpias: string[] = [];
		for (const o of oraciones) {
			if (fugaMasiva.test(o)) break;
			if (/^[A-ZÁÉÍÓÚÑ¡¿]/.test(o.trim()) && o.trim().length > 10) {
				limpias.push(o.trim());
			}
		}
		if (limpias.length > 0) {
			text = limpias.join(' ');
		}
	}

	// 1) Quitar bloques de pensamiento explícitos
	text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	text = text.replace(/```[\s\S]*?```/g, '').trim();

	// 2) Cortar después del último marcador de "Draft N:"
	const draftMatches = [...text.matchAll(/draft\s*\d+\s*:?\s*/gi)];
	if (draftMatches.length > 0) {
		const last = draftMatches[draftMatches.length - 1];
		text = text.slice(last.index! + last[0].length).trim();
	}

	// 3) Cortar después del último marcador estilo "Respuesta final:", etc.
	const finalMarkerRe = /(?:respuesta\s*final|final\s*answer|final\s*draft|borrador\s*final|mensaje\s*al\s*cliente|respuesta\s*al\s*cliente|asistente|assistant|output)\s*:\s*/gi;
	const finalMatches = [...text.matchAll(finalMarkerRe)];
	if (finalMatches.length > 0) {
		const last = finalMatches[finalMatches.length - 1];
		text = text.slice(last.index! + last[0].length).trim();
	}

	// 4) Cortar checklists y auto-evaluación tipo "Brief? Yes. Direct? Yes."
	// y extraer el texto de respuesta real que viene después (inline o en línea aparte).
	const evalLineRe = /^[\wáéíóúñÁÉÍÓÚÑ\/()",.!? ¡¿'-]+\?\s*(?:Yes|No|Sí|Si)/i;
	const evalLines = text.split('\n').map((l) => l.trim());
	const evalIndices: number[] = [];
	evalLines.forEach((l, i) => { if (evalLineRe.test(l)) evalIndices.push(i); });

	if (evalIndices.length >= 2) {
		// Hay auto-evaluación → reconstruir: eliminar líneas de evaluación y
		// extraer texto final inline (después del último "Yes." en la misma línea)
		const keptLines: string[] = [];

		for (let i = 0; i < evalLines.length; i++) {
			if (evalIndices.includes(i)) {
				// Línea de evaluación: extraer texto después del último "Yes/No".
				const m = evalLines[i].match(evalLineRe);
				if (m) {
					const after = evalLines[i].slice(m[0].length).trim();
					if (after) keptLines.push(after);
				}
				continue;
			}
			// Antes del bloque de evaluación: filtrar ruido, conservar solo si
			// parece texto de respuesta real (tiene puntuación, mayúscula inicial,
			// contenido sustancial)
			if (i < evalIndices[0]) {
				const t = evalLines[i];
				if (t.length > 20 && /[.!?¡¿]$/.test(t) && /^[A-ZÁÉÍÓÚÑ¡¿]/i.test(t)) {
					keptLines.push(t);
				}
				continue;
			}
			// Después del bloque: todo es texto de respuesta
			keptLines.push(evalLines[i]);
		}

		const result = keptLines.join('\n').trim();
		if (result.length > 10) text = result;
	}

	// 5) Quitar auto-verificación tipo "Checking constraints: ..." y "Option N: ..."
	text = text.replace(/^Checking\s+constraints:[\s\S]*?(?=\n(?:Sí|¡Claro|Tenemos|Esa|La|Perfecto|\d+\.|[\wÁÉÍÓÚÑ]))/i, '').trim();
	text = text.replace(/^(?:Option|Opción)\s+\d+\s*:\s*[^\n]*/im, '').trim();
	text = text.replace(/\n(?:Option|Opción)\s+\d+\s*:\s*[^\n]*/gi, '').trim();
	text = text.replace(/\d+\s*lines?\s*max\??\s*:\s*(?:yes|no|sí|si)/gi, '').trim();
	text = text.replace(/(?:max|máx)\s*\d+\s*(?:lines|palabras|productos)\??\s*\??\s*(?:yes|no|sí|si)/gi, '').trim();

	// 5b) Quitar auto-rezonamiento en inglés (modelo probando respuestas)
	//     Patrón:  " Applying that here:", " Or, I can...", " But the rule says...", " Final veron/version:"
	text = text.replace(/"[^"]+"\s*\n*\s*(?:Applying\s+that\s+here|Or[,]?\s*I\s+can|But\s+the\s+rule\s+says|However|Let me|I think|Actually|The\s+user\s+asked|Since\s+the|The\s+key\s+point|Wait|I'll|Maybe\s+I\s+should|The\s+correct)[^.]*\./gi, '').trim();
	text = text.replace(/(?:Applying\s+that\s+here|Or[,]?\s*I\s+can|But\s+the\s+rule\s+says|However|Let me|Actually|The\s+user\s+asked|Since\s+the)[^.]*\.\s*/gi, '').trim();
	// Quitar líneas completas en inglés auto-diagnóstico
	const englishLines = text.split('\n').filter(l => {
		const t = l.trim();
		if (!t) return true;
		// Detectar línea que es auto-rezonamiento en inglés (no es respuesta al cliente)
		if (/^[""'"][A-ZÁÉÍÓÚÑ]/i.test(t) && /Applying|But the|Or, I|However|Let me|Actually|I think|The user|Since the|The key|Wait,|I'll|Maybe I|The correct/i.test(t)) return false;
		return true;
	});
	if (englishLines.length > 0) text = englishLines.join('\n').trim();

	// 6) Cortar listas de "User Role:", "Client Goal:", etc.
	const labelRe = /(?:^|[\s.])(?:user role|client goal|customer goal|customer's current request|customer current request|context(?:\s+from\s+previous\s+examples)?|reference info|style|i need to know|the customer is interested|the draft|following the examples)\s*:?/gi;
	const labelMatches = [...text.matchAll(labelRe)];
	if (labelMatches.length > 0) {
		const lastLabel = labelMatches[labelMatches.length - 1];
		const afterLabel = text.slice(lastLabel.index! + lastLabel[0].length);
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

	// 8) Quitar líneas que sean solo encabezados
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

	// 9) Quitar duplicación al final
	const fullDup = text.match(/^([\s\S]+?)\s*\1\s*$/);
	if (fullDup && fullDup[1].length > 30) {
		text = fullDup[1].trim();
	} else {
		text = dedupeTail(text);
	}

	// 9b) Deduplicación por oraciones
	text = dedupeBySentence(text);

	// 10) Compactar espacios
	text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

	// 11) VALIDACIÓN FINAL DE SEGURIDAD — Si después de toda la limpieza
	//     aún quedan patrones de razonamiento interno, es mejor devolver
	//     un mensaje genérico que exponer el pensamiento de la IA al cliente.
	const patronesPeligrosos = [
		/\bWait,?\s/i,
		/\bLet me\b/i,
		/\bDouble check/i,
		/\bFinal Polish/i,
		/\bRevised Draft/i,
		/\bthe system prompt/i,
		/\bthe asstant/i,
		/\bI must\b/i,
		/\bI should\b/i,
		/\bI think\b/i,
		/\bI need to\b/i,
		/\bApplying that here/i,
		/\bBut the rule says/i,
		/\?\s*(?:Yes|No)\.\s/i,           // "Colombian Spanish? Yes."
		/Warm\/Clear\/Direct/i,
		/asterisks\/formatting/i,
		/Payment\/Shipping/i,
		/Colombian Spanish\?/i,
	];

	const tienePatronPeligroso = patronesPeligrosos.some(p => p.test(text));
	if (tienePatronPeligroso) {
		// Intentar rescatar solo la primera oración limpia en español
		const primeraOracion = text.match(/^([¡¿]?[A-ZÁÉÍÓÚÑ][^.!?]*[.!?])/);
		if (primeraOracion && primeraOracion[1].length > 15 && !patronesPeligrosos.some(p => p.test(primeraOracion[1]))) {
			text = primeraOracion[1];
		} else {
			// No se pudo rescatar nada limpio → mensaje genérico seguro
			text = '¡Hola! Disculpa la demora. ¿Podrías repetirme tu consulta para ayudarte mejor? 😊';
		}
	}

	return text;
}

function dedupeTail(text: string): string {
	const len = text.length;
	if (len < 60) return text;

	const candidatePositions: number[] = [];
	for (let i = Math.floor(len * 0.3); i < len * 0.7; i++) {
		const ch = text[i];
		const prev = text[i - 1];
		if ((ch === '¡' || ch === '¿') && i > 30) {
			candidatePositions.push(i);
		} else if (
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

function dedupeBySentence(text: string): string {
	if (text.length < 60) return text;

	const parts = text.split(/(?=¡[A-ZÁÉÍÓÚÑ])|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/);
	if (parts.length < 2) return text;

	const mid = Math.floor(parts.length / 2);
	const firstHalf = parts.slice(0, mid).join(' ').trim();
	const secondHalf = parts.slice(mid).join(' ').trim();

	if (firstHalf.length > 30 && secondHalf.length > 30) {
		const a = normalizeForCompare(firstHalf);
		const b = normalizeForCompare(secondHalf);
		const minLen = Math.min(a.length, b.length);
		const maxLen = Math.max(a.length, b.length);
		if (maxLen > 0 && minLen / maxLen > 0.85) {
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
					const newParts = [...parts.slice(0, i + 1), ...parts.slice(i + 2)];
					return newParts.join(' ').trim();
				}
			}
		}
	}

	return text;
}

// ─── Constructor de prompt estilo "conversación continua" ────────────────────

interface FewShotExample {
	cliente: string;
	asistente: string;
}

function buildUserDataContext(userData?: Record<string, any> | null): string {
	if (!userData) return '';
	const campos = ['nombre', 'cedula', 'direccion', 'telefono', 'presupuesto', 'productoSolicitado', 'ciudad', 'departamento'];
	const parts = campos
		.filter((k) => userData[k] != null && userData[k] !== '')
		.map((k) => {
			const labels: Record<string, string> = {
				nombre: 'Nombre',
				cedula: 'Cédula',
				direccion: 'Dirección',
				telefono: 'Teléfono',
				presupuesto: 'Presupuesto',
				productoSolicitado: 'Producto que busca',
				ciudad: 'Ciudad',
				departamento: 'Departamento',
			};
			return `${labels[k] || k}: ${userData[k]}`;
		});
	if (parts.length === 0) return '';
	return `\nDATOS DEL CLIENTE (ya recolectados):\n${parts.join('\n')}\n`;
}

function buildGemmaPrompt(opts: {
	instruccion: string;
	ejemplos: FewShotExample[];
	historial: string;
	mensajeCliente: string;
}): { system: string; user: string } {
	const system = `${opts.instruccion}

FORMATO DE RESPUESTA OBLIGATORIO:
- Responde ÚNICAMENTE el mensaje para el cliente.
- Español colombiano natural, cercano y femenino (eres Sara).
- Mensajes cortos tipo WhatsApp: 1-3 frases máximo.
- Sin asteriscos, sin encabezados, sin etiquetas, sin listas con viñetas.
- PROHIBIDO incluir tu razonamiento, borradores, auto-evaluación o checklist.
- PROHIBIDO escribir en inglés.
- PROHIBIDO usar frases genéricas como "¡Excelente elección!", "¡Qué bue que preguntas!", "¡Con gusto!". Sé natural.
- Si no estás seguro de algo, di "déjame verificar" en vez de inventar.
- Tu respuesta empieza directamente con el mensaje al cliente.
- Usa un tono cálido como si fueras una amiga que trabaja en la tienda.`;

	const ejemplosTexto = opts.ejemplos
		.map((e) => `Cliente: ${e.cliente}\nAsistente: ${e.asistente}`)
		.join('\n\n');

	const historialTexto = opts.historial ? `${opts.historial}\n` : '';

	const user = `${ejemplosTexto}\n\n---\n\n${historialTexto}Cliente: ${opts.mensajeCliente}\nAsistente:`;

	return { system, user };
}

// ─── VALIDADOR DE COBERTURA ───────────────────────────────────────────────────
//
// Departamentos con cobertura propia (envío gratis cuando aplica).
// Zonas fuera de esta lista = contado + transportadora Coordinadora a cargo
// del cliente. Fuente: info.md / configuración JLC.
//
// NOTA: mantener esta lista actualizada (mejora #12 del info.md).

const DEPARTAMENTOS_COBERTURA = [
	'nariño', 'narino',
	'cauca',
	'putumayo',
	'huila',
	'valle', 'valle del cauca',
];

// Algunas ciudades/municipios clave para detección rápida por nombre
const CIUDADES_COBERTURA: string[] = [
	// Nariño
	'pasto', 'tumaco', 'ipiales', 'la union', 'la unión', 'samaniego',
	'túquerres', 'tuquerres', 'barbacoas', 'el charco', 'sandoná', 'sandona',
	// Cauca
	'popayán', 'popayan', 'santander de quilichao', 'miranda', 'patía', 'patia',
	'puerto tejada', 'piendamó', 'piendamo', 'el tambo', 'cajibío', 'cajibio',
	// Putumayo
	'mocoa', 'puerto asís', 'puerto asis', 'orito', 'sibundoy', 'valle del guamuez',
	'san miguel', 'villagarzón', 'villagarzon',
	// Huila
	'neiva', 'pitalito', 'garzón', 'garzon', 'la plata', 'campoalegre',
	'rivera', 'palermo', 'gigante', 'isnos', 'san agustín', 'san agustin',
	// Valle del Cauca
	'cali', 'buenaventura', 'palmira', 'tuluá', 'tulua', 'buga',
	'cartago', 'jamundí', 'jamundi', 'yumbo', 'florida', 'pradera',
	'zarzal', 'la victoria', 'roldanillo', 'el cerrito',
];

/**
 * Determina si una ciudad/departamento mencionado tiene cobertura JLC.
 * Retorna: 'cobertura' | 'sin_cobertura' | 'desconocido'
 */
async function verificarCobertura(lugar: string): Promise<'cobertura' | 'sin_cobertura' | 'desconocido'> {
	if (!lugar) return 'desconocido';
	const l = lugar.toLowerCase().trim();

	// Búsqueda rápida en listas locales
	if (DEPARTAMENTOS_COBERTURA.some((d) => l.includes(d))) return 'cobertura';
	if (CIUDADES_COBERTURA.some((c) => l.includes(c))) return 'cobertura';

	// Ciudades grandes colombianas conocidas fuera de cobertura → sin_cobertura directamente
	const fueraCobertura = [
		'bogota', 'bogotá', 'medellin', 'medellín', 'barranquilla', 'cartagena',
		'cucuta', 'cúcuta', 'bucaramanga', 'pereira', 'manizales', 'ibague', 'ibagué',
		'santa marta', 'villavicencio', 'monteria', 'montería', 'sincelejo',
		'valledupar', 'tunja', 'armenia', 'quibdo', 'quibdó', 'riohacha',
		'leticia', 'arauca', 'yopal', 'florencia', 'san andrés', 'san andres',
	];
	if (fueraCobertura.some(c => l.includes(c))) return 'sin_cobertura';

	// Fallback: usar IA para lugares no reconocidos
	try {
		return await verificarCoberturaConIA(lugar);
	} catch {
		return 'desconocido';
	}
}

// ─── Descripción del área de cobertura JLC para Gemini ──────────────────────
//
// Fuente: mapa oficial JLC Electronics (Nariño, Cauca, Putumayo, Huila, Valle)
const COBERTURA_DESCRIPCION = `
JLC Electronics tiene cobertura de envío gratis en los siguientes departamentos y municipios de Colombia:

DEPARTAMENTOS CON COBERTURA TOTAL:
- Nariño (completo)
- Cauca (completo)
- Putumayo (completo)
- Huila (completo)
- Valle del Cauca (completo)

MUNICIPIOS PRINCIPALES CUBIERTOS:
Nariño: Pasto, Tumaco, Ipiales, La Unión, Samaniego, Túquerres, Barbacoas, El Charco, Sandoná
Cauca: Popayán, Santander de Quilichao, Miranda, Patía, Puerto Tejada, Piendamó, El Tambo, Cajibío
Putumayo: Mocoa, Puerto Asís, Orito, Sibundoy, Valle del Guamuez, San Miguel, Villagarzón
Huila: Neiva, Pitalito, Garzón, La Plata, Campoalegre, Rivera, Palermo, Gigante, Isnos, San Agustín
Valle del Cauca: Cali, Buenaventura, Palmira, Tuluá, Buga, Cartago, Jamundí, Yumbo, Florida, Pradera, Zarzal, La Victoria, Roldanillo, El Cerrito

CUBRIMOS TODO EL DEPARTAMENTO, no solo los municipios listados.
NO tenemos cobertura en otros departamentos como Antioquia, Bogotá/Cundinamarca, Santander, Boyacá, etc.
`.trim();

// ─── AI fallback: detectar ciudad usando Gemini ────────────────────────────
// Se usa cuando las listas rápidas no encuentran la ubicación.
const IA_CACHE = new Map<string, { result: any; expires: number }>();

function getCached<T>(key: string): T | null {
	const entry = IA_CACHE.get(key);
	if (entry && entry.expires > Date.now()) return entry.result as T;
	IA_CACHE.delete(key);
	return null;
}

function setCache(key: string, result: any, ttlMs = 300_000) {
	IA_CACHE.set(key, { result, expires: Date.now() + ttlMs });
}

export async function detectarCiudadConIA(mensaje: string): Promise<string | null> {
	const key = `ciudad_${mensaje.toLowerCase().trim()}`;
	const cached = getCached<string | null>(key);
	if (cached !== null) return cached;

	try {
		const respuesta = await generateResponse(
			`Mensaje: "${mensaje}"

			¿Este mensaje menciona una ciudad, municipio, vereda, corregimiento o departamento de Colombia?
			Si menciona UNA SOLA ubicación, responde SOLO con el nombre de la ciudad/municipio (sin el departamento).
			Si menciona ciudad Y departamento, responde SOLO con la ciudad/municipio.
			Si menciona varias ubicaciones o ninguna, responde SOLO: NO

			Ejemplos:
			- "soy de bogotá" → bogotá
			- "vivo en cali valle" → cali
			- "el peñol nariño" → el peñol
			- "estoy en ipiales" → ipiales
			- "busco un congelador" → NO
			- "quiero un televisor" → NO
			- "medellín" → medellín
			- "bogotá cundinamarca" → bogotá`,
			'Responde ÚNICAMENTE con el nombre de la ciudad o "NO". Sin explicaciones, sin puntuación extra.'
		);

		const trimmed = respuesta.trim().toLowerCase();
		const result = (trimmed === 'no' || trimmed.length < 3) ? null : trimmed;
		setCache(key, result);
		return result;
	} catch {
		return null;
	}
}

export async function verificarCoberturaConIA(ciudad: string): Promise<'cobertura' | 'sin_cobertura' | 'desconocido'> {
	const key = `cobertura_${ciudad.toLowerCase().trim()}`;
	const cached = getCached<'cobertura' | 'sin_cobertura' | 'desconocido'>(key);
	if (cached) return cached;

	try {
		const respuesta = await generateResponse(
			`Ciudad/municipio: "${ciudad}"

			Área de cobertura JLC Electronics:
			${COBERTURA_DESCRIPCION}

			¿Esta ciudad/municipio está dentro del área de cobertura de JLC Electronics?
			- Si SÍ tiene cobertura de envío gratis → responde SOLO: SI
			- Si NO tiene cobertura → responde SOLO: NO
			- Si no estás seguro o la información es insuficiente → responde SOLO: NO

			IMPORTANTE: Si solo es el nombre del departamento (ej: "nariño", "cauca"), responde SI porque cubrimos departamentos completos.
			Si es una ciudad de otro departamento no listado (ej: "medellín", "bogotá"), responde NO.`,
			'Responde ÚNICAMENTE con "SI", "NO" o "DESCONOCIDO". Sin explicaciones.'
		);

		const trimmed = respuesta.trim().toUpperCase();
		let result: 'cobertura' | 'sin_cobertura' | 'desconocido';
		if (trimmed === 'SI') result = 'cobertura';
		else if (trimmed === 'NO') result = 'sin_cobertura';
		else result = 'desconocido';

		setCache(key, result, 600_000); // 10 min cache
		return result;
	} catch {
		return 'desconocido';
	}
}

// ─── AGENTE BIENVENIDA ────────────────────────────────────────────────────────
//
// Mejoras aplicadas (info.md):
//  #1  Inicio organizado con menú claro desde el primer mensaje.
//  #13 Lenguaje más natural y cálido.

const AGENT_NAME = 'Sara';

function getSaludo(): string {
	const hora = new Date().getHours();
	if (hora >= 5 && hora < 12) return 'Buenos días';
	if (hora >= 12 && hora < 19) return 'Buenas tardes';
	return 'Buenas noches';
}

export class BienvenidaAgent implements IAgent {
	name = 'Bienvenida';

	private tieneIntencionClara(mensaje: string): boolean {
		const keywords = [
			'nevera', 'televisor', 'tv', 'lavadora', 'congelador', 'parlante',
			'precio', 'cotizar', 'cuánto', 'cuanto', 'comprar', 'garantía',
			'garantia', 'técnico', 'tecnico', 'distribuidor', 'trabajo', 'vacante',
			'pago', 'crédito', 'credito', 'envío', 'envio', 'repuesto', 'cartera',
			'cuota', 'deuda',
		];
		const lower = mensaje.toLowerCase();
		return keywords.some((kw) => lower.includes(kw));
	}

	async handle(message: string, _context: any): Promise<AgentResponse> {
		const saludo = getSaludo();
		const tieneIntencion = this.tieneIntencionClara(message);

		// Si el usuario ya llegó con una intención clara, bienvenida breve
		if (tieneIntencion) {
			return {
				response: `${saludo} 👋 Soy ${AGENT_NAME}, asistente virtual de JLC Electronics. Con gusto te ayudo con eso.`,
				metadata: {
					agentType: 'bienvenida',
					passthrough: true,
				},
			};
		}

		// Bienvenida completa con menú organizado (mejora #1)
		const menu = `${saludo} 👋 Soy ${AGENT_NAME}, tu asesora virtual en JLC Electronics.

¿En qué te puedo ayudar?

1️⃣ Comprar un producto (contado o crédito)
2️⃣ Cartera / estado de cuenta
3️⃣ Servicio técnico o garantía
4️⃣ Repuestos
5️⃣ Medios de pago / pagar una cuota
6️⃣ Distribuidores
7️⃣ Trabaja con nosotros

Escríbeme el número o cuéntame qué necesitas 😊`;

		return {
			response: menu,
			metadata: { agentType: 'bienvenida', passthrough: false },
		};
	}
}

// ─── TIPOS ───────────────────────────────────────────────────────────────────

interface CreditoData {
	nombres?: string;
	apellidos?: string;
	cedula?: string;
	celular?: string;
	direccion?: string;
	tipoVivienda?: string;
	departamento?: string;
	ciudad?: string;
	personasACargo?: string;
	empresa?: string;
	cargo?: string;
	experienciaLaboral?: string;
	estadoCivil?: string;
	ingresosMensuales?: string;
	gastosMensuales?: string;
	otrosIngresos?: string;
	reportadoDataCredito?: string;
	dispuestoSaldarDeuda?: string;
	producto?: string;
	skuProducto?: string;
}

interface CreditoStep {
	field: keyof CreditoData;
	pregunta: string;
	opciones?: string[];
}

// ─── PASOS DEL FORMULARIO DE CRÉDITO ─────────────────────────────────────────

const CREDITO_STEPS: CreditoStep[] = [
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function resolverOpcion(respuesta: string, opciones: string[]): string {
	const r = respuesta.trim();
	const porNumero = parseInt(r, 10);
	if (!isNaN(porNumero) && porNumero >= 1 && porNumero <= opciones.length) {
		return opciones[porNumero - 1];
	}
	const porTexto = opciones.find((o) =>
		o.toLowerCase().includes(r.toLowerCase())
	);
	return porTexto ?? r;
}

function formatearResumenCredito(data: CreditoData): string {
	return `
🟦 SOLICITUD DE CRÉDITO - JLC Electronics

👤 Datos personales
- Nombre: ${data.nombres} ${data.apellidos}
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

async function enviarResumenWhatsApp(resumen: string): Promise<void> {
	const WHATSAPP_CARTERA = process.env.WA_CARTERA || '573007215438';
	await sendWA(WHATSAPP_CARTERA, resumen);
}

// ─── AGENTE VENTAS ────────────────────────────────────────────────────────────
//
// Mejoras aplicadas (info.md):
//  #2  Validación de cobertura obligatoria antes de cotizar.
//  #3  Si no hay cobertura → solo contado + Coordinadora, cliente decide si sigue.
//  #4  Flujo ordenado: ciudad → cobertura → contado/crédito → producto.
//  #5  En crédito: solo perfilar producto (pulgadas/litros/kilos) y transferir.
//  #6  Precio de contado SOLO si el cliente elige contado o lo pide expresamente.
//  #7  En crédito, la IA se retira tras identificar el producto.
//  #8  No se comparten datos de agencias; el asesor humano los da después.

export class VentasAgent implements IAgent {
	name = 'Ventas';

	// ── Flujo de crédito paso a paso ──────────────────────────────────────────
	private async manejarFlujoCredito(
		message: string,
		context: any
	): Promise<AgentResponse> {
		const creditoData: CreditoData = {
			...context?.creditoData,
			// Pre-poblar desde UserData persistido si existe
			...(context?.userData?.nombre ? { nombres: context.userData.nombre } : {}),
			...(context?.userData?.cedula ? { cedula: context.userData.cedula } : {}),
			...(context?.userData?.departamento ? { departamento: context.userData.departamento } : {}),
			...(context?.userData?.ciudad ? { ciudad: context.userData.ciudad } : {}),
			...(context?.userData?.productoSolicitado ? { producto: context.userData.productoSolicitado } : {}),
		};
		const stepIndex: number = context?.creditoStep ?? 0;

		if (stepIndex > 0) {
			const stepAnterior = CREDITO_STEPS[stepIndex - 1];

			// Reconocimiento inteligente de nombres: si estamos pidiendo nombres,
			// aceptar cualquier texto que parezca un nombre (no solo si matchea opciones)
			if (stepAnterior.field === 'nombres') {
				const textoLimpio = message.trim();
				// Aceptar como nombre si: tiene al menos 2 caracteres, 
				// no es solo un número, no es un emoji solo
				if (textoLimpio.length >= 2 && !/^\d+$/.test(textoLimpio) && !/^[\p{Emoji}\s]+$/u.test(textoLimpio)) {
					creditoData.nombres = textoLimpio;
				}
				// Si no se pudo interpretar como nombre, volver a pedir
				if (!creditoData.nombres) {
					return {
						response: 'Disculpa, no logré captar tu nombre. ¿Me lo escribes de nuevo? 😊',
						metadata: {
							agentType: 'ventas',
							flujo: 'credito',
							creditoData,
							creditoStep: stepIndex, // mismo paso
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

			// Transiciones naturales entre preguntas (no solo la pregunta pelada)
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

		// Todos los campos completos → enviar resumen y TRANSFERIR (mejora #7)
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
			const index = parseInt(opcion, 10) - 1;
			if (!isNaN(index) && index >= 0 && index < ultimosProductos.length) {
				const selected = ultimosProductos[index];
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
			// Intentar detectar ciudad con IA si la extracción directa falla
			let ciudadDetectada = await extraerCiudadDelMensaje(message);
			if (!ciudadDetectada) {
				ciudadDetectada = await detectarCiudadConIA(message);
			}
			if (!ciudadDetectada) {
				// Último recurso: usar el texto tal como lo escribió
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

			// Sin cobertura o desconocido → solo contado, preguntar producto directo
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
				// Intro natural sin mencionar cantidad de campos (cliente desiste si ve "19 campos")
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

			// No entendió → preguntar de nuevo
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
			// Intentar extraer ciudad del mensaje actual
			const ciudadDetectada = await extraerCiudadDelMensaje(message);

			if (!ciudadDetectada) {
				// No se detectó ciudad → preguntar
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

			// Sin cobertura o desconocido → solo contado, preguntar producto directo
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
		const quiereComprar = /\b(?:comprar(?:lo|la)?|lo quiero|la quiero|quiero esa|quiero este|quiero comprar|c[oó]mo (?:compro|hago|puedo pagar|le hago|le hago para pagar|pago)|quiero pagar|proceder|concretar|compralo|c[oó]mpralo|reservar|apartar|d[áa]le|confirmo compra|ya lo quiero|me gusta esa|me gusta esta|me gusta ese|esa me gusta|esta me gusta|si continuemos|si sigamos|sigamos adelante|seguimos|continuemos)\b|\bcompr(?:o|ar)\s+(?:esa|este|ese)\b|\b(?:el de \d+|el primero|el segundo|me quedo con|me interesa el|prefiero el)\b/i.test(message);

		if (quiereComprar && context?.modalidad === 'contado') {
			const tieneCobertura = context?.tieneCobertura;
			const opcionPuntoFisico = tieneCobertura
				? '\n3️⃣ Paga en un punto físico'
				: '';

			// Extraer producto de la última búsqueda o del mensaje del usuario
			const ultimosProductos = context?.ultimaBusqueda?.results ?? [];
			let productoSolicitado: string | undefined;
			let productoURL: string | undefined;
			let pPrice: string | undefined;
			if (ultimosProductos.length === 1) {
				productoSolicitado = ultimosProductos[0].name;
				productoURL = ultimosProductos[0].permalink;
				pPrice = ultimosProductos[0].price;
			} else if (ultimosProductos.length > 1) {
				const lowerMsg = message.toLowerCase();
				const match = ultimosProductos.find((p: any) =>
					p.name.toLowerCase().includes(lowerMsg) ||
					lowerMsg.includes(p.name.toLowerCase().slice(0, 20)) ||
					(lowerMsg.includes('900w') && p.name.toLowerCase().includes('900w')) ||
					(lowerMsg.includes('700w') && p.name.toLowerCase().includes('700w')) ||
					(lowerMsg.includes('primero') && ultimosProductos[0] === p) ||
					(lowerMsg.includes('segundo') && ultimosProductos[1] === p)
				);
				
				if (!match) {
					const listaNombres = ultimosProductos.slice(0, 3).map((p: any, i: number) => {
						const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar';
						return `${i + 1}️⃣ *${p.name}* (${precio})`;
					}).join('\n');
					
					return {
						response: `¡Me alegra que te decidas a comprar! 😊 Pero como te había mostrado varias opciones, ¿me confirmas cuál de ellas prefieres? Escríbeme el número:\n\n${listaNombres}\n\nQuedo atenta para darte las instrucciones exactas de pago.`,
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
				
				const selected = match;
				productoSolicitado = selected.name;
				productoURL = selected.permalink;
				pPrice = selected.price;
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
				// Escalar a humano: notificar internamente
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
			// Si dice que sí pudo → pedir comprobante
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
			// No quiere ayuda
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

		// ── PASO 4d: Confirmación de pago realizado (Mejora #7 de info.md) ──
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
			// Recuperar URL del producto desde la última búsqueda o contexto
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
			// No entendió
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
		// Patrones: nombre + cédula, dirección, teléfono
		const datosPersonales: Record<string, string> = {};
		const cedulaMatch = message.match(/\b\d{5,12}\b/);
		if (cedulaMatch) datosPersonales.cedulaCliente = cedulaMatch[0];

		const nombreMatch = message.match(/^(?:mi nombre es|soy|me llamo)\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s]+)/i);
		if (nombreMatch) datosPersonales.nombreCliente = nombreMatch[1].trim();

		if (message.length > 5 && message.split(/[,;]/).length >= 2 && datosPersonales.cedulaCliente) {
			// Posible formato: "Nicolas, 10853444444, cr34 via lorena"
			const partes = message.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
			if (partes.length >= 2 && !datosPersonales.nombreCliente) {
				datosPersonales.nombreCliente = partes[0];
			}
			if (partes.length >= 3) {
				datosPersonales.direccion = partes.slice(2).join(', ');
			}
		}

		// ── PASO 7: Motor de perfilamiento por categoría ────────────────────
		// Regla de Oro: Si el cliente nombra una categoría sin detalle exacto,
		// la siguiente respuesta SIEMPRE es una pregunta, NUNCA un producto.

		const perfilState = context?.perfilState as { categoria: string; step: number; answers: Record<string, string> } | undefined;

		// 7a) Estamos en medio de una sesión de perfilamiento → procesar respuesta
		if (context?.flujo === 'perfilando' && perfilState) {
			const pasos = PROFILING_STEPS[perfilState.categoria] || PROFILING_STEPS.otra;
			const pasoActual = pasos[perfilState.step - 1];
			if (pasoActual) {
				perfilState.answers[pasoActual.field] = resolverRespuestaPerfil(message, pasoActual.field);
				perfilState.step++;
			}

			const camposOk = camposPerfilCompletados(perfilState.answers);

			// Todos los pasos del perfil completados → recomendar productos
			if (camposOk >= pasos.length || perfilState.step > pasos.length) {
				const terminoBusqueda = obtenerTerminoBusquedaDesdePerfil(perfilState.categoria, perfilState.answers);
				// Continuar al flujo de ventas normal con término de búsqueda derivado del perfil
				// (colocamos terminoBusqueda en el contexto para que el flujo normal lo use)
				context = { ...context, flujo: null, terminoBusqueda };
				if (perfilState.answers.presupuesto) {
					datosPersonales.presupuesto = perfilState.answers.presupuesto;
				}
			} else {
				// Siguiente pregunta
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

		// 7b) Detectar si el mensaje actual menciona una categoría de producto
		const CATEGORIAS = CATEGORIAS_RE;
		const esCategoriaSola = CATEGORIAS.test(message) && message.split(/\s+/).length <= 4;
		const esBusquedaCategoria = CATEGORIAS.test(message) && /(?:busco|quiero|necesito|me interesa|tiene[ns]?|hay|venden|muestra|quisiera|info de|informacion de|precio de|precios de|cuesta|cuestan|vale|valen|consulta|tambi[eé]n)/i.test(message);
		const categoriaGeneral = esCategoriaSola || esBusquedaCategoria;

		// Detectar cambio de categoría: si el cliente ya tenía un producto seleccionado
		// pero ahora pide algo diferente, resetear el contexto de búsqueda anterior
		if (categoriaGeneral) {
			const nuevaCategoria = detectarCategoria(message);
			const categoriaAnterior = context?.ultimaBusqueda?.categoria;
			if (nuevaCategoria && categoriaAnterior && nuevaCategoria !== categoriaAnterior) {
				// Cliente cambió de categoría → limpiar búsqueda anterior
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
				// Detectar si el usuario ya dio información espontánea (shortcuts)
				const shortcuts = detectarShortcuts(message, cat);
				const pasos = PROFILING_STEPS[cat] || PROFILING_STEPS.otra;
				const campos = camposPerfilCompletados(shortcuts);

				// Si ya completó todos los campos espontáneamente, omitir perfilamiento
				if (campos >= pasos.length) {
					const terminoBusqueda = obtenerTerminoBusquedaDesdePerfil(cat, shortcuts);
					context = { ...context, terminoBusqueda };
				} else {
					// Iniciar perfilamiento: encontrar el primer campo sin responder
					const primerPaso = pasos.find(p => !shortcuts[p.field]);
					if (primerPaso) {
						return {
							response: primerPaso.pregunta,
							metadata: {
								agentType: 'ventas',
								flujo: 'perfilando',
								perfilState: { categoria: cat, step: pasos.indexOf(primerPaso) + 1, answers: shortcuts },
								ciudad: context?.ciudad,
								ciudadValidada: true,
								tieneCobertura: context?.tieneCobertura,
								modalidad: context?.modalidad,
								...datosPersonales,
							},
						};
					}
				}
			}
		}

		// Los datos personales se pasan en metadata para que message.handler los guarde

		// ── Flujo normal de ventas (mostrar productos) ──────────────────────
		const ciudadStr = context?.ciudad ? `En ${context.ciudad.charAt(0).toUpperCase() + context.ciudad.slice(1)}` : '';
		const envioStr = context?.tieneCobertura
			? 'tienes envío gratis'
			: 'pago de contado (flete por Coordinadora a cargo del cliente)';

		// Detectar si pide más opciones O más económicas/baratas de la misma categoría
		const pideMas = /(?:tienes\s*mas|hay\s*m[áa]s|m[áa]s\s*opciones|otr[oa]s?\s*opciones|quiero\s*ver\s*m[áa]s|mu[ée]strame\s*m[áa]s|busco\s*otr[oa]|alg[úu]n\s*otr[oa]|otr[oa]s?\s*opciones|diferente)/i.test(message);
		const pideMasEconomico = /(?:m[áa]s\s*(?:econ[oó]mic[oa]s?|barat[oa]s?|econ[oó]mic[oa])|algo\s*(?:m[áa]s\s*)?(?:econ[oó]mico|barato)|m[áa]s\s*barato|menos\s*costoso|de\s*menor\s*precio|hay\s*(?:algo\s*)?m[áa]s\s*barat)/i.test(message);

		let products: any[] = [];
		let hayProductos = false;
		let productoIndex = 0;
		let terminoBusqueda = context?.terminoBusqueda || message;

		// Extraer término de producto para guardar como productoSolicitado
		const busquedaMatch = message.match(/(?:busco|quiero|necesito|tiene[ns]?|hay|venden|muestra|muestrame|quisiera|me interesa|info de|informacion de)\s*(?:un[oa]?|unas?|disponible)?\s*([a-záéíóúñÁÉÍÓÚÑ][a-záéíóúñÁÉÍÓÚÑ\s]{2,40})/i);
		const productoBuscado = busquedaMatch ? busquedaMatch[1].trim() : terminoBusqueda;

		// ── Seguimiento: preguntas sobre productos ya mostrados ────────────
		const preguntaSeguimiento = /(?:especificaciones?|caracter[ií]sticas?|detalles?|d[ée]tal|cu[aá]nto cuesta|cu[aá]nto vale|cu[aá]l es|en qu[eé] se diferencia|diferencia|c[oó]mo es|descr[ií]belo|dimensiones|medidas|capacidad|color|modelo|referencia|precio|m[aá]s info|m[aá]s informaci[oó]n)/i.test(message) && context?.ultimaBusqueda?.results?.length > 0;

		if (preguntaSeguimiento) {
			const guardados = context.ultimaBusqueda.results as any[];
			const detalles = guardados.slice(0, 3).map((p: any) => {
				const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar precio';
				const desc = (p.short_description || p.description || '')
					.replace(/<[^>]+>/g, '')
					.replace(/&[a-z]+;/g, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 200);
				return `${p.name} — ${precio}\n   ${desc ? desc + '...' : ''}\n   ${p.permalink}`;
			}).join('\n\n');

			return {
				response: `Claro, aquí tienes los detalles:\n\n${detalles}\n\n¿Te gusta alguna? Puedo ayudarte con la compra.`,
				nextStage: 'PROPOSAL',
				metadata: {
					agentType: 'ventas',
					ciudadValidada: context?.ciudadValidada,
					ciudad: context?.ciudad,
					ultimaBusqueda: context?.ultimaBusqueda,
					...datosPersonales,
				},
			};
		}

		if (pideMas || pideMasEconomico) {
			const busquedaGuardada = context?.ultimaBusqueda;
			if (busquedaGuardada?.results?.length > 0) {
				products = busquedaGuardada.results;

				if (pideMasEconomico) {
					// Ordenar por precio ascendente y mostrar los más baratos que aún no se mostraron
					products = [...products].sort((a: any, b: any) => {
						const pa = parseFloat(a.price || '999999999');
						const pb = parseFloat(b.price || '999999999');
						return pa - pb;
					});
					productoIndex = 0; // Empezar desde el más barato
					
					// También re-buscar en WooCommerce con término + "economica" para ampliar resultados
					const catBusqueda = busquedaGuardada.categoria || context?.terminoBusqueda || '';
					if (catBusqueda) {
						try {
							const masProductos = await wooCommerceService.searchProducts(catBusqueda, 20);
							if (masProductos?.length > 0) {
								// Combinar sin duplicados, ordenar por precio
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
				// No hay búsqueda guardada → pedir que especifique
				return {
					response: `${ciudadStr} ${envioStr}. ¿Qué referencia o modelo buscas? Así te muestro lo que tenemos disponible 😊`,
					nextStage: 'PROPOSAL',
					metadata: { agentType: 'ventas', ciudad: context?.ciudad, ciudadValidada: context?.ciudadValidada },
				};
			}
		}

		if (products.length === 0) {
			const esConsultaProducto = /(?:tiene[ns]?|hay|venden|busco|quiero|necesito|me interesa|consulta|precio|cu[aá]nto)/i.test(message);

			try {
				// WooCommerce search
				if (!products || products.length === 0) {
					products = await wooCommerceService.searchProducts(terminoBusqueda, 20);
				}

				// 3) Fallback a búsqueda por palabras clave
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

				// Si el usuario preguntó específicamente por un producto que no está en categorías
				// y no se encontró nada, informar honestamente SIN recomendar otros productos
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
					const generalProducts = await wooCommerceService.getProducts(10);
					products = generalProducts.filter((p) => p.name && p.permalink);
				}

				hayProductos = products?.length > 0;
			} catch {
				// products se queda como []
			}
		}

		// Formatear productos para el prompt de la IA
		const productListStr = products.length > 0
			? products.map((p: any, i: number) => {
				const precio = p.price ? `$${Number(p.price).toLocaleString('es-CO')}` : 'Consultar precio';
				return `${i + 1}. ${p.name} - ${precio}\n   ${p.permalink}`;
			}).join('\n\n')
			: 'No se encontraron productos.';

		const userDataStr = buildUserDataContext(context?.userData);

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres ${AGENT_NAME}, asesora comercial y experta en electrodomésticos de JLC Electronics Colombia.
Personalidad y Estilo:
- Tono sumamente cálido, amigable, cercano y femenino. Imagina que eres una amiga servicial que asesora al cliente para su hogar.
- Español colombiano natural y coloquial (usa expresiones como "Ay, mira...", "Te cuento que...", "Qué pena contigo...").
- Muestra criterio y opinión propia sobre los productos para guiar al cliente (ej. "Esa lavadora de 16kg te la súper recomiendo si tienes una familia grande, está muy bien valorada y tiene buena capacidad").
- Evita sonar como un bot rígido. No uses frases genéricas como "¡Excelente elección!" ni hables como robot.
- Mensajes cortos tipo WhatsApp (máximo 1-3 frases por respuesta).

${ciudadStr ? `Ciudad del cliente: ${ciudadStr}.` : ''} ${envioStr ? `Condición de envío: ${envioStr}.` : ''}
${userDataStr}
REGLAS:
- Recomienda máximo 1-2 productos del CATÁLOGO con nombre, precio y enlace.
- Si hay productos, preséntalos de forma natural y breve.
- Si NO hay productos en el catálogo, dilo honestamente. NO inventes que "no tenemos" si el catálogo sí tiene.
- NUNCA inventes productos, precios ni disponibilidad.
- NUNCA compartas direcciones de agencias físicas.
- NUNCA contradigas la condición de envío ya comunicada al cliente.
- Sin asteriscos ni lenguaje técnico que confunda.
- Si el cliente ya dio datos (nombre, cédula, ciudad, presupuesto), úsalos sin pedirlos de nuevo.
- Si el cliente pide un producto NUEVO o diferente al anterior, ayúdale con eso. No insistas con el producto anterior.
- PROHIBIDO confirmar envío o despacho si el cliente no ha pagado. Di "tan pronto se confirme el pago".
- Si el cliente dice que ya pagó, pide el comprobante o número de transacción.
- NUNCA compartas números de WhatsApp de cartera, correos de facturación ni números de soporte de pago. Esos datos son exclusivos del área de cartera.
- NUNCA digas "generé tu orden de compra" ni "tu orden quedó lista". Di que el producto queda reservado pendiente a su pago.
- Si NO encontraste el producto exacto que busca, NO le recomiendes productos de otra categoría. Solo dile que no lo tenemos disponible y pregunta si busca algo más.
- NUNCA recomiendes productos que el cliente NO pidió (ej: si busca cafetera, NO ofrezcas arrocera ni licuadora).`,
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

		// Incluir catálogo como parte del mensaje para que la IA lo use
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

// ─── Helper: extraer ciudad de un mensaje ────────────────────────────────────

async function extraerCiudadDelMensaje(mensaje: string): Promise<string | null> {
	const lower = mensaje.toLowerCase();

	// Patrones: "soy de X", "estoy en X", "vivo en X", "escribo desde X", "ciudad: X"
	const patronesPrefijo = [
		/(?:soy de|estoy en|vivo en|escribo desde|desde|ciudad[:\s]+|ubicado en|me encuentro en)\s+([a-záéíóúñ\s]{3,30})/i,
	];

	for (const patron of patronesPrefijo) {
		const match = mensaje.match(patron);
		if (match) {
			return match[1].trim().toLowerCase();
		}
	}

	// Buscar directamente si el mensaje ES una ciudad (respuesta corta)
	const trimmed = lower.trim().replace(/[.,!?]+$/, '');
	if (trimmed.length > 2 && trimmed.length < 30 && !/\s{2,}/.test(trimmed)) {
		const allCities = [...CIUDADES_COBERTURA, ...DEPARTAMENTOS_COBERTURA];
		const exactMatch = allCities.find((c) => trimmed.includes(c) || c.includes(trimmed));
		if (exactMatch) return trimmed;

		// Solo asumir que es ciudad si al menos una palabra coincide con una ciudad/departamento conocido
		const words = trimmed.split(/\s+/);
		if (words.length <= 3 && words.every((w) => /^[a-záéíóúñ]+$/i.test(w))) {
			const algunaCoincide = words.some((w) =>
				w.length > 2 && allCities.some((c) => c.includes(w) || w.includes(c))
			);
			if (algunaCoincide) return trimmed;

			// Sin fallback a Gemini: si la palabra no coincide con ninguna ciudad conocida,
			// retornamos null para que el flujo PASO 2 (message.trim()) la capture cuando
			// el bot está esperando explícitamente la ubicación.
		}
	}

	return null;
}

// ─── AGENTE CARTERA ──────────────────────────────────────────────────────────
//
// Mejora #9: entregar directamente los canales reales, sin prometer que
// "un asesor se comunicará" (lo cual genera falsas expectativas).

export class CarteraAgent implements IAgent {
	name = 'Cartera';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Canales oficiales de cartera y facturación:
- WhatsApp cartera: +57 314 422 9949 y +57 315 721 2367
- Línea telefónica: +57 320 788 1108 (horario: 12:30 p.m. a 2:30 p.m., lunes a viernes)
- Correo peticiones con soportes: callcenter5@electromillonaria.co
Desde este chat no se puede acceder a información personal del cliente.${userDataCtx}`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de cartera de Electrodomésticos JLC. Tu rol es dar directamente los canales oficiales para que el cliente resuelva su consulta de forma inmediata. No prometas que "un asesor te llamará". Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Cuánto debo de mi crédito?',
					asistente:
						'Desde este chat no puedo acceder a tu información personal. Comunícate directamente con cartera por WhatsApp al +57 314 422 9949 o +57 315 721 2367 y te dan el detalle al instante.',
				},
				{
					cliente: 'Ya pagué la cuota, ¿dónde envío el soporte?',
					asistente:
						'Envía tu soporte de pago al WhatsApp de cartera: +57 314 422 9949 o +57 315 721 2367. Si tienes una petición formal, puedes escribir a callcenter5@electromillonaria.co.',
				},
				{
					cliente: 'Estoy atrasado, no puedo pagar este mes',
					asistente:
						'Entiendo la situación. Escribe al WhatsApp de cartera +57 314 422 9949 o llama al +57 320 788 1108 entre 12:30 y 2:30 p.m. para revisar opciones de reestructuración.',
				},
				{
					cliente: 'Quiero una paz y salvo',
					asistente:
						'Para solicitar tu paz y salvo, escribe al correo callcenter5@electromillonaria.co o al WhatsApp +57 314 422 9949 con tu número de cédula y ellos te lo envían.',
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
//
// Mejora #10: entregar automáticamente líneas de atención y WhatsApp según
// la marca del electrodoméstico. No dejar al cliente sin respuesta.

export class ServicioTecnicoAgent implements IAgent {
	name = 'Servicio Técnico';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Canales de servicio técnico JLC:${userDataCtx}
- WhatsApp técnico: +57 320 788 1151
- WhatsApp técnico (Diego): +57 320 788 1110
- Web: https://jlc-electronics.com/servicio-tecnico/
- Horario: lunes a sábado, 8:00 a.m. a 5:00 p.m.
Para garantías, el cliente debe tener factura de compra y el producto en buen estado externo.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de servicio técnico de Electrodomésticos JLC. Atiendes clientes con electrodomésticos dañados o que necesitan mantenimiento. Debes SIEMPRE dar los canales de contacto al final de tu respuesta para que el cliente pueda agendar. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: 'Mi lavadora no centrifuga',
					asistente:
						'Lamento la falla. Para agendar la revisión escribe al WhatsApp +57 320 788 1151 (lunes a sábado, 8 a.m. a 5 p.m.). ¿Me indicas marca y modelo para orientarte mejor?',
				},
				{
					cliente: 'Necesito mantenimiento para mi nevera JLC',
					asistente:
						'¡Con gusto! Escribe al WhatsApp +57 320 788 1151 o +57 320 788 1110 (Diego) para agendar el mantenimiento. Atienden lunes a sábado de 8 a.m. a 5 p.m.',
				},
				{
					cliente: 'Tengo una nevera en garantía que no enfría',
					asistente:
						'Para tramitar la garantía necesitarás la factura de compra y el equipo en buen estado externo. Escribe al WhatsApp +57 320 788 1151 y el técnico te indica los pasos.',
				},
				{
					cliente: '¿Cuánto cobra el técnico por visita?',
					asistente:
						'El costo de la visita lo confirma directamente el técnico según la zona y el tipo de equipo. Escríbele al +57 320 788 1151 (lunes a sábado, 8 a.m. a 5 p.m.) para que te cotice.',
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

// ─── AGENTE REPUESTOS ─────────────────────────────────────────────────────────
//
// Mejora comentario original: recolectar datos completos antes de responder
// (repuesto solicitado, referencia del producto, foto, nombre y cédula).

export class RepuestosAgent implements IAgent {
	name = 'Repuestos';

	async handle(message: string, context: any): Promise<AgentResponse> {
		// Flujo de recolección de datos para repuesto
		const repuestoData = context?.repuestoData ?? {};

		// Paso 1: nombre del repuesto / qué necesita
		if (!repuestoData.repuesto) {
			// Si el mensaje ya describe el repuesto, guardarlo
			if (message.length > 5 && !/^(hola|buenas|si|no|ok|claro)/i.test(message)) {
				repuestoData.repuesto = message.trim();
			} else {
				return {
					response: '¿Qué repuesto o pieza necesitas? Descríbelo lo mejor posible (ej: "filtro de agua nevera JLC", "empaque puerta lavadora").',
					metadata: { agentType: 'repuestos', flujo: 'repuestos', repuestoData },
				};
			}
		}

		// Paso 2: referencia o modelo del producto
		if (!repuestoData.referencia) {
			if (context?.flujo === 'repuestos' && repuestoData.repuesto && message !== repuestoData.repuesto) {
				repuestoData.referencia = message.trim();
			} else {
				return {
					response: `Gracias. ¿Cuál es la marca, modelo o referencia del electrodoméstico? (La encuentras en la placa trasera del equipo).`,
					metadata: { agentType: 'repuestos', flujo: 'repuestos', repuestoData },
				};
			}
		}

		// Paso 3: nombre y cédula del solicitante
		if (!repuestoData.nombreCliente) {
			if (context?.flujo === 'repuestos' && repuestoData.referencia && message !== repuestoData.referencia) {
				repuestoData.nombreCliente = message.trim();
			} else {
				return {
					response: `¿Cuál es tu nombre completo y número de cédula? (Necesarios para registrar tu solicitud).`,
					metadata: { agentType: 'repuestos', flujo: 'repuestos', repuestoData },
				};
			}
		}

		// Todos los datos básicos recolectados → buscar en WooCommerce y responder
		let productInfo = '';
		try {
			const products = await wooCommerceService.searchProducts(
				`${repuestoData.repuesto} ${repuestoData.referencia} repuesto`,
				3
			);
			if (products.length > 0) {
				productInfo = wooCommerceService.formatProductList(products);
			}
		} catch {
			// continuar sin catálogo
		}

		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Repuesto solicitado: "${repuestoData.repuesto}". Referencia equipo: "${repuestoData.referencia}". Solicitante: ${repuestoData.nombreCliente}.${userDataCtx}
Sin stock: tiempo de pedido 3 a 5 días hábiles. Web: https://jlc-electronics.com/.${productInfo ? ` Repuestos encontrados: ${productInfo}` : ' No se encontraron repuestos en catálogo en este momento.'}
Instrucción: indica al cliente que su solicitud fue registrada y que será respondida para confirmar disponibilidad y precio. Si hay repuestos en catálogo, mencionarlos. Pedirle que envíe foto del equipo si puede para confirmar la referencia exacta.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de repuestos de Electrodomésticos JLC. ${datos}`,
			ejemplos: [
				{
					cliente: 'Necesito un empaque para nevera JLC modelo JLC-325',
					asistente:
						'¡Gracias! Tu solicitud quedó registrada. En un momento revisamos disponibilidad y precio del empaque para la JLC-325 y te confirmamos. Si puedes, envíanos una foto de la puerta de la nevera para confirmar la medida exacta.',
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
			},
		};
	}
}

// ─── AGENTE VACANTES ─────────────────────────────────────────────────────────

export class VacantesAgent implements IAgent {
	name = 'Vacantes';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `No hay listado de vacantes cargado actualmente. El interesado deja sus datos para quedar en base de datos: nombre completo, cargo de interés, ciudad. Puede enviar hoja de vida.${userDataCtx}`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de recursos humanos de Electrodomésticos JLC. Atiendes a personas interesadas en trabajar en la empresa. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Tienen vacantes?',
					asistente:
						'¡Gracias por tu interés en trabajar con nosotros! En este momento no tengo el listado de vacantes disponible, pero puedo registrar tu perfil. ¿Me compartes tu nombre completo, el cargo de interés y tu ciudad?',
				},
				{
					cliente: 'Soy Carlos Pérez, busco asesor comercial en Cali',
					asistente:
						'¡Excelente, Carlos! Quedas registrado en nuestra base de datos. Si quieres, envía tu hoja de vida para adjuntarla a tu perfil y que RRHH te contacte cuando haya una vacante de asesor comercial en Cali.',
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
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Datos a recolectar paso a paso: 1. NIT, 2. Nombre o razón social, 3. Teléfono, 4. Correo, 5. Rango de ventas estimado, 6. Departamento, 7. Ciudad. Pedir uno o dos por mensaje, no todos de golpe.${userDataCtx}`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente del programa de distribuidores de Electrodomésticos JLC. Atiendes a interesados en ser distribuidores autorizados. Recolecta los datos de forma amable, de a poco. Datos: ${datos}`,
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
//
// Mejora #11: entregar automáticamente convenios, cuentas bancarias,
// medios de recaudo y líneas para envío de soportes.

export class PagosAgent implements IAgent {
	name = 'Medios de Pago';

	async handle(message: string, context: any): Promise<AgentResponse> {
		const userDataCtx = buildUserDataContext(context?.userData);
		const datos = `Medios de pago JLC Electronics:${userDataCtx}
1) En línea en https://jlc-electronics.com/ con PSE, tarjeta de crédito o débito.
2) En punto físico (el asesor indica la tienda más cercana según ciudad).
3) Crédito / cuotas: gestionado por Cristina al WhatsApp +57 318 740 8190.
4) Para envío de soportes de pago: WhatsApp cartera +57 314 422 9949 o +57 315 721 2367.
5) Correo para soporte de pago y facturación: callcenter5@electromillonaria.co.`;

		const { system, user } = buildGemmaPrompt({
			instruccion: `Eres asistente de medios de pago de Electrodomésticos JLC. Entrega SIEMPRE la información concreta de cómo pagar según lo que pide el cliente. No digas "un asesor te contactará"; da los datos directamente. Datos: ${datos}`,
			ejemplos: [
				{
					cliente: '¿Cómo puedo pagar?',
					asistente:
						'Tienes dos opciones rápidas: 1) En línea en https://jlc-electronics.com/ con PSE, tarjeta de crédito o débito. 2) En punto físico. ¿Cuál prefieres o desde qué ciudad escribes?',
				},
				{
					cliente: '¿Aceptan tarjeta de crédito?',
					asistente:
						'¡Sí! Al pagar en https://jlc-electronics.com/ puedes usar tarjeta de crédito, débito o PSE. ¿Ya tienes el producto seleccionado?',
				},
				{
					cliente: 'Quiero pagar a crédito',
					asistente:
						'El crédito lo gestiona Cristina. Escríbele al WhatsApp +57 318 740 8190 con el producto que te interesa y ella te guía paso a paso.',
				},
				{
					cliente: '¿A dónde mando el soporte de pago?',
					asistente:
						'Envía tu soporte de pago al WhatsApp de cartera: +57 314 422 9949 o +57 315 721 2367, o al correo callcenter5@electromillonaria.co.',
				},
				{
					cliente: '¿Tienen convenio con Efecty o Baloto?',
					asistente:
						'En este momento los medios habilitados son PSE, tarjeta de crédito/débito en línea y pago en punto físico. Para confirmar convenios adicionales, consulta directamente en https://jlc-electronics.com/ o escribe a Cristina al +57 318 740 8190.',
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