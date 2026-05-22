// backend/services/analytics.service.js
//
// Estrategia:
//   1. LLM auxiliar detecta el rango de fechas exacto desde el mensaje
//   2. Node filtra por ese rango (filtro objetivo, no semántico)
//   3. Si volumen ≤ UMBRAL → manda registros crudos al LLM principal
//   4. Si volumen > UMBRAL → pre-agrega dinámicamente y manda resumen
//
// El LLM principal recibe siempre datos completos del rango solicitado.
// Sin hardcoding de dimensiones, sin IFs semánticos, sin muestreo parcial.

'use strict';

const DEEPSEEK_API_URL    = 'https://api.deepseek.com/v1/chat/completions';
const UMBRAL_CRUDO        = 300; // por debajo → registros crudos; encima → pre-agrega
const CACHE_TTL_MS        = 5 * 60_000; // 5 minutos — suficiente para una sesión de análisis

// =============================================================================
// CACHÉ EN MEMORIA (TTL 60s)
// =============================================================================
const analyticsCache = new Map();

async function fetchData(url, companyId, erpToken = null) {
    const headers = erpToken ? { 'Authorization': erpToken } : {};
    const cacheKey = `${companyId}:${url}`;
    const now = Date.now();
    if (analyticsCache.has(cacheKey)) {
        const cached = analyticsCache.get(cacheKey);
        if (now - cached.timestamp < CACHE_TTL_MS) {
            console.log(`📦 Analytics cache hit → ${cacheKey}`);
            return cached.data;
        }
    }
    console.log(`🌐 Analytics fetch → ${url}`);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Endpoint analítica respondió ${response.status}`);
    const data = await response.json();
    analyticsCache.set(cacheKey, { timestamp: now, data });
    return data;
}

// =============================================================================
// PASO 1 — EXTRACTOR DE RANGO (LLM auxiliar, temperatura 0)
//
// El LLM sabe qué significa "trimestre anterior", "últimos 2 años",
// "del lunes al viernes pasado", etc. Node nunca necesita saberlo.
// Devuelve { fecha_inicio, fecha_fin } en ISO 8601 o null si no hay
// referencia temporal en el mensaje.
// =============================================================================
async function extraerRango(mensaje) {
    const hoy = new Date().toISOString().split('T')[0];

    const system = `\
Eres un extractor de rangos de fecha. Hoy es ${hoy}.
Tu única tarea es leer el mensaje y responder EXCLUSIVAMENTE con un JSON válido.
Sin explicaciones, sin markdown, sin texto adicional.

Si el mensaje contiene una referencia temporal, devuelve:
{"fecha_inicio":"YYYY-MM-DD","fecha_fin":"YYYY-MM-DD"}

Si el mensaje NO contiene referencia temporal, devuelve:
{"fecha_inicio":null,"fecha_fin":null}

REGLAS:
- "este mes" = primer día del mes actual hasta hoy
- "mes pasado" = primer y último día del mes anterior
- "este año" = 1 de enero del año actual hasta hoy
- "año pasado" = 1 de enero al 31 de diciembre del año anterior
- "trimestre actual" = primer día del trimestre actual hasta hoy
- "trimestre anterior" = primer y último día del trimestre anterior
- "últimos N meses" = hace N meses desde hoy hasta hoy
- "últimos N años" = hace N años desde hoy hasta hoy
- "compara X con Y" = rango que cubra ambos períodos completos
- Para comparativas, fecha_inicio es el inicio del período más antiguo
  y fecha_fin es el fin del período más reciente

EJEMPLOS:
"ventas de diciembre" → {"fecha_inicio":"${hoy.slice(0,4)}-12-01","fecha_fin":"${hoy.slice(0,4)}-12-31"}
"compara trimestre anterior con actual" → rango que cubra ambos trimestres
"últimos 2 años" → {"fecha_inicio":"${parseInt(hoy.slice(0,4))-2}-${hoy.slice(5)}","fecha_fin":"${hoy}"}
"cuántas instalaciones tenemos" → {"fecha_inicio":null,"fecha_fin":null}`;

    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method:  'POST',
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

        if (!response.ok) throw new Error(`Extractor de rango HTTP ${response.status}`);
        const data    = await response.json();
        const raw     = data.choices?.[0]?.message?.content?.trim() || '{}';
        const parsed  = JSON.parse(raw);

        if (parsed.fecha_inicio && parsed.fecha_fin) {
            console.log(`📅 Rango detectado: ${parsed.fecha_inicio} → ${parsed.fecha_fin}`);
            return parsed;
        }
        return null;

    } catch (err) {
        console.warn(`⚠️  Extractor de rango falló: ${err.message}`);
        return null;
    }
}

// =============================================================================
// PASO 2 — FILTRO POR RANGO (filtro objetivo, no semántico)
// =============================================================================
function filtrarPorRango(registros, rango, campoFecha) {
    if (!rango?.fecha_inicio || !rango?.fecha_fin) return registros;
    const desde = new Date(rango.fecha_inicio);
    const hasta = new Date(rango.fecha_fin + 'T23:59:59');
    return registros.filter(r => {
        const f = new Date(r[campoFecha]);
        return !isNaN(f) && f >= desde && f <= hasta;
    });
}

// =============================================================================
// PASO 3 — PRE-AGREGACIÓN DINÁMICA
//
// Solo se activa cuando el volumen supera UMBRAL_CRUDO.
// Detecta automáticamente campos numéricos y de texto desde el primer registro.
// No necesita saber qué dimensiones existen — las descubre en tiempo de ejecución.
// =============================================================================
function preAgregar(registros, campoFecha, campoId) {
    if (!registros.length) return null;

    const primero = registros[0];
    const excluir = new Set([campoFecha, campoId, 'id', 'created_at', 'updated_at']);

    // Detectar tipos de campos desde el primer registro
    const camposNumericos = Object.keys(primero).filter(k =>
        !excluir.has(k) && !isNaN(parseFloat(primero[k])) && primero[k] !== null
    );
    const camposTexto = Object.keys(primero).filter(k =>
        !excluir.has(k) && isNaN(parseFloat(primero[k])) && primero[k] !== null
    );

    // Agrupa por cada campo de texto y suma cada campo numérico
    const agregaciones = {};

    for (const dim of camposTexto) {
        const grupos = new Map();

        for (const r of registros) {
            const clave = String(r[dim] || 'Sin valor');
            if (!grupos.has(clave)) {
                const entry = { _dimension: clave, _count: 0 };
                for (const num of camposNumericos) entry[`${num}_suma`] = 0;
                grupos.set(clave, entry);
            }
            const g = grupos.get(clave);
            g._count++;
            for (const num of camposNumericos) {
                g[`${num}_suma`] += parseFloat(r[num] || 0);
            }
        }

        agregaciones[dim] = [...grupos.values()]
            .sort((a, b) => b._count - a._count);
    }

    // Resumen global
    const global = { _total_registros: registros.length };
    for (const num of camposNumericos) {
        global[`${num}_suma`]     = registros.reduce((s, r) => s + parseFloat(r[num] || 0), 0);
        global[`${num}_promedio`] = global[`${num}_suma`] / registros.length;
    }

    return { agregaciones, global, campos_numericos: camposNumericos, campos_texto: camposTexto };
}

// =============================================================================
// FUNCIÓN PRINCIPAL
// =============================================================================
async function consultarAnalitica({ mensaje, erpUrl, erpMapping, companyId }) {
    const erpToken = erpMapping?.erp_token || null;
    const campoFecha = erpMapping?.fecha || 'fecha_orden';
    const campoId    = erpMapping?.id    || 'id';

    // Fetch con caché
    let registros;
    try {
        registros = await fetchData(erpUrl, companyId || 'default', erpToken);
    } catch (err) {
        return { registros: null, agregado: null, meta: { error: err.message } };
    }

    if (!Array.isArray(registros)) {
        return { registros: null, agregado: null, meta: { error: 'El endpoint no devolvió un array.' } };
    }

    const totalBase = registros.length;

    // Paso 1: detectar rango con LLM auxiliar
    const rango = await extraerRango(mensaje);

    // Paso 2: filtrar por rango exacto
    const registrosFiltrados = filtrarPorRango(registros, rango, campoFecha);

    console.log(`📊 Analítica → base: ${totalBase} | filtrados: ${registrosFiltrados.length} | rango: ${rango ? `${rango.fecha_inicio} → ${rango.fecha_fin}` : 'todos'}`);

    // Paso 3: decidir entre crudos o pre-agregado
    if (registrosFiltrados.length <= UMBRAL_CRUDO) {
        return {
            registros: registrosFiltrados,
            agregado:  null,
            meta: { total_base: totalBase, filtrados: registrosFiltrados.length, rango, modo: 'crudo' },
        };
    }

    // Volumen alto → pre-agregar dinámicamente
    const agregado = preAgregar(registrosFiltrados, campoFecha, campoId);
    return {
        registros: null,
        agregado,
        meta: { total_base: totalBase, filtrados: registrosFiltrados.length, rango, modo: 'agregado' },
    };
}

// =============================================================================
// FORMATEADOR PARA EL LLM
// =============================================================================
function formatearAnaliticsParaLLM(registros, agregado, meta, erpMapping) {
    if (meta?.error) {
        return `[DATOS ANALÍTICA]\nERROR: ${meta.error}\nInforma al usuario que los datos no están disponibles.`;
    }

    const rangoTexto = meta?.rango
        ? `${meta.rango.fecha_inicio} al ${meta.rango.fecha_fin}`
        : 'todos los registros disponibles';

    const lineas = [
        `[DATOS ANALÍTICA — FUENTE ÚNICA DE VERDAD]`,
        `Período analizado: ${rangoTexto}`,
        `Registros en el período: ${meta?.filtrados} de ${meta?.total_base} totales`,
        '',
    ];

    // Guía de campos para que el LLM entienda los nombres del ERP
    if (erpMapping && Object.keys(erpMapping).length > 0) {
        const guia = Object.entries(erpMapping)
            .filter(([, v]) => v)
            .map(([rol, campo]) => `"${campo}" significa ${rol}`)
            .join('; ');
        lineas.push(`Guía de campos: ${guia}`);
        lineas.push('');
    }

    if (meta?.modo === 'crudo' && registros) {
        // Datos completos — el LLM analiza libremente
        lineas.push('REGISTROS COMPLETOS DEL PERÍODO:');
        lineas.push(JSON.stringify(registros));
        lineas.push('');
        lineas.push('INSTRUCCIÓN: Analiza estos registros y responde la pregunta del usuario.');
        lineas.push('Puedes filtrar, agrupar, sumar, promediar, comparar o rankear cualquier campo.');
        lineas.push('Usa tabla Markdown cuando compares múltiples valores.');

    } else if (meta?.modo === 'agregado' && agregado) {
        // Datos pre-agregados — el LLM interpreta el resumen
        lineas.push(`DATOS PRE-AGREGADOS (${meta.filtrados} registros procesados):`);
        lineas.push(`Campos numéricos sumados: ${agregado.campos_numericos.join(', ')}`);
        lineas.push(`Dimensiones disponibles: ${agregado.campos_texto.join(', ')}`);
        lineas.push('');

        for (const [dim, filas] of Object.entries(agregado.agregaciones)) {
            lineas.push(`POR ${dim.toUpperCase()}:`);
            for (const f of filas) {
                const sumas = agregado.campos_numericos
                    .map(n => `${n}: ${f[`${n}_suma`]?.toFixed(2)}`)
                    .join(' | ');
                lineas.push(`  ${f._dimension} → ${f._count} registros | ${sumas}`);
            }
            lineas.push('');
        }

        lineas.push('RESUMEN GLOBAL:');
        lineas.push(`  Total registros: ${agregado.global._total_registros}`);
        for (const num of agregado.campos_numericos) {
            lineas.push(`  ${num}_total: ${agregado.global[`${num}_suma`]?.toFixed(2)}`);
            lineas.push(`  ${num}_promedio: ${agregado.global[`${num}_promedio`]?.toFixed(2)}`);
        }
        lineas.push('');
        lineas.push('INSTRUCCIÓN: Analiza estos datos pre-agregados y responde la pregunta del usuario.');
        lineas.push('Los datos son del dataset completo del período — no hay muestreo.');
    }

    lineas.push('ORDEN ABSOLUTA: Solo menciona datos que aparezcan explícitamente arriba.');
    return lineas.join('\n');
}

function invalidarCache(url) {
    analyticsCache.delete(url);
}

module.exports = { consultarAnalitica, formatearAnaliticsParaLLM, invalidarCache };