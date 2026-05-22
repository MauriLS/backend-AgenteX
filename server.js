// backend/server.js
const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const { swaggerUi, swaggerDoc } = require('./swagger');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
    console.log(`Servidor activo en http://localhost:${PORT} 🚀`);
});