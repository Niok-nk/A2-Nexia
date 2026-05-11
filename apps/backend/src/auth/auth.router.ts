import { Router, Request, Response } from 'express';
import { z } from 'zod';

const router = Router();

const loginSchema = z.object({
	username: z.string().min(3),
	password: z.string().min(6),
});

router.post('/login', (_req: Request, res: Response) => {
	const result = loginSchema.safeParse(_req.body);
	if (!result.success) {
		return res.status(400).json({ error: 'Invalid credentials' });
	}

	res.json({ message: 'Login endpoint - TODO: implement JWT' });
	return;
});

router.post('/refresh', (_req: Request, res: Response) => {
	res.json({ message: 'Refresh token endpoint - TODO' });
	return;
});

router.post('/logout', (_req: Request, res: Response) => {
	res.json({ message: 'Logout endpoint - TODO' });
	return;
});

export { router as authRouter };
