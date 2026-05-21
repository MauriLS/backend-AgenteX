// backend/controllers/users.controller.js
const bcrypt  = require('bcrypt');
const supabase = require('../config/supabase');

// GET /api/users/me
const getMe = async (req, res) => {
    const { data, error } = await supabase
        .from('users')
        .select('id, username, email, role, status, created_at, company_id')
        .eq('id', req.user.id)
        .single();

    if (error) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ success: true, user: data });
};

// PUT /api/users/me
const updateMe = async (req, res) => {
    const { username, email, password } = req.body;
    const updates = {};

    if (username) updates.username = username;
    if (email)    updates.email    = email;
    if (password) updates.password_hash = await bcrypt.hash(password, 10);

    if (!Object.keys(updates).length)
        return res.status(400).json({ error: 'No hay campos para actualizar.' });

    const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', req.user.id)
        .select('id, username, email, role, status')
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, user: data });
};

// GET /api/users — solo ADMIN, usuarios de su empresa
const getUsers = async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')
        return res.status(403).json({ error: 'Sin permisos.' });

    const { data, error } = await supabase
        .from('users')
        .select('id, username, email, role, status, created_at')
        .eq('company_id', req.user.company_id)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, users: data });
};

// DELETE /api/users/:id — solo ADMIN
const deleteUser = async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')
        return res.status(403).json({ error: 'Sin permisos.' });

    if (String(req.params.id) === String(req.user.id))
        return res.status(400).json({ error: 'No puedes eliminar tu propio usuario.' });

    // Verificar que el usuario pertenece a la misma empresa
    const { data: target } = await supabase
        .from('users')
        .select('id, company_id')
        .eq('id', req.params.id)
        .single();

    if (!target || target.company_id !== req.user.company_id)
        return res.status(404).json({ error: 'Usuario no encontrado.' });

    const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Usuario eliminado.' });
};

module.exports = { getMe, updateMe, getUsers, deleteUser };