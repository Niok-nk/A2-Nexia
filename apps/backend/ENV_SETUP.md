# Variables de Entorno - Backend

## .env (archivo local)

```env
# App
NODE_ENV=development
PORT=8000
AUTH_PORT=8001
LOG_LEVEL=info

# Database
DATABASE_URL="file:./prisma/dev.db"

# Google Gemini
# 1. Ve a https://makersuite.google.com/app/apikey
# 2. Inicia sesión con tu cuenta de Google
# 3. Crea una nueva API key
# 4. Copia y pega aquí
GEMINI_API_KEY=

# WooCommerce (opcional)
# 1. Ve a tu WordPress > WooCommerce > Ajustes > API
# 2. Crea un nuevo consumidor
# 3. Copia las credenciales
WC_BASE_URL=https://tu-tienda.com
WC_CONSUMER_KEY=ck_xxx
WC_CONSUMER_SECRET=cs_xxx

# Redis (opcional para desarrollo básico)
REDIS_URL=redis://localhost:6379
```

## Pasos para configurar

### 1. Google Gemini API Key

1. Ve a [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Inicia sesión con tu cuenta de Google
3. Haz clic en "Create API Key"
4. Selecciona "Create API key in new project"
5. Copia la clave generada
6. Pégala en `GEMINI_API_KEY=` en tu `.env`

### 2. WooCommerce (Opcional)

Si tienes una tienda WooCommerce:

1. Ve a tu WordPress Admin
2. Navega a **WooCommerce > Ajustes > API**
3. Haz clic en **"Add key"**
4. Describe la clave (ej: "Chatbot CRM")
5. Selecciona permisos de **Lectura**
6. Copia **Consumer Key** y **Consumer Secret**
7. Pégalos en tu `.env`

### 3. Redis (Opcional)

Para colas de mensajes (BullMQ):

**Windows:**
```bash
# Usando Docker
docker run -d -p 6379:6379 redis:7-alpine
```

**O usa Redis Cloud:**
1. Ve a [Redis Cloud](https://redis.com/try-free/)
2. Crea una cuenta gratuita
3. Crea una base de datos Redis
4. Copia la URL de conexión
5. Actualiza `REDIS_URL` en tu `.env`

## Verificación

Después de configurar las variables:

```bash
cd apps/backend
npm run dev
```

Deberías ver:
- ✅ `Server running on port 8000`
- ✅ `WhatsApp is ready!` (después de escanear QR)

## Solución de Problemas

### Error: "GEMINI_API_KEY is required"
- Asegúrate de que `GEMINI_API_KEY` esté configurada en `.env`
- Verifica que la clave sea válida en https://makersuite.google.com/app/apikey

### Error: "Cannot connect to Redis"
- Redis no es crítico para desarrollo básico
- Puedes omitir la configuración de Redis inicialmente
- El sistema funcionará sin colas de mensajes

### Error: "Database error"
- Ejecuta: `npm run prisma:generate`
- Luego: `npm run prisma:migrate`

## Producción

Para producción, usa variables de entorno del servidor o un servicio como:

- **Doppler** (recomendado)
- **AWS Secrets Manager**
- **Azure Key Vault**
- **Google Secret Manager**

Nunca hagas commit del archivo `.env` al repositorio.
