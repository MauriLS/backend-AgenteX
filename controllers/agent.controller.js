// backend/controllers/agent.controller.js
const supabase = require('../config/supabase');

// GET /api/agents/my-agents — agentes activos de la empresa del usuario
const getMyAgents = async (req, res) => {
    try {
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('company_id')
            .eq('id', req.user.id)
            .single();

        if (userError || !userData)
            return res.status(403).json({ error: 'Usuario sin empresa.' });

        const { data, error } = await supabase
            .from('company_agents')
            .select('id, agent_template_id, agent_templates ( name )')
            .eq('company_id', userData.company_id)
            .eq('is_active', true);

        if (error) throw new Error('Fallo al consultar agentes.');

        return res.json({
            success: true,
            agents: data.map(a => ({
                instanceId: a.id,
                templateId: a.agent_template_id,
                name:       a.agent_templates.name,
            })),
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

// GET /api/agents/templates — todos los templates disponibles
const getTemplates = async (req, res) => {
    const { data, error } = await supabase
        .from('agent_templates')
        .select('id, name, motor, allowed_tools')
        .order('name');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, templates: data });
};

// GET /api/agents — agentes de la empresa (ADMIN)
const getAgents = async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')
        return res.status(403).json({ error: 'Sin permisos.' });

    const { data, error } = await supabase
        .from('company_agents')
        .select('id, agent_template_id, custom_instructions, temperature, is_active, created_at, agent_templates ( name, motor )')
        .eq('company_id', req.user.company_id)
        .order('created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, agents: data });
};

// PUT /api/agents/:id — actualizar instrucciones o temperatura (ADMIN)
const updateAgent = async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')
        return res.status(403).json({ error: 'Sin permisos.' });

    const { custom_instructions, temperature } = req.body;
    const updates = {};
    if (custom_instructions !== undefined) updates.custom_instructions = custom_instructions;
    if (temperature          !== undefined) updates.temperature         = temperature;

    if (!Object.keys(updates).length)
        return res.status(400).json({ error: 'No hay campos para actualizar.' });

    // Verificar ownership — el agente debe pertenecer a la empresa del admin
    const { data: existing } = await supabase
        .from('company_agents')
        .select('id, company_id')
        .eq('id', req.params.id)
        .single();

    if (!existing || existing.company_id !== req.user.company_id)
        return res.status(404).json({ error: 'Agente no encontrado.' });

    const { data, error } = await supabase
        .from('company_agents')
        .update(updates)
        .eq('id', req.params.id)
        .select('id, agent_template_id, custom_instructions, temperature, is_active')
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, agent: data });
};

// DELETE /api/agents/:id — desactivar agente (soft delete, ADMIN)
const deleteAgent = async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')
        return res.status(403).json({ error: 'Sin permisos.' });

    const { data: existing } = await supabase
        .from('company_agents')
        .select('id, company_id')
        .eq('id', req.params.id)
        .single();

    if (!existing || existing.company_id !== req.user.company_id)
        return res.status(404).json({ error: 'Agente no encontrado.' });

    // Soft delete — is_active: false en vez de eliminar el registro
    // Preserva el historial de sesiones vinculado al agente
    const { error } = await supabase
        .from('company_agents')
        .update({ is_active: false })
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Agente desactivado.' });
};

// POST /api/agents — crear agente para la empresa del ADMIN autenticado
const createAgent = async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')
        return res.status(403).json({ error: 'Sin permisos.' });

    const { agent_template_id, custom_instructions, temperature } = req.body;

    if (!agent_template_id || !custom_instructions)
        return res.status(400).json({ error: 'agent_template_id y custom_instructions son obligatorios.' });

    // Verificar que el template existe
    const { data: template } = await supabase
        .from('agent_templates')
        .select('id, name')
        .eq('id', agent_template_id)
        .single();

    if (!template)
        return res.status(404).json({ error: 'Template no encontrado.' });

    // Verificar que la empresa no tiene ya ese agente activo
    const { data: existing } = await supabase
        .from('company_agents')
        .select('id')
        .eq('company_id', req.user.company_id)
        .eq('agent_template_id', agent_template_id)
        .eq('is_active', true)
        .single();

    if (existing)
        return res.status(409).json({ error: `La empresa ya tiene un agente de tipo "${agent_template_id}" activo.` });

    const { data, error } = await supabase
        .from('company_agents')
        .insert([{
            company_id:          req.user.company_id,
            agent_template_id,
            custom_instructions,
            temperature:         temperature ?? 0.3,
            is_active:           true,
        }])
        .select('id, agent_template_id, custom_instructions, temperature, is_active')
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ success: true, agent: data });
};

module.exports = { getMyAgents, getTemplates, getAgents, createAgent, updateAgent, deleteAgent };