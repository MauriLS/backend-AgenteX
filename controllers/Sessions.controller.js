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

module.exports = { getSessions, getSessionMessages, deleteSession };