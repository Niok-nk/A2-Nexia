# Chatbot IA + Mini CRM — Proyecto WhatsApp

> Plataforma de atención automatizada vía WhatsApp con IA (Google Gemini), mini CRM modular, gestión de leads por etapas y agentes especializados por flujo de negocio.

---

## Arquitectura General

```
Cliente WhatsApp
      │
      ▼
┌─────────────────────┐
│  whatsapp-web.js    │  ← Conexión por QR (sesión persistente)
│  (WA Bridge)        │
└────────┬────────────┘
         │ Eventos / Mensajes entrantes
         ▼
┌─────────────────────┐
│   Agent Orchestrator│  ← Identifica tipo de cliente y etapa del lead
│   (TypeScript)      │      Enruta al agente especializado correcto
└────────┬────────────┘
         │
    ┌────┴──────────────────────────────────┐
    │              Agentes IA               │
    │  (Google Gemini API — por contexto)   │
    │                                       │
    │  · Agente Ventas (Contado / Crédito)  │
    │  · Agente Cartera                     │
    │  · Agente Servicio Técnico            │
    │  · Agente Repuestos                   │
    │  · Agente Vacantes                    │
    │  · Agente Distribuidores              │
    │  · Agente Medios de Pago              │
    └────────────────┬──────────────────────┘
                     │
         ┌───────────▼──────────┐
         │     Backend API      │  :8000 — Node.js / Express / TypeScript
         │   (REST + WebSocket) │
         └──────┬───────────────┘
                │
     ┌──────────▼──────────┐
     │    Router (Strict)   │  Valida JWT (RS256) · RBAC · Rate limiting
     └──────┬──────────────┘
            │
     ┌──────▼──────────┐
     │  Auth / Decoder  │  :8001 — Decodifica y valida tokens
     └──────┬───────────┘
            │
     ┌──────▼──────────┐
     │   Mini CRM DB   │  SQLite (local) · MySQL (producción)
     └─────────────────┘
            │
     ┌──────▼──────────┐
     │  WooCommerce API│  Catálogo de productos en tiempo real
     └─────────────────┘
            │
     ┌──────▼──────────┐
     │  Frontend Astro  │  Dashboard CRM · Historial · Gestión de leads
     └─────────────────┘
```

---

## Stack Tecnológico

### Backend
| Capa | Tecnología | Versión |
|---|---|---|
| Runtime | Node.js | ≥ 20 LTS |
| Lenguaje | TypeScript | ^5.x |
| Framework HTTP | Express | ^4.x |
| WA Bridge | whatsapp-web.js | ^1.x |
| IA / LLM | Google Gemini API (`@google/generative-ai`) | latest |
| ORM | Prisma | ^5.x |
| DB local | SQLite (via Prisma) | — |
| DB producción | MySQL 8 | — |
| Auth | JWT RS256 (`jsonwebtoken`) | — |
| Validación | Zod | ^3.x |
| Queue / Jobs | BullMQ + Redis | — |
| Logging | Pino | ^8.x |
| Tests | Vitest | ^1.x |

### Frontend
| Capa | Tecnología | Versión |
|---|---|---|
| Framework | Astro | ^4.x |
| Lenguaje | TypeScript | ^5.x |
| UI Components | React (islands) | ^18.x |
| Estilos | Tailwind CSS | ^3.x |
| Estado / Reactivo | Nano Stores + Observer pattern | — |
| Gráficas | Chart.js | — |
| HTTP Client | Ky | — |
| Tests | Playwright (E2E) | — |

### Infraestructura
| Elemento | Herramienta |
|---|---|
| Contenedores | Docker + Docker Compose |
| Proxy reverso | Nginx |
| Secrets | `.env` + Doppler (opcional) |
| CI/CD | GitHub Actions |
| PM2 (producción) | Gestor de procesos Node |

---

## Estructura de Carpetas

```
proyecto/
├── apps/
│   ├── backend/                  # Node.js / Express API
│   │   ├── src/
│   │   │   ├── agents/           # Agentes especializados por módulo
│   │   │   │   ├── orchestrator.ts
│   │   │   │   ├── ventas.agent.ts
│   │   │   │   ├── cartera.agent.ts
│   │   │   │   ├── tecnico.agent.ts
│   │   │   │   ├── repuestos.agent.ts
│   │   │   │   ├── vacantes.agent.ts
│   │   │   │   ├── distribuidores.agent.ts
│   │   │   │   └── pagos.agent.ts
│   │   │   ├── crm/              # Mini CRM: contactos, etapas, notas
│   │   │   │   ├── contacts/
│   │   │   │   ├── leads/
│   │   │   │   └── pipeline/
│   │   │   ├── whatsapp/         # whatsapp-web.js wrapper + eventos
│   │   │   ├── woocommerce/      # Cliente REST WooCommerce
│   │   │   ├── auth/             # JWT RS256, middleware RBAC
│   │   │   ├── router/           # Express Router por módulo
│   │   │   ├── middleware/       # Rate limit, error handler, logger
│   │   │   ├── db/               # Prisma client + migraciones
│   │   │   └── utils/
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   ├── .env.example
│   │   └── tsconfig.json
│   │
│   └── frontend/                 # Astro dashboard CRM
│       ├── src/
│       │   ├── pages/
│       │   ├── components/
│       │   ├── layouts/
│       │   ├── stores/           # Nano Stores (observer pattern)
│       │   └── lib/
│       └── astro.config.mjs
│
├── docker-compose.yml
├── docker-compose.prod.yml
└── README.md
```

---

## Modelo de Datos (Mini CRM)

### Entidades principales

```prisma
// prisma/schema.prisma

model Contact {
  id          String    @id @default(cuid())
  phone       String    @unique       // Número WA normalizado
  name        String?
  email       String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  leads       Lead[]
  messages    Message[]
}

model Lead {
  id          String     @id @default(cuid())
  contactId   String
  contact     Contact    @relation(fields: [contactId], references: [id])
  stage       LeadStage  @default(INITIAL)   // Etapa actual del pipeline
  type        LeadType                        // Crédito | Contado | Consulta
  module      CRMModule                       // Módulo asignado
  assignedTo  String?                         // ID agente/usuario CRM
  notes       Note[]
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model Message {
  id          String   @id @default(cuid())
  contactId   String
  contact     Contact  @relation(fields: [contactId], references: [id])
  direction   Direction // INBOUND | OUTBOUND
  body        String
  sentAt      DateTime @default(now())
  agentType   String?  // qué agente respondió
}

model Note {
  id        String   @id @default(cuid())
  leadId    String
  lead      Lead     @relation(fields: [leadId], references: [id])
  body      String
  createdAt DateTime @default(now())
}

// ─── Enums ───────────────────────────────────────────────

enum LeadStage {
  INITIAL          // Contacto nuevo, sin clasificar
  QUALIFIED        // Interés confirmado
  PROPOSAL         // Cotización enviada
  NEGOTIATION      // En negociación
  WON              // Venta cerrada
  LOST             // Descartado
  ON_HOLD          // En espera
}

enum LeadType {
  CREDITO
  CONTADO
  CONSULTA
}

enum CRMModule {
  VENTAS
  CARTERA
  SERVICIO_TECNICO
  REPUESTOS
  VACANTES
  DISTRIBUIDORES
  MEDIOS_DE_PAGO
}

enum Direction {
  INBOUND
  OUTBOUND
}
```

---

## Sistema de Agentes IA

### Orquestador — Lógica de enrutamiento

El `Orchestrator` recibe cada mensaje entrante y decide qué agente debe responder.

```
Mensaje entrante
      │
      ▼
¿Es contacto nuevo?
  ├── SÍ → Clasificación inicial (intención del mensaje)
  └── NO → Continuar con el lead/etapa existente
      │
      ▼
¿Quiere cotizar un producto?
  ├── SÍ → ¿Contado o Crédito? → Agente Ventas
  └── NO → Clasificar subcategoría:
            · Cartera         → Agente Cartera
            · Servicio Técnico → Agente Técnico
            · Repuestos       → Agente Repuestos
            · Vacantes        → Agente Vacantes
            · Distribuidores  → Agente Distribuidores
            · Medios de pago  → Agente Pagos
```

### Responsabilidades de cada agente

| Agente | Responsabilidad | Acciones CRM |
|---|---|---|
| **Ventas (Contado)** | Cotización directa, cierre rápido | Mueve lead → `PROPOSAL` → `WON` |
| **Ventas (Crédito)** | Calificación crediticia, documentación | Mueve lead → `QUALIFIED` → `NEGOTIATION` |
| **Cartera** | Seguimiento de pagos, recordatorios | Crea nota y envia la informacion a whatsapp correspondiente, etiqueta `CARTERA` |
| **Servicio Técnico** | Diagnóstico, agendamiento de visita | Crea ticket y envia la informacion a whatsapp correspondiente, nota con síntomas |
| **Repuestos** | y envia la informacion a whatsapp correspondiente , envia precio |
| **Vacantes** | Información de cargos disponibles | Registra interesado y envia la informacion a whatsapp correspondiente, solicita CV |
| **Distribuidores** | Relleno de formulario y envia la informacion a whatsapp correspondiente | Cualifica distribuidor potencial |
| **Medios de Pago** | Envío de link de pago, instrucciones | Registra intención de pago |

### Cambio de etapas

Cada agente tiene permisos explícitos para transicionar etapas del lead. Solo el orquestador puede reasignar módulo.

---

## Flujo de Consulta de Productos (Ventas)

```
1. El asistente saluda e identifica el producto o categoría de interés
        │
        ▼
2. ¿Desea comprar al contado o a crédito?
        │
   ┌────┴────────────┐
   │                 │
CONTADO           CRÉDITO
   │                 │
   ▼                 ▼
Agente Ventas    Agente Ventas
(Contado)        (Crédito)
   │                 │
   ▼                 ▼
Consulta          Solicita datos:
WooCommerce API   · Nombre completo
(precio, stock)   · Cédula
   │              · Ingresos mensuales
   ▼                 │
Cotización        Evalúa perfil
enviada           crediticio
   │                 │
   ▼                 ▼
Lead → PROPOSAL  Lead → NEGOTIATION
```

---

## API REST — Endpoints principales

### Base URL: `http://localhost:8000/api/v1`

#### CRM — Contactos y Leads
```
GET    /contacts                  → Listar contactos
GET    /contacts/:id              → Detalle + historial de mensajes
POST   /contacts                  → Crear contacto manual
PATCH  /contacts/:id              → Actualizar datos

GET    /leads                     → Listar leads (con filtros por etapa/módulo)
GET    /leads/:id                 → Detalle del lead + notas
PATCH  /leads/:id/stage           → Cambiar etapa manualmente
POST   /leads/:id/notes           → Agregar nota interna
```

#### WhatsApp
```
GET    /whatsapp/status           → Estado de sesión QR
POST   /whatsapp/send             → Enviar mensaje manual
GET    /whatsapp/qr               → Obtener QR actual (base64)
```

#### Productos (WooCommerce)
```
GET    /products                  → Listar productos disponibles
GET    /products/:id              → Detalle de producto
GET    /products/search?q=...     → Búsqueda de productos
```

#### Auth
```
POST   /auth/login                → Login usuario CRM → JWT
POST   /auth/refresh              → Renovar token
POST   /auth/logout               → Revocar sesión
```

---

## ⚙️ Variables de Entorno

```env
# .env.example

# App
NODE_ENV=development
PORT=8000
AUTH_PORT=8001

# Database
DATABASE_URL="file:./dev.db"          # SQLite local
# DATABASE_URL="mysql://user:pass@host:3306/db"  # MySQL producción

# JWT (RS256 — generar par de claves)
JWT_PRIVATE_KEY_PATH=./keys/private.pem
JWT_PUBLIC_KEY_PATH=./keys/public.pem
JWT_EXPIRES_IN=8h

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key

# WhatsApp
WA_SESSION_PATH=./wa_session
WA_PUPPETEER_HEADLESS=true

# WooCommerce
WC_BASE_URL=https://tu-tienda.com
WC_CONSUMER_KEY=ck_xxx
WC_CONSUMER_SECRET=cs_xxx

# Redis (para BullMQ)
REDIS_URL=redis://localhost:6379
```

---

## Docker Compose (desarrollo)

```yaml
# docker-compose.yml
version: "3.9"

services:
  backend:
    build: ./apps/backend
    ports:
      - "8000:8000"
      - "8001:8001"
    volumes:
      - ./apps/backend:/app
      - wa_session:/app/wa_session
    env_file: ./apps/backend/.env
    depends_on:
      - redis

  frontend:
    build: ./apps/frontend
    ports:
      - "4321:4321"
    volumes:
      - ./apps/frontend:/app

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  # Solo en producción: reemplazar SQLite por MySQL
  # mysql:
  #   image: mysql:8
  #   environment:
  #     MYSQL_ROOT_PASSWORD: secret
  #     MYSQL_DATABASE: crm

volumes:
  wa_session:
```

---

## Seguridad

- **JWT RS256** — par de claves asimétricas; el frontend solo conoce la clave pública.
- **RBAC** — roles: `admin`, `agent`, `viewer`. Cada rol tiene permisos explícitos por endpoint.
- **Rate limiting** — `express-rate-limit` por IP y por usuario autenticado.
- **Validación de entrada** — Zod en cada endpoint; rechazo con `400` antes de llegar al controlador.
- **Sanitización WA** — todo mensaje entrante se sanitiza antes de enviarlo al modelo Gemini.
- **Secrets en producción** — no se commitean; usar variables de entorno del servidor o Doppler.

---

## Roadmap de Implementación

| Fase | Hito | Entregable |
|---|---|---|
| **1** | Setup base | Monorepo, Docker, BD con Prisma, Auth JWT |
| **2** | WA Bridge | whatsapp-web.js + sesión QR persistente |
| **3** | Orquestador básico | Clasificación de intención con Gemini |
| **4** | Agente Ventas | Flujo Contado + Crédito + integración WooCommerce |
| **5** | Mini CRM | CRUD completo de contactos, leads, etapas |
| **6** | Agentes secundarios | Cartera, Técnico, Repuestos, Vacantes, Distribuidores, Pagos |
| **7** | Frontend Astro | Dashboard CRM, pipeline visual, historial |
| **8** | Producción | MySQL, Nginx, PM2, CI/CD, monitoreo |

---

## Dependencias clave (backend)

```json
{
  "dependencies": {
    "express": "^4.19.2",
    "whatsapp-web.js": "^1.23.0",
    "@google/generative-ai": "^0.15.0",
    "@prisma/client": "^5.16.0",
    "bullmq": "^5.12.0",
    "ioredis": "^5.4.1",
    "jsonwebtoken": "^9.0.2",
    "zod": "^3.23.8",
    "pino": "^9.3.1",
    "pino-http": "^10.2.0",
    "express-rate-limit": "^7.3.1",
    "qrcode": "^1.5.4",
    "axios": "^1.7.2"
  },
  "devDependencies": {
    "typescript": "^5.5.3",
    "ts-node-dev": "^2.0.0",
    "prisma": "^5.16.0",
    "vitest": "^1.6.0",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^20.14.10"
  }
}

```

---

## Notas de implementación

- **whatsapp-web.js** requiere Puppeteer con Chromium; en producción usar imagen Docker con Chromium preinstalado.
- **Gemini API**: usar `gemini-1.5-flash` para respuestas rápidas; `gemini-1.5-pro` para análisis de crédito más complejos.
- **SQLite → MySQL**: Prisma maneja la migración con solo cambiar `DATABASE_URL`; revisar tipos de columna (`String` → `Text` para campos largos).
- **Observer pattern en frontend**: cada módulo del CRM expone un `store` con Nano Stores; los componentes Astro/React se suscriben sin polling.
- **Sesión WA persistente**: guardar `wa_session/` en volumen Docker para no re-escanear QR en cada reinicio.
- **WooCommerce**: usar autenticación por query params (`consumer_key` + `consumer_secret`) para REST API v3.