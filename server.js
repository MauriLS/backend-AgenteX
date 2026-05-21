// backend/server.js
const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Rutas ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth.routes'));
app.use('/api/chat',     require('./routes/chat.routes'));
app.use('/api/agents',   require('./routes/agent.routes'));
app.use('/api/users',    require('./routes/users.routes'));
app.use('/api/sessions', require('./routes/sessions.routes'));
app.use('/api/company',  require('./routes/company.routes'));

// Health check para Render (evita sleep en plan gratuito)
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT} 🚀`);
});