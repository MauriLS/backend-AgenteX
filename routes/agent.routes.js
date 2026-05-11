const express = require('express');
const router = express.Router();
const { getMyAgents } = require('../controllers/agent.controller');

// Importa tu middleware de seguridad (ajusta la ruta según tu proyecto)
const { verificarToken } = require('../middlewares/auth.middleware'); 

// Ruta protegida: GET /api/agents/my-agents
router.get('/my-agents', verificarToken, getMyAgents);

module.exports = router;