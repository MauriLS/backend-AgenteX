// backend/controllers/chat.controller.js
const supabase = require('../config/supabase');

const processChatMessage = async (req, res) => {
    try {
        const { message, agent_id, history = [] } = req.body;
        const companyId = req.user.company_id; // Inyectado por el middleware verifyToken

        if (!message || !agent_id) {
            return res.status(400).json({ error: "Faltan parámetros: message y agent_id son obligatorios." });
        }

        // 1. EXTRACCIÓN DE CONTEXTO (El JOIN Relacional)
        const { data: config, error: dbError } = await supabase
            .from('company_agents')
            .select(`
                custom_instructions, 
                temperature,
                companies ( name, erp_base_url, erp_mapping ) // 🚩 PEDIMOS EL DICCIONARIO A SUPABASE
            `)
            .eq('company_id', companyId)
            .eq('agent_template_id', agent_id)
            .eq('is_active', true)
            .single();

        if (dbError || !config) {
            return res.status(403).json({ error: "Agente no autorizado o inactivo." });
        }

        const identityPrompt = `[DIRECTIVA DE SISTEMA]: Trabajas exclusivamente para "${config.companies.name}". No menciones que eres una IA genérica.\n\n${config.custom_instructions}`;

        // 2. CONSTRUCCIÓN DEL CONTRATO
        const pythonPayload = {
            tenant_id: companyId,
            user_message: message,
            system_prompt: identityPrompt,
            temperature: config.temperature,
            erp_url: config.companies?.erp_base_url || null,
            erp_mapping: config.companies?.erp_mapping || null,
            allowed_tools: agent_id === 'bodega' ? ['consultar_inventario_erp'] : [],
            history: history 
        };

        // 3. LLAMADA AL MICROSERVICIO DE IA (PYTHON)
        const PYTHON_URL = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:8000/api/ia/process';
        
        const response = await fetch(PYTHON_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pythonPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Motor IA fuera de servicio (${response.status}): ${errorText}`);
        }

        const result = await response.json();

        // 4. RESPUESTA FINAL AL FRONTEND
        // Aquí podrías guardar el log del chat en Supabase antes de responder
        return res.status(200).json({
            success: true,
            reply: result.reply,
            tokens: {
                prompt: result.prompt_tokens,
                completion: result.completion_tokens
            }
        });

    } catch (error) {
        console.error("Fallo crítico en Chat Controller:", error.message);
        return res.status(500).json({ 
            error: "El motor de inteligencia no pudo procesar la solicitud.",
            details: error.message 
        });
    }
};

module.exports = {
    processChatMessage
};