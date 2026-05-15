// backend/services/erpSearch.service.js
//
// Motor de búsqueda determinístico para el ERP de cada empresa.
// Node.js hace el fetch, filtra, ordena y devuelve los productos reales.
// El LLM nunca toca este proceso — solo recibe los resultados para redactar.
//
// Técnicas implementadas:
//   1. Normalización (tildes, mayúsculas, plurales simples)
//   2. Tokenización: texto → AND, números → OR (tolerancia a medidas)
//   3. Fuzzy match con distancia Levenshtein (tolerancia a errores de tipeo)
//   4. Caché en memoria por tenant con TTL de 60 segundos
//   5. Feedback loop: si no hay resultados, reintenta con término relajado

'use strict';

const { removeStopWords, normalize, levenshtein } = require('./textUtils.service');

// =============================================================================
// CACHÉ EN MEMORIA (por tenant, TTL 60s)
// =============================================================================
const erpCache = new Map();
const CACHE_TTL_MS = 60_000;

async function fetchERP(erpUrl) {
    const now = Date.now();
    const cacheKey = erpUrl;

    if (erpCache.has(cacheKey)) {
        const cached = erpCache.get(cacheKey);
        if (now - cached.timestamp < CACHE_TTL_MS) {
            console.log(`📦 ERP cache hit → ${erpUrl}`);
            return cached.data;
        }
    }

    console.log(`🌐 ERP fetch → ${erpUrl}`);
    const response = await fetch(erpUrl, {
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(`ERP respondió ${response.status}`);
    }

    const data = await response.json();
    erpCache.set(cacheKey, { timestamp: now, data });
    return data;
}

// =============================================================================
// FUNCIÓN PRINCIPAL DE BÚSQUEDA
// =============================================================================

/**
 * Busca productos en el ERP de una empresa.
 *
 * @param {object} params
 * @param {string}  params.termino        - Término extraído de la intención del usuario
 * @param {string}  params.filtro         - "busqueda_general" | "mayor_valor" | "menor_valor" | "stock_mayor" | "stock_critico" | "conteo_total"
 * @param {string}  params.erpUrl         - URL base del ERP de la empresa (GET libre, sin auth)
 * @param {object}  params.erpMapping     - Diccionario de claves { id, sku, nombre, precio, stock, categoria }
 * @returns {object} { productos, meta }
 */
async function buscarEnERP({ termino, filtro, erpUrl, erpMapping }) {

    // ── Claves del mapeo (agnóstico al tenant) ────────────────────────────────
    const K = {
        id:        erpMapping?.id        || 'id',
        sku:       erpMapping?.sku       || 'sku',
        nombre:    erpMapping?.nombre    || 'articulo',
        precio:    erpMapping?.precio    || 'precio_tienda',
        stock:     erpMapping?.stock     || 'stock_min',
        categoria: erpMapping?.categoria || 'categoria',
    };

    // ── Fetch con caché ───────────────────────────────────────────────────────
    let articulos;
    try {
        articulos = await fetchERP(erpUrl);
    } catch (err) {
        return {
            productos: [],
            meta: { error: `No se pudo conectar al ERP: ${err.message}`, termino_usado: termino }
        };
    }

    if (!Array.isArray(articulos)) {
        return {
            productos: [],
            meta: { error: 'El ERP no devolvió un array de productos.', termino_usado: termino }
        };
    }

    // ── Conteo total (bypass rápido) ──────────────────────────────────────────
    if (filtro === 'conteo_total') {
        return {
            productos: [],
            meta: { total: articulos.length, termino_usado: termino }
        };
    }

    // ── Búsqueda con intentos (feedback loop) ────────────────────────────────
    // Intento 1: término completo
    // Intento 2: si falla, solo el primer token (término relajado)
    const terminosAIntentar = buildTerminosFallback(termino);
    let resultados = [];
    let terminoUsado = termino;

    for (const t of terminosAIntentar) {
        resultados = filtrarArticulos(articulos, t, filtro, K);
        if (resultados.length > 0) {
            terminoUsado = t;
            break;
        }
    }

    // ── Ordenamiento según filtro ─────────────────────────────────────────────
    resultados = ordenar(resultados, filtro, K);

    return {
        productos: resultados,
        meta: {
            total_encontrados: resultados.length,
            termino_usado:     terminoUsado,
            termino_original:  termino,
            fue_relajado:      terminoUsado !== termino,
        }
    };
}

// =============================================================================
// FILTRADO INTERNO
// =============================================================================
function filtrarArticulos(articulos, termino, filtro, K) {
    const terminoNorm = normalize(termino);
    const tokens      = removeStopWords(terminoNorm.split(' '));

    // Tokens de texto (sin dígitos) → AND
    const tokensTexto = tokens.filter(t => !/\d/.test(t));
    // Tokens numéricos → OR
    const tokensNum   = tokens.filter(t => /\d/.test(t));

    const LEVENSHTEIN_MAX = 2; // Máxima distancia permitida para fuzzy match

    return articulos.filter(art => {
        const valNombre = normalize(String(art[K.nombre] || ''));
        const valSku    = normalize(String(art[K.sku]    || ''));
        const valId     = String(art[K.id] || '');

        // Match exacto por ID o SKU
        if (valId === terminoNorm || valSku.includes(terminoNorm)) return true;

        // Match de texto: todos los tokens de texto deben estar (AND)
        const matchTexto = tokensTexto.length === 0 || tokensTexto.every(t => {
            // Exact substring
            if (valNombre.includes(t)) return true;
            // Fuzzy: alguna palabra del nombre está a distancia ≤ LEVENSHTEIN_MAX
            return valNombre.split(' ').some(palabra =>
                palabra.length > 2 && levenshtein(t, palabra) <= LEVENSHTEIN_MAX
            );
        });

        if (!matchTexto) return false;

        // Match numérico: al menos un token numérico debe estar (OR)
        if (tokensNum.length > 0) {
            const matchNum = tokensNum.some(t => valNombre.includes(t));
            if (!matchNum) return false;
        }

        // Filtro de stock crítico (≤ 3 unidades)
        if (filtro === 'stock_critico') {
            return parseFloat(art[K.stock] || 0) <= 3;
        }

        return true;
    });
}

// =============================================================================
// ORDENAMIENTO
// =============================================================================
function ordenar(resultados, filtro, K) {
    const r = [...resultados];
    switch (filtro) {
        case 'mayor_valor':
            return r.sort((a, b) => parseFloat(b[K.precio] || 0) - parseFloat(a[K.precio] || 0)).slice(0, 10);
        case 'menor_valor':
            return r.sort((a, b) => parseFloat(a[K.precio] || 0) - parseFloat(b[K.precio] || 0)).slice(0, 10);
        case 'stock_mayor':
            return r.sort((a, b) => parseFloat(b[K.stock] || 0) - parseFloat(a[K.stock] || 0)).slice(0, 10);
        case 'stock_critico':
            return r.sort((a, b) => parseFloat(a[K.stock] || 0) - parseFloat(b[K.stock] || 0));
        default:
            return r; // busqueda_general: sin orden especial
    }
}

// =============================================================================
// FEEDBACK LOOP: Genera términos de fallback
// Intento 1: término completo normalizado (ej. "neumatico 29 2.10")
// Intento 2: primer token sustantivo real (ignora stop words y palabras cortas)
//
// REGLA: el fallback nunca puede ser una stop word ni una palabra < 4 chars.
// Esto evita que "quiero saber mi stock..." → fallback "quiero".
// =============================================================================

// Stop words extendidas para el fallback — incluye verbos y expresiones comunes
// que el extractor debería haber filtrado pero no pudo por el fallo de API.
const FALLBACK_STOP_WORDS = new Set([
    'de','para','el','la','los','las','con','sin','en','un','una',
    'unos','unas','y','o','a','que','del','al','por','se','su','es',
    // verbos y expresiones conversacionales frecuentes
    'quiero','necesito','busco','dame','dime','muestra','mostrar',
    'saber','ver','cuanto','cuantos','cual','cuales','tengo','tienes',
    'hay','existe','stock','precio','costo','valor','info','informacion',
    'actual','hoy','disponible','disponibles','todo','todos','lista',
]);

function buildTerminosFallback(termino) {
    const terminos = [termino];
    const tokens = termino.trim().split(/\s+/);

    // Busca el primer token válido: no stop word, longitud >= 4
    const primerSustantivo = tokens.find(t =>
        t.length >= 4 && !FALLBACK_STOP_WORDS.has(t)
    );

    if (primerSustantivo && primerSustantivo !== termino) {
        terminos.push(primerSustantivo);
    }

    return terminos;
}

// =============================================================================
// INVALIDAR CACHÉ MANUALMENTE (útil si el ERP actualiza inventario)
// =============================================================================
function invalidarCache(erpUrl) {
    erpCache.delete(erpUrl);
}

module.exports = { buscarEnERP, invalidarCache };