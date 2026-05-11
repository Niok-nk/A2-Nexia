# Configuración de Variables de Entorno

## ✅ Archivos Creados

### Backend (apps/backend/)

| Archivo | Descripción |
|---|---|
| `.env` | Variables locales (no se commitea) |
| `.env.example` | Plantilla para copiar |
| `.env.local` | Backup local (opcional) |
| `ENV_SETUP.md` | Guía detallada de configuración |

### Frontend (apps/frontend/)

| Archivo | Descripción |
|---|---|
| `.env` | Variables locales |
| `.env.example` | Plantilla |

## 📋 Variables Requeridas

### Desarrollo (Mínimo)

```env
# Backend .env
NODE_ENV=development
PORT=8000
DATABASE_URL="file:./prisma/dev.db"
GEMINI_API_KEY=tu_clave_aqui
```

### Producción (Recomendado)

```env
# Backend .env
NODE_ENV=production
PORT=8000
DATABASE_URL="mysql://user:pass@host:3306/db"
GEMINI_API_KEY=tu_clave
WC_BASE_URL=https://tienda.com
WC_CONSUMER_KEY=ck_xxx
WC_CONSUMER_SECRET=cs_xxx
REDIS_URL=redis://localhost:6379
JWT_PRIVATE_KEY_PATH=./keys/private.pem
JWT_PUBLIC_KEY_PATH=./keys/public.pem
```

## 🔑 Obtener API Keys

### Google Gemini (Requerido)

1. Ve a https://makersuite.google.com/app/apikey
2. Inicia sesión con Google
3. Click "Create API Key"
4. Copia la clave
5. Pega en `GEMINI_API_KEY=` en `.env`

### WooCommerce (Opcional)

1. WordPress > WooCommerce > Ajustes > API
2. Click "Add key"
3. Permisos: **Lectura**
4. Copia Consumer Key y Secret
5. Pega en `.env`

## 🚀 Comandos de Verificación

```bash
# Backend
cd apps/backend
npm run dev

# Frontend
cd apps/frontend
npm run dev
```

## ✅ Checklist

- [ ] Copiar `.env.example` a `.env`
- [ ] Obtener API Key de Google Gemini
- [ ] Configurar `GEMINI_API_KEY` en `.env`
- [ ] (Opcional) Configurar WooCommerce
- [ ] (Opcional) Configurar Redis
- [ ] Ejecutar `npm run dev` en backend
- [ ] Verificar que no haya errores

## 🔒 Seguridad

- ✅ `.env` está en `.gitignore`
- ✅ Variables sensibles no se commitean
- ✅ Usar Doppler o similar en producción
- ✅ Rotar keys periódicamente

## 📖 Documentación Adicional

- `ENV_SETUP.md` - Guía completa de configuración
- `README.md` - Documentación del proyecto
- `objetivo.md` - Especificaciones del proyecto
