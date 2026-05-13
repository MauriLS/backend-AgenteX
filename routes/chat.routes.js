// backend/routes/chat.routes.js
const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');

// Importamos a nuestro guardia de seguridad
const verifyToken = require('../middlewares/auth');

// Ruta protegida: Solo pasa si el token es válido
router.post('/message', verifyToken, chatController.processChatMessage);


module.exports = router;