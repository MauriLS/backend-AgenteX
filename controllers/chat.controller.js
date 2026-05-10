const supabase = require('../config/supabase');

const sendMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { prompt, agentTemplateId } = req.body;

        if (!agentTemplateId) {
            return res.status(400).json({ error: "Falla de protocolo: agentTemplateId es requerido." });
        }

        // 1. OBTENER IDENTIDAD Y CONFIGURACIÓN DEL AGENTE (Single Join)
        const { data: agentData, error: agentError } = await supabase
            .from('company_agents')
            .select(`
                id,
                temperature,
                custom_instructions,
                max_memory_messages,
                companies ( erp_base_url ),
                agent_templates ( base_system_prompt, allowed_tools )
            `)
            .eq('is_active', true)
            .eq('agent_template_id', agentTemplateId)
            .single();

        if (agentError || !agentData) {
            return res.status(403).json({ error: "Agente no disponible para su organización." });
        }

        // 2. GESTIÓN DE SESIÓN (Recuperar o Crear)
        let { data: sessionChat } = await supabase
            .from('session_chats')
            .select('id')
            .eq('users_id', userId)
            .eq('company_agent_id', agentData.id)
            .single();

        if (!sessionChat) {
            const { data: newSession } = await supabase
                .from('session_chats')
                .insert([{ users_id: userId, company_agent_id: agentData.id }])
                .select('id')
                .single();
            sessionChat = newSession;
        }

        // 3. RECUPERACIÓN DE MEMORIA (Historial Dinámico)
        const { data: pastMessages } = await supabase
            .from('messages')
            .select('content, sender_type')
            .eq('session_chat_id', sessionChat.id)
            .order('created_at', { ascending: false })
            .limit(agentData.max_memory_messages || 6);

        // Formateamos para Python (invertimos el orden para que sea cronológico)
        const formattedHistory = pastMessages 
            ? pastMessages.reverse().map(m => ({
                role: m.sender_type === 'USER' ? 'user' : 'assistant',
                content: m.content
              }))
            : [];

        // 4. LLAMADA AL MOTOR DE IA (Cloud a Cloud)
        const finalSystemPrompt = `${agentData.agent_templates.base_system_prompt}\n\n[INSTRUCCIONES ESPECÍFICAS]:\n${agentData.custom_instructions}`;
        
        const pythonResponse = await fetch(`${process.env.PYTHON_ENGINE_URL}/api/ia/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                pregunta: prompt,
                history: formattedHistory,
                system_prompt: finalSystemPrompt,
                allowed_tools: agentData.agent_templates.allowed_tools,
                tenant_config: { erp_url: agentData.companies.erp_base_url },
                temperature: parseFloat(agentData.temperature)
            })
        });

        const iaData = await pythonResponse.json();
        if (!pythonResponse.ok) throw new Error(iaData.error || "Falla en el motor Python");

        const iaText = iaData.respuesta;
        const promptTokens = iaData.prompt_tokens || 0;
        const completionTokens = iaData.completion_tokens || 0;

        // 5. REGISTRO DOBLE E INMUTABLE (Auditoría B2B)
        // Guardamos tanto la pregunta como la respuesta en una sola transacción
        await supabase.from('messages').insert([
            {
                session_chat_id: sessionChat.id,
                content: prompt,
                sender_type: 'USER',
                prompt_tokens: 0,
                completion_tokens: 0
            },
            {
                session_chat_id: sessionChat.id,
                content: iaText,
                sender_type: 'IA',
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens
            }
        ]);

        return res.status(200).json({ success: true, respuesta: iaText });

    } catch (error) {
        console.error("CRITICAL ERROR:", error.message);
        return res.status(500).json({ error: "Error en el pipeline de orquestación." });
    }
};

module.exports = { sendMessage };