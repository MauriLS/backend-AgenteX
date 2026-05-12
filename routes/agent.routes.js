const express = require('express');
const router = express.Router();
const { getMyAgents } = require('../controllers/agent.controller');

// Importa tu middleware de seguridad (ajusta la ruta según tu proyecto)
const verifyToken = require('../middlewares/auth');
console.log("Tipo de verifyToken:", typeof verifyToken);
console.log("Tipo de getMyAgents:", typeof getMyAgents);
// Ruta protegida: GET /api/agents/my-agents
router.get('/my-agents', verifyToken, getMyAgents);

module.exports = router;