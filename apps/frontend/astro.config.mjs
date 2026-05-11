// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

// https://astro.build/config
export default defineConfig({
	vite: {
		envPrefix: 'PUBLIC_',
	},
});
