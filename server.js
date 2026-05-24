// backend/server.js
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { swaggerUi, swaggerDoc } = require('./swagger');
const logger                    = require('./logger');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────────────────────
// /api/chat — el más costoso (llama a DeepSeek). Límite estricto por IP.
// En producción idealmente limitaríamos por req.user.id pero ese dato
// solo está disponible después del middleware de auth.
// Como alternativa pragmática: límite por IP con ventana de 1 minuto.
const chatLimiter = rateLimit({
    windowMs:         60 * 1000, // 1 minuto
    max:              20,         // 20 mensajes por minuto por IP
    standardHeaders:  true,
    legacyHeaders:    false,
    message:          { error: 'Demasiadas solicitudes. Espera un momento antes de continuar.' },
    skip: (req) => process.env.NODE_ENV === 'development', // Sin límite en local
});

// Rutas generales — más permisivo
const generalLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             100,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Demasiadas solicitudes.' },
    skip: (req) => process.env.NODE_ENV === 'development',
});

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger[level]({
            method:  req.method,
            path:    req.path,
            status:  res.statusCode,
            ms,
            ip:      req.ip,
            user_id: req.user?.id || null,
        }, `${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
});

app.use('/api/chat',    chatLimiter);
app.use('/api',         generalLimiter);

// Documentación API — disponible en /api/docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc, {
    customSiteTitle: 'AgenteX API Docs',
    customCss: '.swagger-ui .topbar { display: none }',
}));

// ── Rutas ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',            require('./routes/auth.routes'));
app.use('/api/chat',            require('./routes/chat.routes'));
app.use('/api/agents',          require('./routes/agent.routes'));
app.use('/api/users',           require('./routes/users.routes'));
app.use('/api/sessions',        require('./routes/sessions.routes'));
app.use('/api/company',         require('./routes/company.routes'));
app.use('/api/admin/companies', require('./routes/admin.routes'));

// Health check para Render (evita sleep en plan gratuito)
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, `Servidor activo en http://localhost:${PORT}`);
});