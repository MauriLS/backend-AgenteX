// backend/controllers/auth.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Inicializamos el cliente de la BD
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ELIMINAMOS el 'register' genérico. 
// ESTE ES EL NUEVO REGISTRO CORPORATIVO MULTI-TENANT (B2B)
const registerB2B = async (req, res) => {
    try {
        // Extraemos los datos. 'agents_to_provision' será un Array de objetos.
        const { company_name, erp_url, username, email, password, agents_to_provision } = req.body;

        // Validación de seguridad: Solo un ADMIN (tú) debería poder registrar empresas
        if (req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: "No tienes autorización para aprovisionar nuevas empresas." });
        }

        if (!company_name || !email || !password || !agents_to_provision || agents_to_provision.length === 0) {
            return res.status(400).json({ error: "Faltan datos obligatorios para el despliegue." });
        }

        const password_hash = await bcrypt.hash(password, 10);

        // 1. Crear la Empresa (Tenant)
        const { data: companyData, error: companyError } = await supabase
            .from('companies')
            .insert([{ name: company_name, erp_base_url: erp_url }])
            .select('id').single();

        if (companyError) throw new Error(`Error al crear empresa: ${companyError.message}`);
        const newCompanyId = companyData.id;

        // 2. Crear el Usuario Administrador del cliente
        const { data: userData, error: userError } = await supabase
            .from('users')
            .insert([{
                company_id: newCompanyId,
                username,
                email,
                password_hash,
                role: 'ADMIN' // El admin de la empresa cliente
            }])
            .select('id').single();

        if (userError) {
            await supabase.from('companies').delete().eq('id', newCompanyId);
            throw new Error(`Error al crear usuario: ${userError.message}`);
        }

        // 3. APROVISIONAMIENTO BATCH: Inyectar múltiples agentes de una vez
        const agentsPayload = agents_to_provision.map(agent => ({
            company_id: newCompanyId,
            agent_template_id: agent.template_id,
            custom_instructions: agent.custom_instructions,
            temperature: agent.temperature || 0.3,
            is_active: true
        }));

        const { error: agentsError } = await supabase
            .from('company_agents')
            .insert(agentsPayload);

        if (agentsError) {
            console.error("🚨 ERROR SQL AL INSERTAR AGENTES:", agentsError); // ESTA LÍNEA ES CRÍTICA
            return res.status(201).json({
                success: true,
                message: "Empresa creada, pero hubo un error con los agentes.",
                company_id: newCompanyId
            });
        }

        return res.status(201).json({ success: true, message: "Infraestructura desplegada correctamente." });

    } catch (error) {
        console.error("COLAPSO EN REGISTRO:", error.message);
        return res.status(500).json({ error: error.message });
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

        // INYECCIÓN DE SEGURIDAD: Agregamos company_id al token
        const token = jwt.sign(
            { id: user.id, role: user.role, company_id: user.company_id },
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
    registerB2B, // ⚠️ IMPORTANTE: El nombre de la función cambió
    login
};