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

const supabase                                          = require('../config/supabase');
const { buscarEnERP }                                   = require('../services/erpSearch.service');
const { consultarAnalitica, formatearAnaliticsParaLLM } = require('../services/analytics.service');
const { buscarParaVentas, formatearVentasParaLLM }      = require('../services/salesSearch.service');
const { consultarLogistica, formatearLogisticaParaLLM } = require('../services/logisticsSearch.service');
const { normalize }                                     = require('../services/textUtils.service');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const PYTHON_URL       = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:8000/api/ia/process';

// =============================================================================
// PASO A — EXTRACTOR DE INTENCIÓN
// LLM auxiliar a temperatura 0. Solo responde un JSON de dos campos.
// Sin historial, sin personalidad, sin tools. ~40 tokens de costo.
// =============================================================================
async function extraerIntencion(mensajeUsuario, businessContext, motor = "erp_search", dimensiones = null) {
    const systemExtractor = `\
Eres un extractor de intención para un motor de búsqueda de inventario.
Tu única tarea es leer el mensaje del usuario y responder EXCLUSIVAMENTE con un JSON válido.
No escribas nada más. Sin explicaciones, sin markdown, sin texto adicional.

REGLAS DE EXTRACCIÓN:
- "termino": Depende del motor:

  Si motor es "erp_search": sustantivo técnico principal + modificadores.
  ELIMINA artículos, preposiciones, verbos conversacionales.
  Para dimensiones: ELIMINA la letra "x". Ej: "29 x 2.10" → "29 2.10"

  Si motor es "analytics": incluye el período o dimensión mencionada.
  Ejemplos:
  - "ventas de diciembre" → "diciembre"
  - "ingresos del mes" → "mes"
  - "rendimiento por técnico este año" → "tecnico año"
  - "qué comuna vendió más" → "ALL"
  - "resumen general" → "ALL"
  El término debe contener palabras que ayuden a detectar el período o dimensión.

  EJEMPLOS DE EXTRACCIÓN CORRECTA:
  - "stock de triciclos electricos" → "triciclo electrico"   (NO solo "triciclo")
  - "quiero ver bicicletas de montaña" → "bicicleta montana" (NO solo "bicicleta")
  - "camaras para aro 29" → "camara 29"                     (mantiene la medida)
  - "neumaticos mtb 29 x 2.10" → "neumatico mtb 29 2.10"    (mantiene tipo y medida)
  - "triciclos de carga eléctricos" → "triciclo carga electrico"

  REGLA CRÍTICA — motor erp_search:
  Si el usuario pregunta por extremos de TODO el inventario sin categoría, usa "ALL".
  - "cual es el producto más caro" → {"termino":"ALL","filtro":"mayor_valor"}
  - "el más barato del inventario" → {"termino":"ALL","filtro":"menor_valor"}
  - "cuántos productos tengo en total" → {"termino":"ALL","filtro":"conteo_total"}
  Solo usa término específico cuando el usuario acota por categoría:
  - "el neumático más caro" → {"termino":"neumatico","filtro":"mayor_valor"}

  REGLA CRÍTICA — motor analytics:
  Para consultas analíticas sin dimensión específica, usa "ALL".
  Para consultas con período o dimensión, inclúyela en el término.
  - "ventas totales de diciembre" → {"termino":"diciembre","filtro":"resumen"}
  - "ingresos por técnico" → {"termino":"ALL","filtro":"por_tecnico"}
  - "qué comuna tuvo más ingresos" → {"termino":"ALL","filtro":"por_comuna"}
  - "rendimiento por tipo de servicio" → {"termino":"ALL","filtro":"por_tipo"}
  - "resumen general del negocio" → {"termino":"ALL","filtro":"resumen"}
  - "técnico más rentable del año" → {"termino":"año","filtro":"mayor_valor"}
  - "cuántas instalaciones tenemos" → {"termino":"ALL","filtro":"conteo_total"}
- "filtro": Uno de estos valores exactos, según el tipo de agente:

  Si motor es "erp_search" (bodega/ventas):
    "busqueda_general"  → búsqueda normal de producto
    "mayor_valor"       → el/los más caro(s)
    "menor_valor"       → el/los más barato(s)
    "stock_mayor"       → el/los con más stock
    "stock_critico"     → productos con stock bajo (≤ 3 unidades)
    "conteo_total"      → cuántos productos hay en total

  Si motor es "analytics" (analítica):
    "resumen"           → totales generales: ingresos, costos, margen, cantidad
    "por_tecnico"       → desglose por técnico o responsable
    "por_comuna"        → desglose por comuna, zona o ciudad
    "por_tipo"          → desglose por tipo o categoría de servicio
    "mayor_valor"       → ranking o top (técnico más rentable, etc.)
    "conteo_total"      → cuántos registros hay en total

  Motor actual: ${motor}
  ${dimensiones ? `Dimensiones agrupables para esta empresa: ${dimensiones}. Usa filtro "por_NOMBRE" para cualquiera de ellas.` : ""}

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
                agent_templates ( base_system_prompt, allowed_tools, motor ),
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
        const tieneERP       = !!empresa.erp_mapping?.productos_url;
        // Motor viene de BD — nunca hardcodeado por agent_id
        const motor          = config.agent_templates?.motor || 'erp_search';

        // ─────────────────────────────────────────────────────────────────────
        // 2. EXTRACCIÓN DE INTENCIÓN (solo si hay ERP configurado)
        // ─────────────────────────────────────────────────────────────────────
        let intencion  = { termino: normalize(message), filtro: 'busqueda_general' };
        let productos  = [];
        let metaERP    = {};

        if (tieneERP) {
            // ── Extracción de intención ──────────────────────────────────────
            // Para motor analytics: se salta — consultarAnalitica recibe el
            // mensaje completo y extrae el rango con su propio LLM auxiliar.
            // Para erp_search: extrae término y filtro para la búsqueda léxica.
            if (motor !== 'analytics') {
            try {
                intencion = await extraerIntencion(message, empresa.business_context, motor);
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
            } // fin if motor !== analytics

            // ── Combinación de contexto (solo para erp_search) ─────────────
            // Analytics no necesita esto — el LLM auxiliar maneja el contexto temporal.
            if (motor !== 'analytics') {
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
            } // fin if motor !== analytics

            // ─────────────────────────────────────────────────────────────────
            // 3. ROUTER DE MOTORES — cada agente usa su propio motor
            // ─────────────────────────────────────────────────────────────────
            if (motor === 'analytics') {
                // Motor analítico: fetch + filtro temporal mínimo.
                // Node.js solo filtra por fecha si el usuario menciona un período.
                // El LLM recibe los registros y hace todo el análisis semántico.
                try {
                    const resultado = await consultarAnalitica({
                        mensaje:    message,
                        erpUrl:     empresa.erp_mapping?.productos_url,
                        erpMapping: empresa.erp_mapping,
                    });
                    metaERP  = { ...resultado.meta, _analytics_registros: resultado.registros, _analytics_agregado: resultado.agregado };
                    productos = [];
                    console.log(`📊 Analítica → modo: ${resultado.meta?.modo} | enviados: ${resultado.meta?.filtrados}`);
                } catch (err) {
                    console.error('🚨 Motor analítico falló:', err.message);
                    metaERP = { error: err.message };
                }
            } else if (motor === 'ventas') {
                // Motor de ventas: catálogo + cliente + historial en paralelo.
                // Si el mensaje solo menciona un cliente sin producto específico,
                // no buscamos en el ERP todavía — evita resultados vacíos o irrelevantes.
                const terminoVentas = intencion.termino === 'all' ? '' : intencion.termino;

                // Recuperar candidatos previos del historial si el turno anterior fue ambiguo
                const candidatosPrevios = (() => {
                    const ultimoAsistente = [...trimmedHistory].reverse().find(m => m.role === 'assistant');
                    if (!ultimoAsistente) return null;
                    // El controller guarda los candidatos en el erp_mapping temporal _candidatos_previos
                    // Alternativamente los detectamos del mensaje del asistente
                    if (ultimoAsistente.content?.includes('¿A cuál de estos') ||
                        ultimoAsistente.content?.includes('cuál es el cliente correcto') ||
                        ultimoAsistente.content?.includes('podrían coincidir')) {
                        return empresa.erp_mapping?._candidatos_previos || null;
                    }
                    return null;
                })();

                try {
                    const resultado = await buscarParaVentas({
                        mensaje:                message,
                        termino:                terminoVentas,
                        filtro:                 intencion.filtro,
                        erpUrl:                 empresa.erp_mapping?.productos_url,
                        erpMapping: {
                            ...empresa.erp_mapping,
                            _candidatos_previos: candidatosPrevios,
                        },
                        historialConversacion:  trimmedHistory,
                    });
                    productos = resultado.productos;
                    metaERP   = {
                        ...resultado.metaProductos,
                        _identificacion:     resultado.identificacion,
                        _perfil_cliente:     resultado.perfilCliente,
                        _total_clientes:     resultado.totalClientes,
                        // Guardamos candidatos para el próximo turno si hay ambigüedad
                        _candidatos_previos: resultado.candidatos,
                    };
                } catch (err) {
                    console.error('🚨 Motor ventas falló:', err.message);
                    metaERP = { error: err.message };
                }

            } else if (motor === 'logistica') {
                // Motor de logística: órdenes de trabajo y despachos.
                // La URL viene de erp_mapping.ordenes_url — no del erp_base_url
                // que pertenece al catálogo de productos/analítica.
                const ordenesUrl = empresa.erp_mapping?.ordenes_url || empresa.erp_mapping?.productos_url;
                try {
                    const resultado = await consultarLogistica({
                        mensaje:    message,
                        erpUrl:     ordenesUrl,
                        erpMapping: empresa.erp_mapping,
                    });
                    productos = [];
                    metaERP   = {
                        _logistica_ordenes:  resultado.ordenes,
                        _logistica_agregado: resultado.agregado,
                        ...resultado.meta,
                    };
                    console.log(`📋 Logística → modo: ${resultado.meta?.modo} | órdenes: ${resultado.meta?.filtradas}`);
                } catch (err) {
                    console.error('🚨 Motor logística falló:', err.message);
                    metaERP = { error: err.message };
                }

            } else {
                // Motor de bodega (default): búsqueda léxica de productos
                try {
                    const resultado = await buscarEnERP({
                        termino:    intencion.termino,
                        filtro:     intencion.filtro,
                        erpUrl:     empresa.erp_mapping?.productos_url,
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

        let nivel4Contenido = '';
        if (tieneERP) {
            if (motor === 'analytics' && (metaERP?._analytics_registros !== undefined || metaERP?._analytics_agregado !== undefined)) {
                nivel4Contenido = formatearAnaliticsParaLLM(
                    metaERP._analytics_registros,
                    metaERP._analytics_agregado,
                    metaERP,
                    empresa.erp_mapping
                );
            } else if (motor === 'logistica') {
                nivel4Contenido = formatearLogisticaParaLLM(
                    metaERP?._logistica_ordenes  || null,
                    metaERP?._logistica_agregado || null,
                    metaERP,
                    empresa.erp_mapping
                );
            } else if (motor === 'ventas') {
                nivel4Contenido = formatearVentasParaLLM(
                    productos,
                    metaERP,
                    metaERP?._identificacion || { estado: 'no_encontrado' },
                    metaERP?._perfil_cliente || null,
                    empresa.erp_mapping
                );
            } else {
                nivel4Contenido = formatearProductos(productos, metaERP, empresa.erp_mapping);
            }
        }
        const NIVEL_4 = tieneERP
            ? `\n## [NIVEL 4 — DATOS OPERACIONALES]\n${nivel4Contenido}\n`
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