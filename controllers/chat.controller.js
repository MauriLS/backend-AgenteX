const supabase = require('../config/supabase'); 

const sendMessage = async (req, res) => {
    try {
        // 1. Extraer datos del escudo (Token) y del cuerpo
        const userId = req.user.id; 
        const { prompt } = req.body;
        const agentId = 1; 

        if (!prompt) {
            return res.status(400).json({ error: "El prompt no puede estar vacío." });
        }

        // 2. Gestionar la Sesión Buscamos si hay una activa, si no, la creamos
        // Aquí buscaremos la última sesión del usuario con este agente.
        let sessionId;
        const { data: existingSessions, error: sessionError } = await supabase
            .from('session_chats')
            .select('id')
            .eq('users_id', userId)
            .eq('agents_id', agentId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (sessionError) throw sessionError;

        if (existingSessions && existingSessions.length > 0) {
            sessionId = existingSessions[0].id;
        } else {
            // Crear nueva sesión
            const { data: newSession, error: createSessionError } = await supabase
                .from('session_chats')
                .insert([{ users_id: userId, agents_id: agentId }])
                .select()
                .single();
            
            if (createSessionError) throw createSessionError;
            sessionId = newSession.id;
        }

        // 3. Auditar el mensaje del USUARIO
        const { error: userMsgError } = await supabase
            .from('messages')
            .insert([{
                session_chat_id: sessionId,
                content: prompt,
                sender_type: 'USER'
            }]);
        
        if (userMsgError) throw userMsgError;

        // 4. Delegar al Intermediario de Python (Tu motor IA)
        const pythonResponse = await fetch('http://127.0.0.1:8000/api/ia/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                pregunta: prompt,
                //  Aquí es donde enviaríamos el historial previo a Python si lo necesitara
            })
        });

        if (!pythonResponse.ok) {
            throw new Error(`Error en el motor IA: ${pythonResponse.statusText}`);
        }

        const iaData = await pythonResponse.json();
        const iaText = iaData.respuesta || iaData.agente_x; // Ajusta según lo que devuelva tu Python

        // 5. Auditar el mensaje de la IA
        const { error: iaMsgError } = await supabase
            .from('messages')
            .insert([{
                session_chat_id: sessionId,
                content: iaText,
                sender_type: 'IA'
            }]);

        if (iaMsgError) throw iaMsgError;

        // 6. Retornar el payload final al Frontend
        return res.status(200).json({
            success: true,
            session_id: sessionId,
            prompt: prompt,
            respuesta: iaText
        });

    } catch (error) {
        console.error("Error en sendMessage:", error);
        return res.status(500).json({ error: "Error interno procesando el mensaje." });
    }
};

module.exports = {
    sendMessage
};