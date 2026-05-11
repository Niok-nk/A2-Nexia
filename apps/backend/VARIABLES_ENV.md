# ✅ Variables de Entorno Configuradas

## Archivos Creados

### Backend (`apps/backend/`)

```
.env              # Variables de entorno (NO COMMITEAR)
.env.example      # Plantilla de ejemplo
.env.local        # Backup local (opcional)
CONFIG.md         # Guía rápida de configuración
ENV_SETUP.md      # Guía detallada de setup
setup.ps1         # Script de setup automático
```

## Variables Principales

### Requeridas (Desarrollo)

| Variable | Valor Ejemplo | Descripción |
|---|---|---|
| `NODE_ENV` | `development` | Entorno |
| `PORT` | `8000` | Puerto del servidor |
| `DATABASE_URL` | `file:./prisma/dev.db` | SQLite local |
| `GEMINI_API_KEY` | `AIza...` | **Requerido** - Google Gemini |

### Opcionales

| Variable | Descripción |
|---|---|
| `WC_BASE_URL` | URL de tu WooCommerce |
| `WC_CONSUMER_KEY` | Consumer Key de WooCommerce |
| `WC_CONSUMER_SECRET` | Consumer Secret de WooCommerce |
| `REDIS_URL` | Redis para BullMQ |
| `JWT_PRIVATE_KEY_PATH` | Ruta clave privada JWT |
| `JWT_PUBLIC_KEY_PATH` | Ruta clave pública JWT |

## 🔑 Pasos Rápidos

### 1. Obtener Gemini API Key

```bash
# 1. Ve a https://makersuite.google.com/app/apikey
# 2. Crea una API Key
# 3. Copia la clave
```

### 2. Configurar .env

```bash
cd apps/backend
# Edita .env y pega tu GEMINI_API_KEY
```

### 3. Iniciar

```bash
npm run dev
```

## 📝 Comandos Útiles

```bash
# Setup automático (Windows PowerShell)
.\setup.ps1

# Instalación manual
npm install
npx prisma generate
npx prisma migrate dev

# Desarrollo
npm run dev

# Producción
npm run build
npm start
```

## 📖 Verificación

Después de configurar:

```bash
npm run dev
```

Debe mostrar:
```
✅ Environment variables validated successfully
📝 Server running on port 8000
📱 WhatsApp is ready!
```

## ⚠️ Errores Comunes

### "GEMINI_API_KEY is required"
- Revisa que `GEMINI_API_KEY` esté en `.env`
- Verifica que la clave sea válida

### "Cannot find module '.env'"
- Copia `.env.example` a `.env`
- Ejecuta `setup.ps1`

### "Database error"
```bash
npx prisma generate
npx prisma migrate dev
```

## 🔒 Seguridad

- ✅ `.env` está en `.gitignore`
- ✅ Nunca commitear claves API
- ✅ Usar variables de entorno en producción
- ✅ Rotar keys periódicamente

## 📚 Más Información

- `CONFIG.md` - Guía completa
- `ENV_SETUP.md` - Setup detallado
- `README.md` - Documentación general
- `objetivo.md` - Especificaciones del proyecto
