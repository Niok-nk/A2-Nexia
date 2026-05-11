import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

export const getGeminiModel = (systemInstruction?: string) => {
	const model = genAI.getGenerativeModel({
		model: 'gemini-1.5-flash',
		systemInstruction,
	});
	return model;
};

export const generateResponse = async (
	prompt: string,
	context?: string
): Promise<string> => {
	try {
		const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
		const result = await model.generateContent(
			`${context ? context + '\n\n' : ''}${prompt}`
		);
		return result.response.text();
	} catch (error) {
		throw new Error(`Gemini API error: ${error}`);
	}
};
