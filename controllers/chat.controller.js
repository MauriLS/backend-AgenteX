// backend/controllers/chat.controller.js

const sendMessage = async (req, res) => {
    // Gracias al middleware, req.user ya existe y es seguro
    const { prompt } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    
    // TODO: Conectar a DeepSeek y guardar en tabla messages

    res.json({ 
        message: 'Petición recibida por la IA', 
        user_info: `Eres el usuario ${userId} con rol ${userRole}`,
        tu_pregunta: prompt
    });
};

module.exports = {
    sendMessage
};