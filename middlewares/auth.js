// backend/middlewares/auth.js
const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token      = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Acceso denegado. Se requiere un token B2B.' });
    }

    if (!process.env.JWT_SECRET) {
        console.error('🚨 FATAL: JWT_SECRET no está definido en las variables de entorno.');
        return res.status(500).json({ error: 'Error de configuración del servidor.' });
    }

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token inválido o expirado. Inicie sesión nuevamente.' });
    }
};

module.exports = verifyToken;