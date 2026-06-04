import { generateResponse } from '../utils/gemini.js';
import categoriasData from './categorias-generales.json';
import { FewShotExample } from './types.js';

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

export const CATEGORIAS_RE = buildCategoriaPatterns();

export interface ProfilingStep {
	field: string;
	pregunta: string;
}

export const PROFILING_STEPS: Record<string, ProfilingStep[]> = {
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

const NUMEROS_PALABRA: Record<string, number> = {
	'cero': 0, 'un': 1, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4,
	'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
	'once': 11, 'doce': 12, 'trece': 13, 'catorce': 14, 'quince': 15,
	'dieciseis': 16, 'diecisiete': 17, 'dieciocho': 18, 'diecinueve': 19,
	'veinte': 20, 'treinta': 30, 'cuarenta': 40, 'cincuenta': 50,
	'sesenta': 60, 'setenta': 70, 'ochenta': 80, 'noventa': 90,
	'cien': 100, 'cientos': 100, 'ciento': 100, 'doscientos': 200,
	'trescientos': 300, 'cuatrocientos': 400, 'quinientos': 500,
	'seiscientos': 600, 'setecientos': 700, 'ochocientos': 800,
	'novecientos': 900, 'mil': 1000, 'millon': 1_000_000, 'millones': 1_000_000,
};

function extraerNumero(texto: string): number | null {
	// 1. Intentar extraer número con dígitos (1.500.000, 1500000, etc)
	const digito = texto.match(/([\d.,]+)/);
	if (digito) {
		const limpio = digito[1].replace(/\./g, '').replace(/,/g, '');
		const n = parseFloat(limpio);
		if (!isNaN(n)) return n;
	}

	// 2. Convertir palabras sueltas (ej: "500" ya capturado arriba)
	const palabras = texto.toLowerCase().split(/[\s,]+/);
	const tokens: number[] = [];

	for (const p of palabras) {
		if (NUMEROS_PALABRA[p] !== undefined) {
			tokens.push(NUMEROS_PALABRA[p]);
		}
	}
	if (tokens.length === 0) return null;

	// Ej: "un millon quinientos" → [1, 1_000_000, 500]
	// "dos millones" → [2, 1_000_000]
	// "trescientos mil" → [300, 1000]
	let total = 0;
	let parcial = 0;
	let tuvoMillon = false;

	for (const t of tokens) {
		if (t >= 1_000_000) {
			const multiplo = Math.max(parcial, 1);
			total += multiplo * t;
			parcial = 0;
			tuvoMillon = true;
		} else if (t === 1000) {
			parcial = Math.max(parcial, 1) * t;
			total += parcial;
			parcial = 0;
		} else {
			parcial += t;
		}
	}
	// "un millón quinientos" → coloquialmente 1.500.000 (quinientos = 500.000)
	if (tuvoMillon && parcial > 0 && parcial < 1000) {
		parcial *= 1000;
	}
	total += parcial;

	return total || null;
}

export function resolverRespuestaPerfil(msg: string, field: string): string {
	const lower = msg.toLowerCase().trim();

	if (field === 'presupuesto') {
		if (/menos|bajo|barato|econ[oó]mico/i.test(lower)) return 'bajo';
		if (/medio|moderado|normal/i.test(lower)) return 'medio';
		if (/nevecon|alto|sin l[ií]mite|lo que sea|no importa|ilimitado/i.test(lower)) return 'alto';
		const valor = extraerNumero(lower);
		if (valor !== null) {
			if (valor < 1000000) return 'bajo';
			if (valor < 2500000) return 'medio';
			return 'alto';
		}
		return 'medio';
	}
	return msg;
}

export function detectarCategoria(msg: string): string | null {
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

export async function extraerProductoConIA(mensaje: string): Promise<string | null> {
	const prompt = `Extrae ÚNICAMENTE el nombre del producto o electrodoméstico del siguiente mensaje. Ignora verbos (quiero, busco, necesito, comprar, etc.), artículos, preposiciones y palabras genéricas. Responde SOLO con el nombre del producto, máximo 5 palabras, sin puntuación ni explicaciones.

Mensaje: "${mensaje}"
Producto:`;
	try {
		const respuesta = await generateResponse(prompt);
		const limpio = respuesta.replace(/[.,!?¡¿"'()\-:;]/g, '').trim().toLowerCase();
		if (limpio && limpio.length >= 2 && !/(?:no se|no pude|ninguno|nada|error|producto)/i.test(limpio)) {
			return limpio;
		}
	} catch { /* fallback silencioso */ }
	return null;
}

export function detectarShortcuts(message: string, categoria: string): Record<string, string> {
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

export function obtenerTerminoBusquedaDesdePerfil(categoria: string, answers: Record<string, string>): string {
	if (categoria === 'nevera') {
		if (answers.presupuesto === 'alto') return 'nevecon';
		return 'nevera';
	}
	if (categoria === 'cocina') return 'cocina';
	if (categoria === 'audio') return 'parlante';
	return categoria;
}

export function camposPerfilCompletados(answers: Record<string, string>): number {
	return Object.keys(answers).filter(k => !!answers[k]).length;
}

// ─── Helper: formatear historial ─────────────────────────────────────────────

export function formatHistory(history: Array<{ direction: string; body: string }>): string {
	if (!history || history.length === 0) return '';
	return history
		.slice(-20)
		.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Asistente'}: ${m.body}`)
		.join('\n');
}

// ─── Limpiador de respuestas de Gemma ────────────────────────────────────────

export function cleanResponse(raw: string): string {
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
	const fugaMasiva = /(?:Warm\/Clear\/Direct|Colombian Spanish|Payment\/Shipping|asterisks\/formatting|I must prioritize|the system prompt|the asstant|Revised Draft|Final Polish|Double check)/i;
	if (fugaMasiva.test(text)) {
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

	// 4) Cortar checklists y auto-evaluación
	const evalLineRe = /^[\wáéíóúñÁÉÍÓÚÑ\/()",.!? ¡¿'-]+\?\s*(?:Yes|No|Sí|Si)/i;
	const evalLines = text.split('\n').map((l) => l.trim());
	const evalIndices: number[] = [];
	evalLines.forEach((l, i) => { if (evalLineRe.test(l)) evalIndices.push(i); });

	if (evalIndices.length >= 2) {
		const keptLines: string[] = [];
		for (let i = 0; i < evalLines.length; i++) {
			if (evalIndices.includes(i)) {
				const m = evalLines[i].match(evalLineRe);
				if (m) {
					const after = evalLines[i].slice(m[0].length).trim();
					if (after) keptLines.push(after);
				}
				continue;
			}
			if (i < evalIndices[0]) {
				const t = evalLines[i];
				if (t.length > 20 && /[.!?¡¿]$/.test(t) && /^[A-ZÁÉÍÓÚÑ¡¿]/i.test(t)) {
					keptLines.push(t);
				}
				continue;
			}
			keptLines.push(evalLines[i]);
		}
		const result = keptLines.join('\n').trim();
		if (result.length > 10) text = result;
	}

	// 5) Quitar auto-verificación
	text = text.replace(/^Checking\s+constraints:[\s\S]*?(?=\n(?:Sí|¡Claro|Tenemos|Esa|La|Perfecto|\d+\.|[\wÁÉÍÓÚÑ]))/i, '').trim();
	text = text.replace(/^(?:Option|Opción)\s+\d+\s*:\s*[^\n]*/im, '').trim();
	text = text.replace(/\n?(?:Option|Opción)\s+\d+\s*:\s*[^\n]*/gi, '').trim();
	text = text.replace(/\d+\s*lines?\s*max\??\s*:\s*(?:yes|no|sí|si)/gi, '').trim();
	text = text.replace(/(?:max|máx)\s*\d+\s*(?:lines|palabras|productos)\??\s*\??\s*(?:yes|no|sí|si)/gi, '').trim();

	// 5b) Quitar auto-razonamiento en inglés
	text = text.replace(/"[^"]+"\s*\n*\s*(?:Applying\s+that\s+here|Or[,]?\s*I\s+can|But\s+the\s+rule\s+says|However|Let me|I think|Actually|The\s+user\s+asked|Since\s+the|The\s+key\s+point|Wait|I'll|Maybe\s+I\s+should|The\s+correct)[^.]*\./gi, '').trim();
	text = text.replace(/(?:Applying\s+that\s+here|Or[,]?\s*I\s+can|But\s+the\s+rule\s+says|However|Let me|Actually|The\s+user\s+asked|Since\s+the)[^.]*\.\s*/gi, '').trim();
	const englishLines = text.split('\n').filter(l => {
		const t = l.trim();
		if (!t) return true;
		if (/^[""'"][A-ZÁÉÍÓÚÑ]/i.test(t) && /Applying|But the|Or, I|However|Let me|Actually|I think|The user|Since the|The key|Wait,|I'll|Maybe I|The correct/i.test(t)) return false;
		return true;
	});
	if (englishLines.length > 0) text = englishLines.join('\n').trim();

	// 6) Cortar listas
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

	text = text.replace(
		/^\s*(?:asistente|assistant|respuesta|response|output|mensaje al cliente)\s*:\s*/i,
		''
	).trim();

	text = text.replace(/\*+/g, '').trim();

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

	const fullDup = text.match(/^([\s\S]+?)\s*\1\s*$/);
	if (fullDup && fullDup[1].length > 30) {
		text = fullDup[1].trim();
	} else {
		text = dedupeTail(text);
	}

	text = dedupeBySentence(text);
	text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

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
		/\?\s*(?:Yes|No)\.\s/i,
		/Warm\/Clear\/Direct/i,
		/asterisks\/formatting/i,
		/Payment\/Shipping/i,
		/Colombian Spanish\?/i,
	];

	const tienePatronPeligroso = patronesPeligrosos.some(p => p.test(text));
	if (tienePatronPeligroso) {
		const primeraOracion = text.match(/^([¡¿]?[A-ZÁÉÍÓÚÑ][^.!?]*[.!?])/);
		if (primeraOracion && primeraOracion[1].length > 15 && !patronesPeligrosos.some(p => p.test(primeraOracion[1]))) {
			text = primeraOracion[1];
		} else {
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

export function buildUserDataContext(userData?: Record<string, any> | null): string {
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

export function buildGemmaPrompt(opts: {
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
- PROHIBIDO usar frases genéricas como "¡Excelente elección!", "¡Qué bueno que preguntas!", "¡Con gusto!". Sé natural.
- Si no estás seguro de algo, di "déjame verificar" en vez de inventar.
- Tu respuesta empieza directamente con el mensaje al cliente.
	- Usa un tono cálido como si fueras una amiga que trabaja en la tienda.
	- Incluye emojis de forma natural y variada para hacer la conversación más cálida e interactiva (😊💪🎉✨💙🔥👌📋📦🚚✅❄️📺🔧🛒💳).`;

	const ejemplosTexto = opts.ejemplos
		.map((e) => `Cliente: ${e.cliente}\nAsistente: ${e.asistente}`)
		.join('\n\n');

	const historialTexto = opts.historial ? `${opts.historial}\n` : '';

	const user = `${ejemplosTexto}\n\n---\n\n${historialTexto}Cliente: ${opts.mensajeCliente}\nAsistente:`;

	return { system, user };
}

// ─── VALIDADOR DE COBERTURA ───────────────────────────────────────────────────

export const DEPARTAMENTOS_COBERTURA = [
	'nariño', 'narino',
	'cauca',
	'putumayo',
	'huila',
	'valle', 'valle del cauca',
];

export const CIUDADES_COBERTURA: string[] = [
	'pasto', 'tumaco', 'ipiales', 'la union', 'la unión', 'samaniego',
	'túquerres', 'tuquerres', 'barbacoas', 'el charco', 'sandoná', 'sandona',
	'popayán', 'popayan', 'santander de quilichao', 'miranda', 'patía', 'patia',
	'puerto tejada', 'piendamó', 'piendamo', 'el tambo', 'cajibío', 'cajibio',
	'mocoa', 'puerto asís', 'puerto asis', 'orito', 'sibundoy', 'valle del guamuez',
	'san miguel', 'villagarzón', 'villagarzon',
	'neiva', 'pitalito', 'garzón', 'garzon', 'la plata', 'campoalegre',
	'rivera', 'palermo', 'gigante', 'isnos', 'san agustín', 'san agustin',
	'cali', 'buenaventura', 'palmira', 'tuluá', 'tulua', 'buga',
	'cartago', 'jamundí', 'jamundi', 'yumbo', 'florida', 'pradera',
	'zarzal', 'la victoria', 'roldanillo', 'el cerrito',
];

export async function verificarCobertura(lugar: string): Promise<'cobertura' | 'sin_cobertura' | 'desconocido'> {
	if (!lugar) return 'desconocido';
	const l = lugar.toLowerCase().trim();

	if (DEPARTAMENTOS_COBERTURA.some((d) => l.includes(d))) return 'cobertura';
	if (CIUDADES_COBERTURA.some((c) => l.includes(c))) return 'cobertura';

	const fueraCobertura = [
		'bogota', 'bogotá', 'medellin', 'medellín', 'barranquilla', 'cartagena',
		'cucuta', 'cúcuta', 'bucaramanga', 'pereira', 'manizales', 'ibague', 'ibagué',
		'santa marta', 'villavicencio', 'monteria', 'montería', 'sincelejo',
		'valledupar', 'tunja', 'armenia', 'quibdo', 'quibdó', 'riohacha',
		'leticia', 'arauca', 'yopal', 'florencia', 'san andrés', 'san andres',
	];
	if (fueraCobertura.some(c => l.includes(c))) return 'sin_cobertura';

	try {
		return await verificarCoberturaConIA(lugar);
	} catch {
		return 'desconocido';
	}
}

export const COBERTURA_DESCRIPCION = `
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

		setCache(key, result, 600_000);
		return result;
	} catch {
		return 'desconocido';
	}
}

export const AGENT_NAME = 'Sara';

export function getSaludo(): string {
	const hora = new Date().getHours();
	if (hora >= 5 && hora < 12) return 'Buenos días';
	if (hora >= 12 && hora < 19) return 'Buenas tardes';
	return 'Buenas noches';
}

export function resolverOpcion(respuesta: string, opciones: string[]): string {
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

export async function extraerCiudadDelMensaje(mensaje: string): Promise<string | null> {
	const lower = mensaje.toLowerCase();

	const patronesPrefijo = [
		/(?:soy de|estoy en|vivo en|escribo desde|desde|ciudad[:\s]+|ubicado en|me encuentro en)\s+([a-záéíóúñ\s]{3,30})/i,
	];

	for (const patron of patronesPrefijo) {
		const match = mensaje.match(patron);
		if (match) {
			return match[1].trim().toLowerCase();
		}
	}

	const trimmed = lower.trim().replace(/[.,!?]+$/, '');
	if (trimmed.length > 2 && trimmed.length < 30 && !/\s{2,}/.test(trimmed)) {
		const allCities = [...CIUDADES_COBERTURA, ...DEPARTAMENTOS_COBERTURA];
		const exactMatch = allCities.find((c) => trimmed.includes(c) || c.includes(trimmed));
		if (exactMatch) return trimmed;

		const words = trimmed.split(/\s+/);
		if (words.length <= 3 && words.every((w) => /^[a-záéíóúñ]+$/i.test(w))) {
			const algunaCoincide = words.some((w) =>
				w.length > 2 && allCities.some((c) => c.includes(w) || w.includes(c))
			);
			if (algunaCoincide) return trimmed;
		}
	}

	return null;
}
