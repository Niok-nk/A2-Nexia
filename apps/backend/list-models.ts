import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function run() {
	try {
        // Since getModels might not exist in this version of the SDK, let's use the REST API manually if needed.
        // Wait, SDK does not have getModels(). Let's use fetch.
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await res.json();
        const models = data.models.map((m: any) => m.name).filter((name: string) => name.includes('gemma'));
        console.log("AVAILABLE GEMMA MODELS:", models);
	} catch (e) {
		console.error(e);
	}
}
run();
