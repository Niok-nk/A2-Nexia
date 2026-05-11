# Chatbot IA + Mini CRM — Proyecto WhatsApp

> Plataforma de atención automatizada vía WhatsApp con IA (Google Gemini), mini CRM modular, gestión de leads por etapas y agentes especializados por flujo de negocio.

## Estructura del Proyecto

```
proyecto/
├── apps/
│   ├── backend/        # Node.js / Express API
│   └── frontend/       # Astro Dashboard CRM
├── docker-compose.yml
└── README.md
```

## Requisitos Previos

- Node.js ≥ 20 LTS
- npm o pnpm
- Docker y Docker Compose (opcional)
- Redis (para BullMQ)
- API Key de Google Gemini
- API de WooCommerce (opcional)

## Instalación Rápida

### 1. Clonar el repositorio

```bash
cd 2026-05-11_chat_ia_whatsaap
```

### 2. Backend

```bash
cd apps/backend
npm install
cp .env.example .env
# Editar .env con tus credenciales
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

El backend se ejecutará en `http://localhost:8000`

### 3. Frontend (Astro)

```bash
cd apps/frontend
npm install
npm run dev
```

El frontend se ejecutará en `http://localhost:4321`

## Variables de Entorno

### Backend (.env)

```env
NODE_ENV=development
PORT=8000
DATABASE_URL="file:./prisma/dev.db"
GEMINI_API_KEY=tu_api_key_aqui
WC_BASE_URL=https://tu-tienda.com
WC_CONSUMER_KEY=ck_xxx
WC_CONSUMER_SECRET=cs_xxx
REDIS_URL=redis://localhost:6379
```

## Endpoints API

### Auth
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/refresh` - Renovar token
- `POST /api/v1/auth/logout` - Cerrar sesión

### CRM
- `GET /api/v1/contacts` - Listar contactos
- `GET /api/v1/contacts/:id` - Detalle contacto
- `POST /api/v1/contacts` - Crear contacto
- `PATCH /api/v1/contacts/:id` - Actualizar contacto
- `GET /api/v1/leads` - Listar leads
- `GET /api/v1/leads/:id` - Detalle lead
- `PATCH /api/v1/leads/:id/stage` - Cambiar etapa
- `POST /api/v1/leads/:id/notes` - Agregar nota

### WhatsApp
- `GET /api/v1/whatsapp/status` - Estado
- `GET /api/v1/whatsapp/qr` - QR para escanear
- `POST /api/v1/whatsapp/send` - Enviar mensaje

### Productos
- `GET /api/v1/products` - Listar
- `GET /api/v1/products/:id` - Detalle
- `GET /api/v1/products/search` - Buscar

## Agentes IA Disponibles

| Agente | Responsabilidad |
|---|---|
| Ventas | Cotizaciones, crédito/contado |
| Cartera | Seguimiento de pagos |
| Servicio Técnico | Diagnóstico y citas |
| Repuestos | Precios y disponibilidad |
| Vacantes | Información de empleo |
| Distribuidores | Registro distribuidores |
| Medios de Pago | Links de pago |

## Docker

```bash
# Desarrollo
docker-compose up

# Producción
docker-compose -f docker-compose.prod.yml up
```

## Roadmap

- [x] Setup base del backend
- [x] Schema de Prisma
- [x] Endpoints CRUD básicos
- [x] Agentes IA con Gemini
- [ ] WhatsApp Web.js integrado
- [ ] Frontend Astro Dashboard
- [ ] JWT RS256 completo
- [ ] Rate limiting y seguridad
- [ ] CI/CD

## Licencia

ISC
