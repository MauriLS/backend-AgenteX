// backend/services/salesSearch.service.js
//
// Motor de ventas — tres fuentes de datos en paralelo:
//   1. ERP: productos con descripción, precio y stock real
//   2. Clientes: datos del cliente buscado por nombre o RUT
//   3. Historial: compras anteriores del cliente
//
// Node.js busca y cruza los datos.
// El LLM recibe el contexto completo y asesora con lenguaje persuasivo.

'use strict';

const { buscarEnERP }          = require('./erp-search.service');
const { normalize, levenshtein } = require('./text-utils.service');

// =============================================================================
// CACHÉ EN MEMORIA (TTL 60s)
// =============================================================================
const salesCache = new Map();
const CACHE_TTL_MS = 60_000;

async function fetchURL(url) {
    const now = Date.now();
    if (salesCache.has(url)) {
        const cached = salesCache.get(url);
        if (now - cached.timestamp < CACHE_TTL_MS) {
            console.log(`📦 Sales cache hit → ${url}`);
            return cached.data;
        }
    }
    console.log(`🌐 Sales fetch → ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Endpoint respondió ${response.status} para ${url}`);
    const data = await response.json();
    salesCache.set(url, { timestamp: now, data });
    return data;
}

// =============================================================================
// PASO 1A — LISTA COMPACTA DE CLIENTES
// Solo id, nombre y campo de identificación — para no explotar el contexto.
// El LLM identifica al cliente correcto desde esta lista mínima.
// =============================================================================
function construirListaCompacta(clientes, campoId, campoNombre) {
    return clientes.map(c => ({
        id:      c.id,
        nombre:  c[campoNombre] || c.nombre || c.name || '',
        [campoId]: c[campoId] || '',
        segmento: c.segmento || '',
    }));
}

// =============================================================================
// PASO 1B — LLM AUXILIAR: IDENTIFICACIÓN DEL CLIENTE
// Recibe lista compacta y mensaje del usuario.
// Devuelve JSON con estado: encontrado / ambiguo / no_encontrado
// =============================================================================
async function extraerCliente(mensaje, listaCompacta, candidatosPrevios = null) {
    if (!listaCompacta?.length) {
        return { estado: 'no_encontrado' };
    }

    // Si hay candidatos previos, el usuario está respondiendo una desambiguación.
    // Usamos esa lista reducida — el LLM interpreta "opcion 1", "el primero", números.
    const listaAUsar = candidatosPrevios?.length ? candidatosPrevios : listaCompacta;

    const contexto = candidatosPrevios?.length
        ? `El usuario está respondiendo a una selección previa de candidatos.
Interpreta "opcion 1", "el primero", "1", "el segundo", nombres parciales
como referencias posicionales o por nombre a la lista de candidatos.`
        : `Busca al cliente mencionado. El usuario puede escribir el nombre con errores de tipeo.`;

    const system = `Eres un identificador de clientes. Responde EXCLUSIVAMENTE con JSON válido.
Sin explicaciones, sin markdown, sin texto adicional.

${contexto}

REGLAS:
- Un solo cliente coincide → {"estado":"encontrado","cliente_id":"ID"}
- Varios coinciden → {"estado":"ambiguo","candidatos":[{"id":"...","nombre":"...","segmento":"..."}]}
- Ninguno coincide → {"estado":"no_encontrado"}
- Mensaje sin referencia a cliente → {"estado":"no_encontrado"}

LISTA:
${JSON.stringify(listaAUsar)}`;

    try {
        const response = await fetch(
            'https://api.deepseek.com/v1/chat/completions',
            {
                method:  'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                    'Content-Type':  'application/json',
                },
                body: JSON.stringify({
                    model:       'deepseek-chat',
                    temperature: 0,
                    max_tokens:  200,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user',   content: mensaje },
                    ],
                }),
                signal: AbortSignal.timeout(15_000),
            }
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const raw  = data.choices?.[0]?.message?.content?.trim() || '{}';
        const parsed = JSON.parse(raw);
        console.log(`🔍 Identificación cliente → estado: ${parsed.estado} | candidatos: ${parsed.candidatos?.length || (parsed.cliente_id ? 1 : 0)}`);
        return parsed;

    } catch (err) {
        console.warn(`⚠️  Identificador de cliente falló: ${err.message}`);
        return { estado: 'error', mensaje: err.message };
    }
}

// =============================================================================
// PASO 2 — FETCH DE PERFIL COMPLETO + HISTORIAL DEL CLIENTE IDENTIFICADO
// Solo se ejecuta cuando el paso 1 devolvió estado "encontrado".
// =============================================================================
async function fetchPerfilCompleto(clientes, historial, clienteId) {
    const cliente = clientes.find(c => String(c.id) === String(clienteId));
    if (!cliente) return null;

    const historialCliente = historial
        .filter(h => String(h.cliente_id) === String(clienteId))
        .sort((a, b) => new Date(b.fecha_compra) - new Date(a.fecha_compra))
        .slice(0, 10);

    return { ...cliente, historial_compras: historialCliente };
}

// =============================================================================
// FUNCIÓN PRINCIPAL
// =============================================================================
async function buscarParaVentas({ mensaje, termino, filtro, erpUrl, erpMapping, historialConversacion = [] }) {
    const clientesUrl        = erpMapping?.clientes_url      || null;
    const historialUrl       = erpMapping?.historial_url     || null;
    const clienteIdCampo     = erpMapping?.cliente_id_campo  || 'rut';
    const clienteNombreCampo = erpMapping?.clientes_nombre   || 'nombre';

    // ── Fetch paralelo: ERP + clientes + historial ────────────────────────────
    const [resultadoERP, todosLosClientes, todoElHistorial] = await Promise.all([
        termino
            ? buscarEnERP({ termino, filtro, erpUrl, erpMapping }).catch(err => {
                console.warn('⚠️  ERP falló en ventas:', err.message);
                return { productos: [], meta: { error: err.message } };
            })
            : Promise.resolve({ productos: [], meta: {} }),

        clientesUrl
            ? fetchURL(clientesUrl).catch(err => {
                console.warn('⚠️  Clientes endpoint falló:', err.message);
                return [];
            })
            : Promise.resolve([]),

        historialUrl
            ? fetchURL(historialUrl).catch(err => {
                console.warn('⚠️  Historial endpoint falló:', err.message);
                return [];
            })
            : Promise.resolve([]),
    ]);

    const clientes  = Array.isArray(todosLosClientes) ? todosLosClientes : [];
    const historial = Array.isArray(todoElHistorial)  ? todoElHistorial  : [];

    // ── Detectar candidatos previos del historial de conversación ────────────
    // Si el último mensaje del asistente presentó una tabla de candidatos,
    // el usuario está respondiendo una desambiguación. Extraemos los candidatos
    // del último mensaje ambiguo del historial para pasárselos al LLM auxiliar.
    let candidatosPrevios = null;
    const ultimoAsistente = [...historialConversacion]
        .reverse()
        .find(m => m.role === 'assistant');

    if (ultimoAsistente?.content?.includes('"estado":"ambiguo"') ||
        ultimoAsistente?.content?.includes('¿A cuál de estos') ||
        ultimoAsistente?.content?.includes('cuál es el cliente correcto')) {
        // Intentar extraer candidatos del mensaje anterior del sistema
        // Los candidatos vienen en la metaERP del turno anterior — los pasamos
        // explícitamente desde el controller
        candidatosPrevios = erpMapping?._candidatos_previos || null;
    }

    // ── PASO 1: LLM auxiliar identifica al cliente ────────────────────────────
    const listaCompacta  = construirListaCompacta(clientes, clienteIdCampo, clienteNombreCampo);
    const identificacion = await extraerCliente(mensaje, listaCompacta, candidatosPrevios);

    // ── PASO 2: Si cliente identificado → fetch perfil completo + historial ───
    let perfilCliente = null;
    if (identificacion.estado === 'encontrado' && identificacion.cliente_id) {
        perfilCliente = await fetchPerfilCompleto(clientes, historial, identificacion.cliente_id);
        console.log(`🛒 Cliente identificado: ${perfilCliente?.[clienteNombreCampo] || identificacion.cliente_id}`);
    }

    console.log(`🛒 Ventas → productos: ${resultadoERP.productos?.length || 0} | estado cliente: ${identificacion.estado} | clientes totales: ${clientes.length}`);

    return {
        productos:      resultadoERP.productos || [],
        metaProductos:  resultadoERP.meta,
        identificacion,
        perfilCliente,
        totalClientes:  clientes.length,
        candidatos:     identificacion.estado === 'ambiguo' ? identificacion.candidatos : null,
    };
}

// =============================================================================
// FORMATEADOR PARA EL LLM
// Maneja 3 estados según la identificación del cliente:
//
//   encontrado   → perfil completo + historial + productos → asesoría personalizada
//   ambiguo      → tabla de candidatos → pide confirmación al vendedor
//   no_encontrado → informa que el cliente no está en el sistema
// =============================================================================
function formatearVentasParaLLM(productos, metaProductos, identificacion, perfilCliente, erpMapping) {
    const K = {
        id:          erpMapping?.id          || 'id',
        nombre:      erpMapping?.nombre      || 'nombre',
        precio:      erpMapping?.precio      || 'precio',
        descripcion: erpMapping?.descripcion || 'descripcion',
        sku:         erpMapping?.sku         || 'sku',
    };

    const lineas = ['[DATOS DE VENTAS — FUENTE ÚNICA DE VERDAD]', ''];
    const estado  = identificacion?.estado || 'no_encontrado';

    // ── Estado: AMBIGUO — múltiples candidatos ────────────────────────────────
    if (estado === 'ambiguo') {
        const candidatos = identificacion.candidatos || [];
        lineas.push('ESTADO: CLIENTE AMBIGUO');
        lineas.push(`Se encontraron ${candidatos.length} clientes que podrían coincidir.`);
        lineas.push('');
        lineas.push('INSTRUCCIÓN OBLIGATORIA:');
        lineas.push('Muestra al vendedor la siguiente tabla Markdown y pregunta cuál es el cliente correcto.');
        lineas.push('NO hagas ninguna otra acción hasta que el vendedor confirme.');
        lineas.push('');
        lineas.push('CANDIDATOS:');
        lineas.push(JSON.stringify(candidatos));
        lineas.push('');
        lineas.push('Formato de tabla que debes mostrar:');
        lineas.push('| # | Nombre | RUT/ID | Segmento |');
        lineas.push('|---|--------|--------|----------|');
        lineas.push('(llena con los datos de candidatos)');
        lineas.push('Luego pregunta: "¿A cuál de estos clientes te refieres?"');
        return lineas.join('\n');
    }

    // ── Estado: NO ENCONTRADO ─────────────────────────────────────────────────
    if (estado === 'no_encontrado' || estado === 'error') {
        lineas.push('ESTADO: CLIENTE NO ENCONTRADO');
        lineas.push('INSTRUCCIÓN: Informa al vendedor que el cliente no está registrado en el sistema.');
        lineas.push('Puedes ofrecer continuar con la consulta de productos si lo necesita.');
    }

    // ── Estado: ENCONTRADO — perfil completo ──────────────────────────────────
    if (estado === 'encontrado' && perfilCliente) {
        lineas.push('PERFIL DEL CLIENTE IDENTIFICADO:');
        lineas.push(JSON.stringify(perfilCliente));
        lineas.push('');
    }

    // ── Productos ─────────────────────────────────────────────────────────────
    if (metaProductos?.error) {
        lineas.push(`ERROR DE INVENTARIO: ${metaProductos.error}`);
    } else if (metaProductos?.demasiados) {
        lineas.push(`BÚSQUEDA AMPLIA: ${metaProductos.total_encontrados} productos. Pide al vendedor que especifique más.`);
    } else if (productos?.length > 0) {
        lineas.push(`PRODUCTOS DISPONIBLES (${productos.length}):`);
        for (const p of productos) {
            lineas.push(`  ID: ${p[K.id]} | SKU: ${p[K.sku] || 'N/A'} | ${p[K.nombre]}`);
            lineas.push(`  Precio: $${p[K.precio]} | Stock: ${p._stock_real ?? 'N/D'}`);
            if (p[K.descripcion]) lineas.push(`  Descripción: ${p[K.descripcion]}`);
            lineas.push('');
        }
    }

    // ── Instrucción final ─────────────────────────────────────────────────────
    if (estado === 'encontrado') {
        lineas.push('INSTRUCCIÓN:');
        lineas.push('Eres un asesor comercial. Con los datos anteriores:');
        lineas.push('1. Usa el perfil e historial del cliente para personalizar la asesoría.');
        lineas.push('2. Presenta los productos con características y beneficios relevantes para este cliente.');
        lineas.push('3. Considera su presupuesto habitual y lo que ha comprado antes.');
        lineas.push('4. Usa lenguaje persuasivo orientado al valor, no solo al precio.');
    }

    lineas.push('ORDEN ABSOLUTA: Solo menciona datos que aparezcan explícitamente en esta sección.');
    return lineas.join('\n');
}

function invalidarCache(url) {
    salesCache.delete(url);
}

module.exports = { buscarParaVentas, formatearVentasParaLLM, invalidarCache };