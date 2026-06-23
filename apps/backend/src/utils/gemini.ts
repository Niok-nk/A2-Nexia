import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const MODELS = [
	'gemini-3.1-flash-lite',
	'gemini-2.5-flash-lite',
	'gemma-4-31b-it',
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
		if (ingles / palabras.length > 0.35) {
			return false;
		}
	}

	return true;
}

export const generateMultimodalResponse = async (
	text: string,
	imageBase64: string,
	mimeType: string,
	systemInstruction?: string
): Promise<string> => {
	let lastError: any;
	const parts: any[] = [
		{ text },
		{ inlineData: { mimeType, data: imageBase64 } },
	];

	for (const modelName of MODELS) {
		let currentParts = parts;
		for (let attempt = 1; attempt <= 5; attempt++) {
			try {
				const model = genAI.getGenerativeModel({
					model: modelName,
					systemInstruction,
				}, { timeout: REQUEST_TIMEOUT_MS });
				const result = await model.generateContent({ contents: [{ role: 'user', parts: currentParts }] });
				const text = result.response.text();

				if (esRespuestaSegura(text)) return text;

				currentParts = [
					{ text: `${text}\n\n[SISTEMA - ERROR DE SEGURIDAD]: Tu respuesta anterior contenía razonamiento interno o texto en inglés. RESPONDE ÚNICAMENTE EN ESPAÑOL COLOMBIANO.` },
					{ inlineData: { mimeType, data: imageBase64 } },
				];
			} catch (error: any) {
				const esRateLimit = String(error).includes('429') || String(error).includes('Too Many Requests');
				if (esRateLimit) {
					const delayMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
					console.warn(`[Gemini API] Model (${modelName}) rate-limited on attempt ${attempt}. Retrying in ${delayMs}ms...`);
					await new Promise(r => setTimeout(r, delayMs));
					continue;
				}
				console.warn(`[Gemini API] Model (${modelName}) failed on attempt ${attempt}. Error: ${error}`);
				lastError = error;
				break;
			}
		}
	}

	throw new Error(`Gemini API error (All models failed). Last error: ${lastError}`);
};

/** Compara la imagen del cliente con múltiples imágenes del catálogo para encontrar el producto que coincide. */
export const compareProductImages = async (
	userImageBase64: string,
	userMimeType: string,
	catalogImages: Array<{ index: number; name: string; base64: string; mimeType: string }>,
): Promise<number | null> => {
	const catalogLines = catalogImages.map((img, i) => `${i + 1}. ${img.name}`).join('\n');
	const text = `Aquí hay una foto enviada por un cliente. Y a continuación, fotos de productos de nuestro catálogo numeradas:\n${catalogLines}\n\n¿Cuál producto del catálogo coincide con la foto del cliente? Responde SOLO con el número (1-${catalogImages.length}) o "ninguno".`;

	const parts: any[] = [
		{ text },
		{ inlineData: { mimeType: userMimeType, data: userImageBase64 } },
		...catalogImages.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
	];

	for (const modelName of MODELS) {
		try {
			const model = genAI.getGenerativeModel({ model: modelName }, { timeout: REQUEST_TIMEOUT_MS });
			const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
			const raw = result.response.text().trim();
			const num = parseInt(raw, 10);
			if (num >= 1 && num <= catalogImages.length) return num - 1;
		} catch {
			continue;
		}
	}
	return null;
};

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
		for (let attempt = 1; attempt <= 5; attempt++) {
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
			} catch (error: any) {
				const esRateLimit = String(error).includes('429') || String(error).includes('Too Many Requests');
				if (esRateLimit) {
					const delayMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
					console.warn(`[Gemini API] Model (${modelName}) rate-limited on attempt ${attempt}. Retrying in ${delayMs}ms...`);
					await new Promise(r => setTimeout(r, delayMs));
					continue;
				}
				console.warn(`[Gemini API] Model (${modelName}) failed on attempt ${attempt}. Trying next... Error: ${error}`);
				lastError = error;
				break; // Romper intentos para probar el siguiente modelo
			}
		}
	}

	throw new Error(`Gemini API error (All models failed or leaked reasoning). Last error: ${lastError}`);
};
