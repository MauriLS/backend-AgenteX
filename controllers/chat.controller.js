// backend/controllers/chat.controller.js
//
// Nueva arquitectura: Node busca + LLM redacta
//
// Flujo:
//   1. Carga config del agente desde BD (incluye erp_token)
//   2. Extrae intención del usuario (LLM auxiliar, temp 0, ~40 tokens)
//   3. Búsqueda determinística en ERP (Node.js puro, con caché y fuzzy)
//   4. Ensambla contexto: system_prompt + historial + productos reales
//   5. LLM redacta la respuesta (sin tools, sin erp_url)
//   6. Persiste en BD y responde al frontend

'use strict';

const supabase          = require('../config/supabase');
const { buscarEnERP }   = require('../services/erpSearch.service');
const { normalize }     = require('../services/textUtils.service');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const PYTHON_URL       = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:8000/api/ia/process';

// =============================================================================
// PASO A — EXTRACTOR DE INTENCIÓN
// LLM auxiliar a temperatura 0. Solo responde un JSON de dos campos.
// Sin historial, sin personalidad, sin tools. ~40 tokens de costo.
// =============================================================================
async function extraerIntencion(mensajeUsuario, businessContext) {
    const systemExtractor = `\
Eres un extractor de intención para un motor de búsqueda de inventario.
Tu única tarea es leer el mensaje del usuario y responder EXCLUSIVAMENTE con un JSON válido.
No escribas nada más. Sin explicaciones, sin markdown, sin texto adicional.

REGLAS DE EXTRACCIÓN:
- "termino": El sustantivo técnico principal. ELIMINA preposiciones y palabras genéricas del rubro.
  Para dimensiones: ELIMINA la letra "x". Ej: "29 x 2.10" → "29 2.10"
  Si el usuario referencia una búsqueda anterior ("de los que encontraste", "el más caro de esos"),
  extrae el término implícito del contexto.
- "filtro": Uno de estos valores exactos:
    "busqueda_general"  → búsqueda normal
    "mayor_valor"       → el/los más caro(s)
    "menor_valor"       → el/los más barato(s)
    "stock_mayor"       → el/los con más stock
    "stock_critico"     → productos con stock bajo (≤ 3 unidades)
    "conteo_total"      → cuántos productos hay en total

CONTEXTO DEL RUBRO:
${businessContext || 'Sin contexto disponible.'}

EJEMPLO DE RESPUESTA CORRECTA:
{"termino":"triciclo","filtro":"mayor_valor"}`;

    const response = await fetch(DEEPSEEK_API_URL, {
        method:  'POST',
        headers: {
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            model:       'deepseek-chat',
            temperature: 0,
            max_tokens:  40,
            messages: [
                { role: 'system', content: systemExtractor },
                { role: 'user',   content: mensajeUsuario  },
            ],
        }),
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) throw new Error(`Extractor falló HTTP ${response.status}`);

    const data       = await response.json();
    const rawContent = data.choices?.[0]?.message?.content?.trim() || '{}';

    try {
        const parsed = JSON.parse(rawContent);
        return {
            termino: normalize(parsed.termino || mensajeUsuario),
            filtro:  parsed.filtro || 'busqueda_general',
        };
    } catch {
        console.warn('⚠️  Extractor JSON inválido, usando mensaje crudo:', rawContent);
        return { termino: normalize(mensajeUsuario), filtro: 'busqueda_general' };
    }
}

// =============================================================================
// PASO B — FORMATEADOR DE PRODUCTOS
// Convierte el array de productos reales en texto estructurado para el LLM.
// El LLM solo puede hablar de lo que está en este bloque.
// =============================================================================
function formatearProductos(productos, meta, erpMapping) {
    const K = {
        id:        erpMapping?.id        || 'id',
        nombre:    erpMapping?.nombre    || 'articulo',
        precio:    erpMapping?.precio    || 'precio_tienda',
        stock:     erpMapping?.stock     || 'stock_min',
        categoria: erpMapping?.categoria || 'categoria',
        // stock_url no se usa aquí (ya fue usado en erpSearch), pero
        // lo dejamos documentado para claridad del mapeo completo.
    };

    if (meta?.error) {
        return `[DATOS ERP]\nERROR DE CONEXIÓN: ${meta.error}\nInforma al usuario que el inventario no está disponible.`;
    }

    // Conteo filtrado: el usuario preguntó "cuántos" de un término específico
    if (meta?.es_conteo) {
        return `[DATOS ERP]\nConteo para "${meta.termino_usado}": ${meta.total_encontrados} producto(s) encontrados en inventario.\nInforma este número al usuario y pregúntale si quiere ver el detalle o filtrar por medida/modelo específico.`;
    }

    // Demasiados resultados: la búsqueda es muy amplia.
    // BLOQUEO TOTAL: el LLM no recibe ningún producto.
    // Tiene PROHIBIDO inventar una lista. Solo puede pedir refinamiento.
    if (meta?.demasiados) {
        return [
            `[DATOS ERP — BLOQUEO TOTAL ACTIVO]`,
            `Resultado de búsqueda: ${meta.total_encontrados} productos para "${meta.termino_usado}".`,
            ``,
            `⛔ INSTRUCCIÓN IRREVOCABLE — NIVEL 0 ACTIVO:`,
            `- TIENES PROHIBIDO mostrar productos, IDs, precios o stocks.`,
            `- TIENES PROHIBIDO inventar una tabla o lista parcial.`,
            `- TIENES PROHIBIDO decir "los más relevantes son..." o similar.`,
            `- Tu ÚNICA respuesta permitida es pedir refinamiento al usuario.`,
            ``,
            `Texto exacto que debes usar (puedes adaptarlo a tu tono):`,
            `"Encontré ${meta.total_encontrados} productos para '${meta.termino_usado}'. `,
            `La lista es demasiado amplia para mostrarte el detalle. `,
            `¿Puedes especificar medida exacta, modelo, marca o rango de precio?"`,
        ].join('\n');
    }

    if (productos.length === 0) {
        const extra = meta?.fue_relajado
            ? ` Se intentó también con "${meta.termino_usado}" y tampoco hubo resultados.`
            : '';
        return `[DATOS ERP]\nCERO RESULTADOS para "${meta?.termino_original}".${extra}\nORDEN ABSOLUTA: Informa al usuario que ese artículo NO existe en el inventario. No inventes alternativas.`;
    }

    const avisoRelajado = meta?.fue_relajado
        ? `⚠️ Sin resultados exactos para "${meta.termino_original}". Mostrando aproximados para "${meta.termino_usado}".\n`
        : '';

    const lineas = productos.map(p => {
        const cat = p[K.categoria] ? `[${p[K.categoria]}] ` : '';
        // Usa _stock_real (del join con asignacion-det) si está disponible.
        // Si es null significa que el endpoint de stock no respondió o ese
        // artículo no tiene registro — se muestra explícitamente para que
        // el LLM no invente un valor.
        const stockMostrar = (p._stock_real !== null && p._stock_real !== undefined)
            ? p._stock_real
            : (p[K.stock] !== undefined ? `${p[K.stock]} (alerta mínima)` : 'No disponible');
        return `- ${cat}${p[K.nombre]} (ID: ${p[K.id]}) | Precio: $${p[K.precio]} | Stock: ${stockMostrar}`;
    }).join('\n');

    return `[DATOS ERP — FUENTE ÚNICA DE VERDAD]\n${avisoRelajado}Encontrados: ${productos.length} producto(s) para "${meta?.termino_usado}":\n${lineas}\n\nORDEN ABSOLUTA: Solo puedes mencionar los productos listados arriba. No agregues datos que no estén en esta lista.`;
}

// =============================================================================
// CONTROLADOR PRINCIPAL
// =============================================================================
const processChatMessage = async (req, res) => {
    try {
        const { message, agent_id, history = [], session_chat_id = null } = req.body;
        const companyId = req.user.company_id;

        if (!message || !agent_id) {
            return res.status(400).json({ error: 'Faltan parámetros: message y agent_id son obligatorios.' });
        }

        // ─────────────────────────────────────────────────────────────────────
        // 1. CONFIG DESDE BD
        // ─────────────────────────────────────────────────────────────────────
        const { data: config, error: dbError } = await supabase
            .from('company_agents')
            .select(`
                id,
                custom_instructions,
                temperature,
                max_memory_messages,
                agent_templates ( base_system_prompt, allowed_tools ),
                companies ( name, erp_base_url, erp_mapping, business_context )
            `)
            .eq('company_id', companyId)
            .eq('agent_template_id', agent_id)
            .eq('is_active', true)
            .single();

        if (dbError || !config) {
            console.error('🚨 Agente no encontrado:', dbError);
            return res.status(403).json({ error: 'Agente no autorizado o inactivo.' });
        }

        const empresa        = config.companies || {};
        const maxMemory      = config.max_memory_messages ?? 6;
        const trimmedHistory = history.slice(-(maxMemory));
        const tieneERP       = !!empresa.erp_base_url;

        // ─────────────────────────────────────────────────────────────────────
        // 2. EXTRACCIÓN DE INTENCIÓN (solo si hay ERP configurado)
        // ─────────────────────────────────────────────────────────────────────
        let intencion  = { termino: normalize(message), filtro: 'busqueda_general' };
        let productos  = [];
        let metaERP    = {};

        if (tieneERP) {
            // ── Extracción de intención ──────────────────────────────────────
            // Siempre extraemos la intención del mensaje actual.
            // Si el resultado anterior fue "demasiados" y el nuevo mensaje
            // parece un refinamiento (medida, modelo, marca), combinamos
            // el término anterior + el nuevo para construir una búsqueda precisa.
            try {
                intencion = await extraerIntencion(message, empresa.business_context);
                console.log(`🧠 Intención → termino: "${intencion.termino}" | filtro: "${intencion.filtro}"`);
            } catch (err) {
                // ── FALLBACK LOCAL SIN LLM ───────────────────────────────────
                console.warn('⚠️  Extractor LLM falló, usando extracción local:', err.message);
                const STOP_LOCAL = new Set([
                    'de','para','el','la','los','las','con','sin','en','un','una',
                    'unos','unas','y','o','a','que','del','al','por','se','su','es',
                    'quiero','necesito','busco','dame','dime','muestra','mostrar',
                    'saber','ver','cuanto','cuantos','cual','cuales','tengo','tienes',
                    'hay','existe','stock','precio','costo','valor','info','informacion',
                    'actual','hoy','disponible','disponibles','todo','todos','lista',
                ]);
                const tokens = normalize(message).split(/\s+/);
                const sustantivo = tokens.find(t => t.length >= 4 && !STOP_LOCAL.has(t));
                intencion = {
                    termino: sustantivo || normalize(message),
                    filtro:  'busqueda_general',
                };
                console.log(`🔧 Extracción local → termino: "${intencion.termino}"`);
            }

            // ── Combinación de contexto conversacional ───────────────────────
            // Si el turno anterior terminó en "demasiados" Y el mensaje actual
            // es un refinamiento corto (medida, número, modelo), combinamos
            // el término anterior con el actual para precisar la búsqueda.
            //
            // Ejemplo:
            //   Turno anterior: "neumatico 29" → demasiados (42 resultados)
            //   Mensaje actual: "2.10"
            //   Término combinado: "neumatico 29 2.10"
            //
            // Condiciones para combinar:
            //   1. El historial tiene al menos 2 mensajes (user + assistant)
            //   2. El término extraído actual es corto (≤ 2 tokens)
            //   3. El término extraído actual NO está ya contenido en el anterior
            // ─────────────────────────────────────────────────────────────────
            // ── Combinación de contexto SOLO si el asistente pidió refinamiento ──
            // Condición estricta: el último mensaje del ASISTENTE en el historial
            // debe contener una frase que indique que pidió al usuario que refinara.
            // Esto evita combinar términos de preguntas completamente independientes.
            //
            // Ejemplo válido:
            //   Asistente: "Encontré 42 productos... ¿puedes especificar medida?"
            //   Usuario:   "2.10"   → combinar con término anterior
            //
            // Ejemplo inválido:
            //   Asistente: (muestra tabla de neumáticos 29x2.10)
            //   Usuario:   "camara" → NO combinar, es pregunta nueva
            const FRASES_PEDIR_REFINAMIENTO = [
                'especif', 'filtrar', 'medida exacta', 'modelo', 'marca',
                'rango de precio', 'demasiado amplia', 'necesito que me',
                'puedes especificar', 'puedes filtrar',
            ];

            const ultimoAsistente = [...trimmedHistory]
                .reverse()
                .find(m => m.role === 'assistant');

            const asistentePidioRefinamiento = ultimoAsistente &&
                FRASES_PEDIR_REFINAMIENTO.some(frase =>
                    ultimoAsistente.content.toLowerCase().includes(frase)
                );

            if (asistentePidioRefinamiento && trimmedHistory.length >= 2) {
                const penultimoUser = [...trimmedHistory]
                    .reverse()
                    .find(m => m.role === 'user' && m.content.trim() !== message.trim());

                if (penultimoUser) {
                    try {
                        const intencionAnterior = await extraerIntencion(
                            penultimoUser.content,
                            empresa.business_context
                        );
                        const terminoAnterior = intencionAnterior.termino;
                        const terminoActual   = intencion.termino;
                        const tokensActuales  = terminoActual.trim().split(/\s+/);

                        // Solo combinar si el nuevo término es corto (≤ 2 tokens)
                        // y no está ya contenido en el anterior
                        const esRefinamiento = tokensActuales.length <= 2 &&
                            !terminoAnterior.includes(terminoActual);

                        if (esRefinamiento) {
                            const terminoCombinado = `${terminoAnterior} ${terminoActual}`.trim();
                            console.log(`🔗 Refinamiento detectado: "${terminoAnterior}" + "${terminoActual}" → "${terminoCombinado}"`);
                            intencion = {
                                termino: terminoCombinado,
                                filtro:  'busqueda_general',
                            };
                        }
                    } catch (err) {
                        console.warn('⚠️  Extracción de contexto anterior falló:', err.message);
                    }
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // 3. BÚSQUEDA DETERMINÍSTICA EN ERP
            //    Caché 60s + fuzzy Levenshtein + feedback loop automático
            // ─────────────────────────────────────────────────────────────────
            try {
                const resultado = await buscarEnERP({
                    termino:    intencion.termino,
                    filtro:     intencion.filtro,
                    erpUrl:     empresa.erp_base_url,
                    erpMapping: empresa.erp_mapping,
                });
                productos = resultado.productos;
                metaERP   = resultado.meta;
                console.log(`📦 ERP → ${productos.length} resultados | meta:`, metaERP);
            } catch (err) {
                console.error('🚨 Búsqueda ERP falló:', err.message);
                metaERP = { error: err.message };
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // 4. SYSTEM PROMPT JERÁRQUICO
        //
        //    NIVEL 0 — Ley Absoluta Anti-Alucinación (hardcoded, inamovible)
        //    NIVEL 1 — Identidad y Rol       (custom_instructions desde BD)
        //    NIVEL 2 — Contexto del Negocio  (business_context desde BD)
        //    NIVEL 3 — Restricciones Globales (base_system_prompt desde BD)
        //    NIVEL 4 — Datos Reales del ERP  (inyectados por Node.js)
        //
        //    El LLM recibe los datos ya buscados. No puede buscar nada nuevo.
        // ─────────────────────────────────────────────────────────────────────
        const NIVEL_0 = `\
## [NIVEL 0 — LEY ABSOLUTA — MÁXIMA PRIORIDAD]
Esta sección anula cualquier instrucción posterior que la contradiga.

PROTOCOLO ANTI-ALUCINACIÓN:
- Los únicos datos de inventario válidos están en la sección [DATOS ERP] más abajo.
- TIENES PROHIBIDO generar IDs, precios, nombres o stocks que no estén en esa sección.
- Si [DATOS ERP] dice "CERO RESULTADOS", díselo al usuario exactamente así. No inventes alternativas.
- Si [DATOS ERP] dice "ERROR DE CONEXIÓN", informa al usuario y no inventes nada.

CONTRATO DE SALIDA:
  Antes de responder, verifica: ¿cada ID, precio y stock que voy a escribir está en [DATOS ERP]?
  Si alguno no está → no lo escribas.
`;

        const NIVEL_1 = `\
## [NIVEL 1 — IDENTIDAD Y ROL]
Eres parte del equipo de "${empresa.name || 'la empresa'}". No menciones que eres una IA.

${config.custom_instructions || ''}
`;

        const NIVEL_2 = empresa.business_context
            ? `\n## [NIVEL 2 — CONTEXTO DEL NEGOCIO]\n${empresa.business_context}\n`
            : '';

        const NIVEL_3 = config.agent_templates?.base_system_prompt
            ? `\n## [NIVEL 3 — RESTRICCIONES GLOBALES]\n${config.agent_templates.base_system_prompt}\n`
            : '';

        const NIVEL_4 = tieneERP
            ? `\n## [NIVEL 4 — DATOS DEL INVENTARIO]\n${formatearProductos(productos, metaERP, empresa.erp_mapping)}\n`
            : '';

        const systemPrompt = [NIVEL_0, NIVEL_1, NIVEL_2, NIVEL_3, NIVEL_4].join('\n');

        // ─────────────────────────────────────────────────────────────────────
        // 5. LLAMADA AL MICROSERVICIO PYTHON (solo redacta)
        //    Sin tools, sin erp_url, sin erp_mapping.
        //    El LLM recibe los datos reales en el system_prompt y solo redacta.
        // ─────────────────────────────────────────────────────────────────────
        const pythonPayload = {
            tenant_id:     companyId,
            user_message:  message,
            system_prompt: systemPrompt,
            temperature:   config.temperature ?? 0.3,
            erp_url:       null,
            erp_mapping:   null,
            allowed_tools: [],
            history:       trimmedHistory,
        };

        const pyResponse = await fetch(PYTHON_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(pythonPayload),
            signal:  AbortSignal.timeout(45_000),
        });

        if (!pyResponse.ok) {
            const errText = await pyResponse.text();
            throw new Error(`Motor IA fuera de servicio (${pyResponse.status}): ${errText}`);
        }

        const result  = await pyResponse.json();
        const aiReply = result.reply || 'Error: No se recibió respuesta del motor IA.';

        // ─────────────────────────────────────────────────────────────────────
        // 6. PERSISTENCIA
        // ─────────────────────────────────────────────────────────────────────
        let currentSessionId = session_chat_id;

        try {
            if (!currentSessionId) {
                const { data: newSession, error: sessionError } = await supabase
                    .from('session_chats')
                    .insert([{
                        users_id:         req.user.id,
                        company_agent_id: config.id,
                        alerted:          false,
                        seen:             true,
                    }])
                    .select('id')
                    .single();

                if (sessionError) throw sessionError;
                currentSessionId = newSession.id;
            }

            const { error: insertError } = await supabase
                .from('messages')
                .insert([
                    {
                        session_chat_id:   currentSessionId,
                        content:           message,
                        sender_type:       'USER',
                        prompt_tokens:     0,
                        completion_tokens: 0,
                    },
                    {
                        session_chat_id:   currentSessionId,
                        content:           aiReply,
                        sender_type:       'IA',
                        prompt_tokens:     result.prompt_tokens    || 0,
                        completion_tokens: result.completion_tokens || 0,
                    },
                ]);

            if (insertError) throw insertError;

        } catch (dbErr) {
            console.error('🚨 Colapso en persistencia:', dbErr);
        }

        // ─────────────────────────────────────────────────────────────────────
        // 7. RESPUESTA AL FRONTEND
        // ─────────────────────────────────────────────────────────────────────
        return res.status(200).json({
            success:         true,
            reply:           aiReply,
            session_chat_id: currentSessionId,
            tokens: {
                prompt:     result.prompt_tokens     || 0,
                completion: result.completion_tokens || 0,
            },
            _debug: {
                intencion:       intencion,
                erp_resultados:  productos.length,
                erp_meta:        metaERP,
                history_trimmed: history.length > maxMemory,
                memory_window:   maxMemory,
            },
        });

    } catch (error) {
        console.error('🚨 Fallo crítico en Chat Controller:', error.message);
        return res.status(500).json({
            error:   'El motor de inteligencia no pudo procesar la solicitud.',
            details: error.message,
        });
    }
};

module.exports = { processChatMessage };