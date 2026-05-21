// backend/controllers/admin.controller.js
const supabase = require('../config/supabase');

const isSuperAdmin = (req, res) => {
    if (req.user.role !== 'SUPER_ADMIN') {
        res.status(403).json({ error: 'Requiere rol SUPER_ADMIN.' });
        return false;
    }
    return true;
};

// GET /api/admin/companies
const getCompanies = async (req, res) => {
    if (!isSuperAdmin(req, res)) return;

    const { data, error } = await supabase
        .from('companies')
        .select('id, name, subscription_status, erp_mapping, created_at')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, companies: data });
};

// PUT /api/admin/companies/:id
const updateCompany = async (req, res) => {
    if (!isSuperAdmin(req, res)) return;

    const { name, erp_mapping, business_context, subscription_status } = req.body;
    const updates = {};
    if (name)                updates.name                = name;
    if (erp_mapping)         updates.erp_mapping         = erp_mapping;
    if (business_context)    updates.business_context    = business_context;
    if (subscription_status) updates.subscription_status = subscription_status;

    if (!Object.keys(updates).length)
        return res.status(400).json({ error: 'No hay campos para actualizar.' });

    const { data, error } = await supabase
        .from('companies')
        .update(updates)
        .eq('id', req.params.id)
        .select('id, name, subscription_status')
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, company: data });
};

// DELETE /api/admin/companies/:id
// Elimina empresa, agentes, usuarios y sesiones en cascada (por FK de BD)
const deleteCompany = async (req, res) => {
    if (!isSuperAdmin(req, res)) return;

    const { error } = await supabase
        .from('companies')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Empresa eliminada.' });
};

module.exports = { getCompanies, updateCompany, deleteCompany };