// backend/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

// Definimos los endpoints y los conectamos con su función correspondiente
router.post('/register', authController.register);
router.post('/login', authController.login);

module.exports = router;