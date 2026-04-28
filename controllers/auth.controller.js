// backend/controllers/auth.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Inicializamos el cliente de la BD directamente donde se necesita
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const register = async (req, res) => {
    const { username, email, password, role } = req.body;

    try {
        const password_hash = await bcrypt.hash(password, 10);

        const { data, error } = await supabase
            .from('users')
            .insert([{ username, email, password_hash, role }])
            .select();

        if (error) throw error;
        
        res.status(201).json({ status: 'Usuario B2B creado', data });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const login = async (req, res) => {
    const { email, password } = req.body;

    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email);

        if (error || users.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const user = users[0];

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET || 'super_secreto_b2b_cambiar_luego',
            { expiresIn: '8h' }
        );

        res.json({ 
            message: 'Login exitoso', 
            token, 
            user: { username: user.username, role: user.role } 
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Exportamos las funciones para que las rutas puedan usarlas
module.exports = {
    register,
    login
};