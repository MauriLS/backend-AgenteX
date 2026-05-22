// backend/services/logisticsSearch.service.js
//
// Motor de logística — consulta órdenes de trabajo y despachos.
//
// Características:
//   - Normaliza campos que pueden llegar como array o string (estado, prioridad)
//   - Filtro temporal via LLM auxiliar (mismo patrón que analytics)
//   - Filtro por estado, responsable o cliente desde el mensaje
//   - Para volúmenes altos: pre-agrega por estado y responsable
//   - Caché 60s

'use strict';

const DEEPSEEK_API_URL  = 'https://api.deepseek.com/v1/chat/completions';
const UMBRAL_CRUDO      = 200; // órdenes — más liviano que analítica
const CACHE_TTL_MS      = 60_000;

// =============================================================================
// CACHÉ
// =============================================================================
const logisticsCache = new Map();

async function fetchData(url, companyId, erpToken = null) {
    const headers = erpToken ? { 'Authorization': erpToken } : {};
    const cacheKey = `${companyId}:${url}`;
    const now = Date.now();
    if (logisticsCache.has(cacheKey)) {
        const cached = logisticsCache.get(cacheKey);
        if (now - cached.timestamp < CACHE_TTL_MS) {
            console.log(`📦 Logistics cache hit → ${cacheKey}`);
            return cached.data;
        }
    }
    console.log(`🌐 Logistics fetch → ${url}`);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Endpoint respondió ${response.status}`);
    const data = await response.json();
    logisticsCache.set(cacheKey, { timestamp: now, data });
    return data;
}

// =============================================================================
// NORMALIZACIÓN DE CAMPOS
// Maneja arrays, strings, nulls y formatos inconsistentes de distintos ERPs.
// =============================================================================
function normalizar(valor) {
    if (valor === null || valor === undefined) return '';
    if (Array.isArray(valor)) return valor[0] ?? '';
    return String(valor);
}

function normalizarOrden(orden, K) {
    return {
        ...orden,
        [K.estado]:    normalizar(orden[K.estado]),
        [K.prioridad]: normalizar(orden[K.prioridad]),
    };
}

// =============================================================================
// EXTRACTOR DE RANGO (mismo patrón que analytics)
// =============================================================================
async function extraerRangoLogistica(mensaje) {
    const hoy = new Date().toISOString().split('T')[0];

    const system = `Eres un extractor de rangos de fecha. Hoy es ${hoy}.
Responde EXCLUSIVAMENTE con JSON válido. Sin explicaciones ni markdown.

Si el mensaje contiene referencia temporal → {"fecha_inicio":"YYYY-MM-DD","fecha_fin":"YYYY-MM-DD"}
Si no contiene referencia temporal → {"fecha_inicio":null,"fecha_fin":null}

REGLAS:
- "hoy" = ${hoy} → ${hoy}
- "esta semana" = lunes de esta semana → hoy
- "este mes" = primer día del mes → hoy
- "pendientes" / "en ruta" / "activas" sin fecha = sin rango (null)
- Para estados sin fecha, devuelve null en ambos campos`;

    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                model:       'deepseek-chat',
                temperature: 0,
                max_tokens:  60,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user',   content: mensaje },
                ],
            }),
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data   = await response.json();
        const raw    = data.choices?.[0]?.message?.content?.trim() || '{}';
        const parsed = JSON.parse(raw);
        if (parsed.fecha_inicio && parsed.fecha_fin) {
            console.log(`📅 Rango logística: ${parsed.fecha_inicio} → ${parsed.fecha_fin}`);
            return parsed;
        }
        return null;
    } catch (err) {
        console.warn(`⚠️  Extractor rango logística falló: ${err.message}`);
        return null;
    }
}

// =============================================================================
// FILTRO POR RANGO DE FECHAS
// =============================================================================
function filtrarPorRango(ordenes, rango, campoFecha) {
    if (!rango?.fecha_inicio || !rango?.fecha_fin) return ordenes;
    const desde = new Date(rango.fecha_inicio);
    const hasta = new Date(rango.fecha_fin + 'T23:59:59');
    return ordenes.filter(o => {
        const f = new Date(o[campoFecha]);
        return !isNaN(f) && f >= desde && f <= hasta;
    });
}

// =============================================================================
// PRE-AGREGACIÓN PARA VOLÚMENES ALTOS
// Agrupa por estado y responsable con conteos y fechas relevantes.
// Dinámico — detecta campos de texto automáticamente.
// =============================================================================
function preAgregarOrdenes(ordenes, K) {
    if (!ordenes.length) return null;

    // Normalizar todas las órdenes primero
    const ordenesNorm = ordenes.map(o => normalizarOrden(o, K));

    // Conteo por estado
    const porEstado = {};
    for (const o of ordenesNorm) {
        const est = normalizar(o[K.estado]) || 'Sin estado';
        porEstado[est] = (porEstado[est] || 0) + 1;
    }

    // Conteo por responsable
    const porResponsable = {};
    for (const o of ordenesNorm) {
        const resp = normalizar(o[K.responsable]) || 'Sin asignar';
        if (!porResponsable[resp]) porResponsable[resp] = { total: 0, estados: {} };
        porResponsable[resp].total++;
        const est = normalizar(o[K.estado]) || 'Sin estado';
        porResponsable[resp].estados[est] = (porResponsable[resp].estados[est] || 0) + 1;
    }

    // Órdenes de alta prioridad pendientes
    const altaPrioridad = ordenesNorm
        .filter(o => {
            const est  = normalizar(o[K.estado]).toLowerCase();
            const prio = normalizar(o[K.prioridad]).toLowerCase();
            return prio === 'alta' && !['completado','entregado','cerrado','cancelado'].includes(est);
        })
        .slice(0, 10)
        .map(o => ({
            numero:      o[K.numero]      || o.id,
            estado:      normalizar(o[K.estado]),
            responsable: normalizar(o[K.responsable]),
            cliente:     o[K.cliente_nombre] || o[K.cliente_id],
            compromiso:  o[K.fecha_compromiso],
        }));

    return {
        total:           ordenes.length,
        por_estado:      porEstado,
        por_responsable: porResponsable,
        alta_prioridad:  altaPrioridad,
    };
}

// =============================================================================
// FUNCIÓN PRINCIPAL
// =============================================================================
async function consultarLogistica({ mensaje, erpUrl, erpMapping, companyId }) {
    const erpToken = erpMapping?.erp_token || null;
    const K = {
        id:               erpMapping?.id               || 'id',
        numero:           erpMapping?.numero           || 'numero_orden',
        tipo:             erpMapping?.tipo             || 'tipo',
        estado:           erpMapping?.estado           || 'estado',
        cliente_id:       erpMapping?.cliente_id       || 'cliente_id',
        cliente_nombre:   erpMapping?.cliente_nombre   || 'cliente_nombre',
        responsable:      erpMapping?.responsable      || 'responsable',
        productos:        erpMapping?.productos        || 'productos',
        fecha_creacion:   erpMapping?.fecha_creacion   || 'fecha_creacion',
        fecha_compromiso: erpMapping?.fecha_compromiso || 'fecha_compromiso',
        fecha_cierre:     erpMapping?.fecha_cierre     || 'fecha_cierre',
        prioridad:        erpMapping?.prioridad        || 'prioridad',
        direccion:        erpMapping?.direccion        || 'direccion',
        notas:            erpMapping?.notas            || 'notas',
    };

    let ordenes;
    try {
        ordenes = await fetchData(erpUrl, companyId || 'default', erpToken);
    } catch (err) {
        return { ordenes: null, agregado: null, meta: { error: err.message } };
    }

    if (!Array.isArray(ordenes)) {
        return { ordenes: null, agregado: null, meta: { error: 'El endpoint no devolvió un array.' } };
    }

    const totalBase = ordenes.length;

    // Normalizar todas las órdenes (arrays → strings)
    const ordenesNorm = ordenes.map(o => normalizarOrden(o, K));

    // Extraer rango temporal
    const rango = await extraerRangoLogistica(mensaje);

    // Filtrar por rango si existe
    let ordenesFiltradas = filtrarPorRango(ordenesNorm, rango, K.fecha_creacion);

    console.log(`📋 Logística → base: ${totalBase} | filtradas: ${ordenesFiltradas.length} | rango: ${rango ? `${rango.fecha_inicio} → ${rango.fecha_fin}` : 'todas'}`);

    // Decidir entre crudas o pre-agregadas
    if (ordenesFiltradas.length <= UMBRAL_CRUDO) {
        return {
            ordenes:  ordenesFiltradas,
            agregado: null,
            meta: {
                total_base: totalBase,
                filtradas:  ordenesFiltradas.length,
                rango,
                modo:       'crudo',
                K,
            },
        };
    }

    const agregado = preAgregarOrdenes(ordenesFiltradas, K);
    return {
        ordenes:  null,
        agregado,
        meta: {
            total_base: totalBase,
            filtradas:  ordenesFiltradas.length,
            rango,
            modo:       'agregado',
            K,
        },
    };
}

// =============================================================================
// FORMATEADOR PARA EL LLM
// =============================================================================
function formatearLogisticaParaLLM(ordenes, agregado, meta, erpMapping) {
    if (meta?.error) {
        return `[DATOS LOGÍSTICA]\nERROR: ${meta.error}\nInforma al usuario que los datos no están disponibles.`;
    }

    const rangoTexto = meta?.rango
        ? `${meta.rango.fecha_inicio} al ${meta.rango.fecha_fin}`
        : 'todas las órdenes disponibles';

    const lineas = [
        '[DATOS LOGÍSTICA — FUENTE ÚNICA DE VERDAD]',
        `Período: ${rangoTexto}`,
        `Órdenes en el período: ${meta?.filtradas} de ${meta?.total_base} totales`,
        '',
    ];

    if (erpMapping && Object.keys(erpMapping).length > 0) {
        const guia = Object.entries(erpMapping)
            .filter(([k, v]) => v && !k.startsWith('_') && !k.endsWith('_url'))
            .map(([rol, campo]) => `"${campo}" = ${rol}`)
            .join(', ');
        if (guia) { lineas.push(`Guía de campos: ${guia}`); lineas.push(''); }
    }

    if (meta?.modo === 'crudo' && ordenes?.length > 0) {
        lineas.push('ÓRDENES COMPLETAS:');
        lineas.push(JSON.stringify(ordenes));

    } else if (meta?.modo === 'agregado' && agregado) {
        lineas.push(`RESUMEN PRE-AGREGADO (${meta.filtradas} órdenes):`);
        lineas.push('');
        lineas.push('POR ESTADO:');
        for (const [est, cnt] of Object.entries(agregado.por_estado)) {
            lineas.push(`  ${est}: ${cnt} órdenes`);
        }
        lineas.push('');
        lineas.push('POR RESPONSABLE:');
        for (const [resp, data] of Object.entries(agregado.por_responsable)) {
            const estados = Object.entries(data.estados)
                .map(([e, c]) => `${e}:${c}`).join(', ');
            lineas.push(`  ${resp}: ${data.total} órdenes (${estados})`);
        }
        if (agregado.alta_prioridad?.length > 0) {
            lineas.push('');
            lineas.push('ALTA PRIORIDAD PENDIENTES:');
            lineas.push(JSON.stringify(agregado.alta_prioridad));
        }

    } else {
        lineas.push('Sin órdenes para el período solicitado.');
        lineas.push('Informa al usuario que no hay registros para ese criterio.');
    }

    lineas.push('');
    lineas.push('INSTRUCCIÓN: Analiza los datos y responde la pregunta del usuario.');
    lineas.push('Usa tabla Markdown cuando compares estados, responsables o fechas.');
    lineas.push('ORDEN ABSOLUTA: Solo menciona datos que aparezcan explícitamente arriba.');

    return lineas.join('\n');
}

function invalidarCache(url) {
    logisticsCache.delete(url);
}

module.exports = { consultarLogistica, formatearLogisticaParaLLM, invalidarCache };