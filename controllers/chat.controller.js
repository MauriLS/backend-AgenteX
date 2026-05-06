// backend-AgenteX/controllers/chat.controller.js

const sendMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { prompt } = req.body;
        const agentId = 1;

        if (!prompt) return res.status(400).json({ error: "Prompt requerido." });

        // 1. Gestión de Sesión (Obtenemos el ID de la sesión actual)
        let sessionId;
        const { data: sessionData } = await supabase
            .from('session_chats')
            .select('id')
            .eq('users_id', userId)
            .eq('agents_id', agentId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (sessionData) {
            sessionId = sessionData.id;
        } else {
            const { data: newSession } = await supabase
                .from('session_chats')
                .insert([{ users_id: userId, agents_id: agentId }])
                .select().single();
            sessionId = newSession.id;
        }

        // 2. RECUPERACIÓN DE MEMORIA (Historial reciente)
        // Extraemos los últimos 6 mensajes para no saturar el contexto
        const { data: rawHistory, error: historyError } = await supabase
            .from('messages')
            .select('content, sender_type')
            .eq('session_chat_id', sessionId)
            .order('created_at', { ascending: false })
            .limit(6);

        if (historyError) throw historyError;

        // Mapeo de roles: Transformamos USER/IA al estándar de la industria (user/assistant)
        // Invertimos el array (.reverse()) para que los mensajes vayan en orden cronológico
        const formattedHistory = rawHistory.reverse().map(msg => ({
            role: msg.sender_type === 'USER' ? 'user' : 'assistant',
            content: msg.content
        }));

        // 3. Auditoría del nuevo mensaje del USUARIO
        await supabase.from('messages').insert([{
            session_chat_id: sessionId,
            content: prompt,
            sender_type: 'USER'
        }]);

        // 4. Delegación al Motor Python con inyección de historial
        const pythonResponse = await fetch('http://127.0.0.1:8000/api/ia/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                pregunta: prompt,
                history: formattedHistory // Aquí viaja la memoria del Agente
            })
        });

        const iaData = await pythonResponse.json();
        const iaText = iaData.respuesta;

        // 5. Auditoría de la respuesta de la IA
        await supabase.from('messages').insert([{
            session_chat_id: sessionId,
            content: iaText,
            sender_type: 'IA'
        }]);

        return res.status(200).json({
            success: true,
            respuesta: iaText
        });

    } catch (error) {
        console.error("Fallo crítico en flujo de chat:", error);
        return res.status(500).json({ error: "Error en procesamiento de memoria." });
    }
};