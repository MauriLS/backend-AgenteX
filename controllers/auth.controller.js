// backend/controllers/auth.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const registerB2B = async (req, res) => {
    try {
        const {
            company_name,
            erp_url,
            erp_mapping,        // ← NUEVO: mapeo de campos del ERP
            business_context,   // ← NUEVO: diccionario del rubro
            username,
            email,
            password,
            agents_to_provision
        } = req.body;

        // Solo ADMIN puede aprovisionar empresas
        if (req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: 'No tienes autorización para aprovisionar nuevas empresas.' });
        }

        if (!company_name || !email || !password || !agents_to_provision || agents_to_provision.length === 0) {
            return res.status(400).json({ error: 'Faltan datos obligatorios para el despliegue.' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        // ── 1. Crear la Empresa ───────────────────────────────────────────────
        // erp_mapping y business_context son opcionales — si vienen null/undefined
        // Supabase los guarda como null, lo que es válido (el sistema usa fallbacks).
        const companyInsert = {
            name:             company_name,
            erp_base_url:     erp_url         || null,
            erp_mapping:      erp_mapping      || null,
            business_context: business_context || null,
        };

        const { data: companyData, error: companyError } = await supabase
            .from('companies')
            .insert([companyInsert])
            .select('id')
            .single();

        if (companyError) throw new Error(`Error al crear empresa: ${companyError.message}`);
        const newCompanyId = companyData.id;

        // ── 2. Crear el Usuario Admin del cliente ─────────────────────────────
        const { error: userError } = await supabase
            .from('users')
            .insert([{
                company_id:    newCompanyId,
                username:      username || email.split('@')[0],
                email,
                password_hash,
                role:          'ADMIN',
            }]);

        if (userError) {
            // Rollback manual: eliminar la empresa si el usuario falla
            await supabase.from('companies').delete().eq('id', newCompanyId);
            throw new Error(`Error al crear usuario: ${userError.message}`);
        }

        // ── 3. Aprovisionamiento de Agentes ───────────────────────────────────
        const agentsPayload = agents_to_provision.map(agent => ({
            company_id:          newCompanyId,
            agent_template_id:   agent.template_id,
            custom_instructions: agent.custom_instructions,
            temperature:         agent.temperature ?? 0.3,
            is_active:           true,
        }));

        const { error: agentsError } = await supabase
            .from('company_agents')
            .insert(agentsPayload);

        if (agentsError) {
            console.error('🚨 Error al insertar agentes:', agentsError);
            // La empresa y usuario quedaron creados — avisamos pero no fallamos
            return res.status(201).json({
                success: true,
                message: 'Empresa creada, pero hubo un error al aprovisionar los agentes.',
                company_id: newCompanyId,
            });
        }

        console.log(`✅ Empresa "${company_name}" desplegada | ID: ${newCompanyId} | Agentes: ${agents_to_provision.length}`);
        console.log(`📋 erp_mapping recibido:`, JSON.stringify(erp_mapping));
        console.log(`📋 business_context recibido (primeros 50 chars):`, business_context?.slice(0, 50));

        const responsePayload = {
            success:    true,
            message:    `Infraestructura desplegada correctamente para "${company_name}".`,
            company_id: newCompanyId,
        };
        console.log(`📤 Enviando respuesta:`, JSON.stringify(responsePayload));
        return res.status(201).json(responsePayload);

    } catch (error) {
        console.error('🚨 Colapso en registro B2B:', error.message);
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

        if (error || !users || users.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const user = users[0];

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role, company_id: user.company_id },
            process.env.JWT_SECRET || 'super_secreto_b2b_cambiar_luego',
            { expiresIn: '8h' }
        );

        return res.json({
            message: 'Login exitoso',
            token,
            user: { username: user.username, role: user.role },
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

module.exports = { registerB2B, login };