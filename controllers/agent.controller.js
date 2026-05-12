const supabase = require('../config/supabase');

const getMyAgents = async (req, res) => {
    try {
        const userId = req.user.id; // Asume que tu middleware de auth ya inyectó esto

        // 1. Validar la empresa del usuario
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('company_id')
            .eq('id', userId)
            .single();

        if (userError || !userData) {
            return res.status(403).json({ error: "Brecha de seguridad: Usuario sin empresa." });
        }

        // 2. Extraer el catálogo autorizado (JOIN Relacional)
        const { data: agentsData, error: agentsError } = await supabase
            .from('company_agents')
            .select(`
                id,
                agent_template_id,
                agent_templates ( name )
            `)
            .eq('company_id', userData.company_id)
            .eq('is_active', true);

        if (agentsError) throw new Error("Fallo al consultar el catálogo en Supabase.");

        // 3. Formatear el contrato de salida para React
        const formattedAgents = agentsData.map(agent => ({
            instanceId: agent.id,                 // El ID numérico de la instancia
            templateId: agent.agent_template_id,  // Ej: 'bodega' (Para la lógica del chat)
            name: agent.agent_templates.name      // Ej: 'Agente de Bodega' (Para dibujar el botón)
        }));

        return res.status(200).json({
            success: true,
            agents: formattedAgents
        });

    } catch (error) {
        console.error("Fallo crítico en Discovery API:", error);
        return res.status(500).json({ error: "Error interno al descubrir agentes." });
    }
};

module.exports = { getMyAgents };