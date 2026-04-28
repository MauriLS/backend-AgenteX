// backend/middlewares/auth.js
const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    // 1. Buscar el token en los headers (Formato: Bearer <token>)
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    // 2. Si no hay token, patada inmediata
    if (!token) {
        return res.status(401).json({ error: 'Acceso denegado. Se requiere un token B2B.' });
    }

    try {
        // 3. Verificar si el token es auténtico usando tu firma secreta
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'super_secreto_b2b_cambiar_luego');
        
        // 4. Inyectar los datos del usuario (id, role) en la petición para usarlos después
        req.user = verified;
        
        // 5. Dejar pasar a la siguiente ruta
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token inválido o expirado. Inicie sesión nuevamente.' });
    }
};

module.exports = verifyToken;