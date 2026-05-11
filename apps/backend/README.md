# Backend - Chatbot IA + Mini CRM

Backend API para el sistema de atención automatizada vía WhatsApp con IA.

## Estructura del Proyecto

```
src/
├── agents/           # Agentes IA especializados
├── crm/              # Módulos CRM (contacts, leads)
├── whatsapp/         # WhatsApp Web.js wrapper
├── woocommerce/      # Cliente WooCommerce API
├── auth/             # Autenticación JWT
├── router/           # Rutas API
├── middleware/       # Middleware (auth, rate limit, etc)
├── db/               # Prisma client
└── utils/            # Utilidades (logger, gemini, etc)
```

## Instalación

```bash
npm install
```

## Variables de Entorno

Copiar `.env.example` a `.env` y configurar:

```env
DATABASE_URL="file:./prisma/dev.db"
GEMINI_API_KEY=tu_api_key
PORT=8000
```

## Desarrollo

```bash
# Instalar dependencias
npm install

# Generar Prisma client
npm run prisma:generate

# Iniciar base de datos
npm run prisma:migrate

# Modo desarrollo (con hot-reload)
npm run dev

# Build de producción
npm run build

# Iniciar en producción
npm start
```

## Endpoints API

### Auth
- `POST /api/v1/auth/login` - Login usuario
- `POST /api/v1/auth/refresh` - Renovar token
- `POST /api/v1/auth/logout` - Cerrar sesión

### CRM - Contactos
- `GET /api/v1/contacts` - Listar contactos
- `GET /api/v1/contacts/:id` - Detalle contacto
- `POST /api/v1/contacts` - Crear contacto
- `PATCH /api/v1/contacts/:id` - Actualizar contacto

### CRM - Leads
- `GET /api/v1/leads` - Listar leads
- `GET /api/v1/leads/:id` - Detalle lead
- `PATCH /api/v1/leads/:id/stage` - Cambiar etapa
- `POST /api/v1/leads/:id/notes` - Agregar nota

### WhatsApp
- `GET /api/v1/whatsapp/status` - Estado de sesión
- `GET /api/v1/whatsapp/qr` - Obtener QR
- `POST /api/v1/whatsapp/send` - Enviar mensaje

### Productos (WooCommerce)
- `GET /api/v1/products` - Listar productos
- `GET /api/v1/products/:id` - Detalle producto
- `GET /api/v1/products/search` - Buscar productos

## Agentes IA

El sistema cuenta con agentes especializados:

- **Ventas**: Cotizaciones, crédito/contado, cierre de ventas
- **Cartera**: Seguimiento de pagos
- **Servicio Técnico**: Diagnóstico y agendamiento
- **Repuestos**: Consulta de precios y disponibilidad
- **Vacantes**: Información de empleo
- **Distribuidores**: Registro de distribuidores
- **Medios de Pago**: Links y métodos de pago

## Base de Datos

El proyecto usa Prisma con SQLite (desarrollo) o MySQL (producción).

### Modelo de Datos

- **Contact**: Contactos de WhatsApp
- **Lead**: Oportunidades de venta por etapa
- **Message**: Historial de mensajes
- **Note**: Notas internas de leads

## Licencia

ISC
