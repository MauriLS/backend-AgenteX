// backend/controllers/sessions.controller.js
const supabase = require('../config/supabase');

// GET /api/sessions — sesiones del usuario autenticado
const getSessions = async (req, res) => {
    const { data, error } = await supabase
        .from('session_chats')
        .select(`
            id,
            created_at,
            alerted,
            seen,
            company_agents ( agent_template_id, custom_instructions )
        `)
        .eq('users_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, sessions: data });
};

// GET /api/sessions/:id/messages — mensajes de una sesión
const getSessionMessages = async (req, res) => {
    // Verificar ownership antes de devolver los mensajes
    const { data: session } = await supabase
        .from('session_chats')
        .select('id, users_id')
        .eq('id', req.params.id)
        .single();

    if (!session || session.users_id !== req.user.id)
        return res.status(404).json({ error: 'Sesión no encontrada.' });

    const { data, error } = await supabase
        .from('messages')
        .select('id, content, sender_type, prompt_tokens, completion_tokens, created_at')
        .eq('session_chat_id', req.params.id)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, messages: data });
};

// DELETE /api/sessions/:id
const deleteSession = async (req, res) => {
    const { data: session } = await supabase
        .from('session_chats')
        .select('id, users_id')
        .eq('id', req.params.id)
        .single();

    if (!session || session.users_id !== req.user.id)
        return res.status(404).json({ error: 'Sesión no encontrada.' });

    // Los mensajes se eliminan en cascada por FK
    const { error } = await supabase
        .from('session_chats')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Sesión eliminada.' });
};

// GET /api/sessions/stats
// Métricas por agente: sesiones, preguntas, tokens prompt/completion
const getStats = async (req, res) => {
    const { data: sessions, error: sessErr } = await supabase
        .from('session_chats')
        .select('id, company_agents ( agent_template_id, agent_templates ( name ) )')
        .eq('users_id', req.user.id);

    if (sessErr) return res.status(500).json({ error: sessErr.message });
    if (!sessions.length) return res.json({ success: true, stats: [] });

    const sessionIds = sessions.map(s => s.id);

    const { data: messages, error: msgErr } = await supabase
        .from('messages')
        .select('session_chat_id, sender_type, prompt_tokens, completion_tokens')
        .in('session_chat_id', sessionIds);

    if (msgErr) return res.status(500).json({ error: msgErr.message });

    // Mapa session_id → agente
    const sessionAgente = {};
    for (const s of sessions) {
        sessionAgente[s.id] = {
            templateId: s.company_agents?.agent_template_id || 'desconocido',
            name:       s.company_agents?.agent_templates?.name || 'Agente',
        };
    }

    // Agregar métricas por agente
    const porAgente = {};
    const sesionesUnicas = {};

    for (const s of sessions) {
        const key = sessionAgente[s.id]?.templateId;
        if (!key) continue;
        if (!porAgente[key]) {
            porAgente[key] = {
                agent_id:          key,
                agent_name:        sessionAgente[s.id].name,
                total_sesiones:    0,
                total_preguntas:   0,
                prompt_tokens:     0,
                completion_tokens: 0,
            };
            sesionesUnicas[key] = new Set();
        }
        sesionesUnicas[key].add(s.id);
    }

    for (const msg of messages) {
        const key = sessionAgente[msg.session_chat_id]?.templateId;
        if (!key || !porAgente[key]) continue;
        porAgente[key].prompt_tokens     += msg.prompt_tokens     || 0;
        porAgente[key].completion_tokens += msg.completion_tokens || 0;
        if (msg.sender_type === 'USER') porAgente[key].total_preguntas++;
    }

    for (const key of Object.keys(porAgente)) {
        porAgente[key].total_sesiones = sesionesUnicas[key]?.size || 0;
    }

    const stats = Object.values(porAgente).map(a => ({
        ...a,
        total_tokens: a.prompt_tokens + a.completion_tokens,
    }));

    res.json({ success: true, stats });
};

module.exports = { getSessions, getSessionMessages, deleteSession, getStats };