import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const MODELS = [
	'gemma-4-31b-it',
	//'gemma-4-26b-a4b-it',
	//'gemini-2.5-flash',

];

export const getGeminiModel = (systemInstruction?: string) => {
	const model = genAI.getGenerativeModel({
		model: MODELS[0],
		systemInstruction,
	});
	return model;
};

export const generateResponse = async (
	prompt: string,
	systemInstruction?: string
): Promise<string> => {
	let lastError: any;

	for (const modelName of MODELS) {
		try {
			const model = genAI.getGenerativeModel({
				model: modelName,
				systemInstruction: systemInstruction,
			});
			const result = await model.generateContent(prompt);
			return result.response.text();
		} catch (error) {
			console.warn(`[Gemini API] Model (${modelName}) failed. Trying next model... Error: ${error}`);
			lastError = error;
		}
	}

	throw new Error(`Gemini API error (All models failed). Last error: ${lastError}`);
};
