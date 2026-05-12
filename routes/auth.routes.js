const express = require('express');
const router = express.Router();

// 1. IMPORTACIÓN CORREGIDA (Sin llaves, porque exportas directo)
const verifyToken = require('../middlewares/auth'); 

const { registerB2B, login } = require('../controllers/auth.controller');

// 3. LAS RUTAS
router.post('/login', login);
// OJO: Cambiaste la ruta de /register a /auth. Lo dejaremos así, pero recuérdalo para el Frontend.
router.post('/register', verifyToken, registerB2B);

module.exports = router;