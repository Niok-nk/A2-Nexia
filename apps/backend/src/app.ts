import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import router from './router/index.js';
import logger from './utils/logger.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';

const app: Express = express();

app.use(helmet({
	crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(
	cors({
		origin: (origin, callback) => {
			// Permitir requests sin origin (mobile apps, Postman, curl)
			if (!origin) return callback(null, true);
			// En desarrollo: aceptar cualquier localhost
			if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
				return callback(null, true);
			}
			// En producción: solo el origen configurado
			const allowed = process.env.FRONTEND_URL || 'http://localhost:4321';
			if (origin === allowed) return callback(null, true);
			callback(new Error(`CORS: ${origin} no permitido`));
		},
		credentials: true,
	})
);
app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger }));

const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 min
	max: 200,
	standardHeaders: true,
	legacyHeaders: false,
	message: { error: 'Demasiadas solicitudes, intenta más tarde' },
});

app.use('/api/v1', limiter, router);

// Error handlers — siempre al final
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
