// backend/server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// ENRUTADOR PRINCIPAL (API Gateway)
// ==========================================

// Todo el tráfico de autenticación va a auth.routes
app.use('/api/auth', require('./routes/auth.routes'));

// Todo el tráfico del Agente IA va a chat.routes
app.use('/api/chat', require('./routes/chat.routes'));

app.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT} 🚀`);
});