// backend/controllers/company.controller.js
const supabase = require('../config/supabase');

// GET /api/company — datos de la empresa del usuario autenticado
const getCompany = async (req, res) => {
    const { data, error } = await supabase
        .from('companies')
        .select('id, name, erp_mapping, business_context, subscription_status, created_at')
        .eq('id', req.user.company_id)
        .single();

    if (error) return res.status(404).json({ error: 'Empresa no encontrada.' });
    res.json({ success: true, company: data });
};

// PUT /api/company — actualizar empresa (solo ADMIN)
const updateCompany = async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')
        return res.status(403).json({ error: 'Sin permisos.' });

    const { name, erp_mapping, business_context } = req.body;
    const updates = {};

    if (name)             updates.name             = name;
    if (erp_mapping)      updates.erp_mapping      = erp_mapping;
    if (business_context) updates.business_context = business_context;

    if (!Object.keys(updates).length)
        return res.status(400).json({ error: 'No hay campos para actualizar.' });

    const { data, error } = await supabase
        .from('companies')
        .update(updates)
        .eq('id', req.user.company_id)
        .select('id, name, erp_mapping, business_context')
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, company: data });
};

module.exports = { getCompany, updateCompany };