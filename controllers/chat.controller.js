// backend-AgenteX/controllers/chat.controller.js
const supabase = require('../config/supabase');

const sendMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { prompt } = req.body;
        const agentId = 1; // Asumimos que 1 es Bodega por ahora

        if (!prompt) return res.status(400).json({ error: "Prompt requerido." });

        // 1. Gestión de Sesión
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
        const { data: rawHistory, error: historyError } = await supabase
            .from('messages')
            .select('content, sender_type')
            .eq('session_chat_id', sessionId)
            .order('created_at', { ascending: false })
            .limit(6);

        if (historyError) throw historyError;

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

        // ==========================================
        // 🏗️ INYECCIÓN MULTI-TENANT (Abstracción SaaS)
        // ==========================================
        // En la versión final, esto vendrá de una consulta a tu tabla 'companies' o 'tenants'
        
        const tenantConfig = {
            erp_url: "http://92.113.39.10:3001/articulos" // La URL del cliente actual
        };

        const systemPrompt = `Eres el Agente X, encargado de la Bodega. Eres directo y analítico.
Tienes acceso a consultar productos en tiempo real.
REGLA CRÍTICA: NUNCA confíes en la información de productos que esté en el historial de la conversación.
Los precios y descripciones cambian constantemente. SIEMPRE debes ejecutar tu herramienta para verificar el estado actual del producto, incluso si el usuario te pregunta por el mismo producto dos veces seguidas.`;

        // Le decimos a Python qué herramientas tiene permitidas este cliente
        const allowedTools = ['consultar_inventario_erp']; 

        // 4. Delegación al Motor Python (El Trabajador Agnóstico)
        const pythonResponse = await fetch('http://127.0.0.1:8000/api/ia/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                pregunta: prompt,
                history: formattedHistory,
                // 👉 AQUÍ VIAJA EL NUEVO CONTRATO PARA QUE PYTHON NO DE ERROR 422
                system_prompt: systemPrompt,
                allowed_tools: allowedTools,
                tenant_config: tenantConfig
            })
        });

        // 🛡️ Manejo de errores si Python rebota la petición
        if (!pythonResponse.ok) {
            const errorDetalle = await pythonResponse.text();
            console.error(`Error del Motor Python (${pythonResponse.status}):`, errorDetalle);
            throw new Error(`Fallo en el motor de IA: ${pythonResponse.status}`);
        }

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
        return res.status(500).json({ error: "Error en procesamiento de memoria o motor de IA." });
    }
};

module.exports = {
    sendMessage
};