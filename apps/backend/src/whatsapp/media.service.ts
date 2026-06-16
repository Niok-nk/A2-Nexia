import { downloadContentFromMessage, WAMessage } from '@whiskeysockets/baileys';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

const MEDIA_DIR = path.join(process.cwd(), 'media');

async function ensureMediaDir(): Promise<void> {
	try {
		await fs.mkdir(MEDIA_DIR, { recursive: true });
	} catch { }
}

function getExtension(mimeType: string): string {
	const map: Record<string, string> = {
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/webp': 'webp',
		'audio/ogg': 'ogg',
		'audio/mp4': 'mp4',
		'audio/mpeg': 'mp3',
		'audio/amr': 'amr',
		'video/mp4': 'mp4',
		'video/3gpp': '3gp',
		'application/pdf': 'pdf',
	};
	return map[mimeType] || 'bin';
}

export async function downloadMedia(
	msg: WAMessage
): Promise<{ mediaType: string; mediaMimeType: string; mediaFileName: string } | null> {
	let mediaKey: string | null = null;
	let mediaType = '';
	let mimeType = '';

	if (msg.message?.imageMessage) {
		mediaKey = 'imageMessage';
		mediaType = 'image';
		mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
	} else if (msg.message?.audioMessage) {
		mediaKey = 'audioMessage';
		mediaType = 'audio';
		mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';
	} else if (msg.message?.videoMessage) {
		mediaKey = 'videoMessage';
		mediaType = 'video';
		mimeType = msg.message.videoMessage.mimetype || 'video/mp4';
	} else if (msg.message?.documentMessage) {
		mediaKey = 'documentMessage';
		mediaType = 'document';
		mimeType = msg.message.documentMessage.mimetype || 'application/octet-stream';
	} else if (msg.message?.stickerMessage) {
		mediaKey = 'stickerMessage';
		mediaType = 'image';
		mimeType = msg.message.stickerMessage.mimetype || 'image/webp';
	} else if (msg.message?.ptvMessage) {
		mediaKey = 'ptvMessage';
		mediaType = 'video';
		mimeType = msg.message.ptvMessage.mimetype || 'video/mp4';
	}

	if (!mediaKey) return null;

	await ensureMediaDir();

	const ext = getExtension(mimeType);
	const messageId = msg.key.id || `${Date.now()}`;
	const fileName = `${messageId}.${ext}`;
	const filePath = path.join(MEDIA_DIR, fileName);

	try {
		const downloadType = mediaType as 'image' | 'video' | 'audio' | 'document';
		const stream = await downloadContentFromMessage(
			(msg.message as any)[mediaKey],
			downloadType
		);
		const chunks: Buffer[] = [];
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			chunks.push(chunk);
		}
		const buffer = Buffer.concat(chunks);
		await fs.writeFile(filePath, buffer);
		logger.info({ fileName, mediaType, mimeType, size: buffer.length }, 'Media downloaded');
		return { mediaType, mediaMimeType: mimeType, mediaFileName: fileName };
	} catch (error) {
		logger.error({ error, mediaType, mediaKey, fileName }, 'Failed to download media');
		return null;
	}
}
