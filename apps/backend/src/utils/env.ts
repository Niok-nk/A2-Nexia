import { config } from 'dotenv';
import { z } from 'zod';
import { existsSync } from 'fs';

config();

const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	PORT: z.string().default('8000'),
	DATABASE_URL: z.string(),
	GEMINI_API_KEY: z.string().optional(),
	WC_BASE_URL: z.string().optional(),
	WC_CONSUMER_KEY: z.string().optional(),
	WC_CONSUMER_SECRET: z.string().optional(),
	REDIS_URL: z.string().optional(),
});

export const validateEnv = () => {
	if (!existsSync('.env')) {
		console.warn('No .env file found. Copy .env.example to .env and configure it.');
	}

	const result = envSchema.safeParse(process.env);

	if (!result.success) {
		console.error(
			{ errors: result.error.errors },
			'Invalid environment variables'
		);
		process.exit(1);
	}

	console.log('Environment variables validated successfully');
	return result.data;
};
