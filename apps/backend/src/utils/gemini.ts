import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const MODELS = [
	'gemma-4-31b-it',
	'gemini-3.1-flash-lite',
];

const PATRONES_BLOQUEO = [
	/(?:wait|let me|double check|revised|final polish)/i,
	/(?:the system prompt|the assistant|i must|i should)/i,
	/(?:chain of thought|reasoning|let's refine)/i,
	/(?:as an ai|as a language model|my instructions)/i,
	/\b(?:Yes|No)\.\s*(?:Colombian|Warm|Clear|Direct|asterisks)/i,
	/(?:applying that here|the rule says)/i,
	/\b(?:i can|i will|let's|should we|we should|i'll)\b/i,
	/Max\s+\d+\s+(?:lines|words|palabras?)/i,
	/asterisks?/i,
	/Colombian\s+Spanish/i,
	/\bconstent\b/i,
	/free\s+shipping/i,
	/Note:|Note:/i,
];

const PALABRAS_INGLES_COMUNES = new Set([
	'the', 'and', 'with', 'have', 'must', 'should', 'this', 'that', 'they', 'what', 'would', 'there',
	'their', 'about', 'which', 'will', 'your', 'from', 'been', 'were', 'could', 'some', 'them', 'into',
	'than', 'then', 'only', 'other', 'most', 'such', 'very', 'down', 'over', 'after', 'also', 'even',
	'here', 'how', 'why', 'just', 'like', 'more', 'now', 'way', 'does', 'did', 'has', 'had',
	'max', 'lines', 'shipping', 'best', 'better', 'good', 'please',
]);

function esRespuestaSegura(texto: string): boolean {
	if (!texto) return true;

	// 1. Patrones explícitos
	for (const patron of PATRONES_BLOQUEO) {
		if (patron.test(texto)) {
			return false;
		}
	}

	// 2. Porcentaje de inglés (compara palabras comunes de inglés)
	const palabras = texto.toLowerCase().replace(/[.,!?¡¿()\-"]/g, '').split(/\s+/).filter(Boolean);
	if (palabras.length > 0) {
		const ingles = palabras.filter(p => PALABRAS_INGLES_COMUNES.has(p)).length;
		if (ingles / palabras.length > 0.15) {
			return false;
		}
	}

	return true;
}

const REQUEST_TIMEOUT_MS = 60_000;

export const getGeminiModel = (systemInstruction?: string) => {
	const model = genAI.getGenerativeModel({
		model: MODELS[0],
		systemInstruction,
	}, { timeout: REQUEST_TIMEOUT_MS });
	return model;
};

export const generateResponse = async (
	prompt: string,
	systemInstruction?: string
): Promise<string> => {
	let lastError: any;

	for (const modelName of MODELS) {
		let currentPrompt = prompt;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
			const model = genAI.getGenerativeModel({
				model: modelName,
				systemInstruction: systemInstruction,
			}, { timeout: REQUEST_TIMEOUT_MS });
				const result = await model.generateContent(currentPrompt);
				const text = result.response.text();

				if (esRespuestaSegura(text)) {
					return text;
				}

				console.warn(`[Gemini API] Model (${modelName}) leaked reasoning or English on attempt ${attempt}. Retrying...`);
				currentPrompt = `${prompt}\n\n[SISTEMA - ERROR DE SEGURIDAD]: Tu respuesta anterior contenía razonamiento interno o texto en inglés. RESPONDE ÚNICAMENTE EN ESPAÑOL COLOMBIANO. PROHIBIDO escribir en inglés, prohibido mostrar tu razonamiento, análisis o notas de constraints. Escribe solo el mensaje final para el cliente.`;
			} catch (error) {
				console.warn(`[Gemini API] Model (${modelName}) failed on attempt ${attempt}. Trying next... Error: ${error}`);
				lastError = error;
				break; // Romper intentos para probar el siguiente modelo
			}
		}
	}

	throw new Error(`Gemini API error (All models failed or leaked reasoning). Last error: ${lastError}`);
};
