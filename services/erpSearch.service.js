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
//   6. Join con endpoint de stock real (asignacion-det) via Promise.all

'use strict';

const { removeStopWords, normalize, levenshtein } = require('./textUtils.service');

// =============================================================================
// CACHÉ EN MEMORIA (por URL, TTL 60s)
// Cada endpoint se cachea independientemente.
// La clave incluye la URL completa para garantizar aislamiento entre tenants.
// =============================================================================
const erpCache = new Map();
const CACHE_TTL_MS = 60_000;

async function fetchURL(url) {
    const now = Date.now();

    if (erpCache.has(url)) {
        const cached = erpCache.get(url);
        if (now - cached.timestamp < CACHE_TTL_MS) {
            console.log(`📦 Cache hit → ${url}`);
            return cached.data;
        }
    }

    console.log(`🌐 Fetch → ${url}`);
    const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(`ERP respondió ${response.status} para ${url}`);
    }

    const data = await response.json();
    erpCache.set(url, { timestamp: now, data });
    return data;
}

// =============================================================================
// JOIN EN MEMORIA: articulos + stock real
//
// Hace ambos fetches en paralelo (Promise.all) y cruza por id_articulo.
// Si el endpoint de stock falla, devuelve los artículos con stock = null
// para que el LLM informe que el stock no está disponible en lugar de
// mostrar el stock_min falso.
//
// El campo stock_url viene de companies.erp_mapping.stock_url (nuevo campo).
// Si no está configurado, se omite el join y se usa el campo stock del mapeo.
// =============================================================================
async function fetchArticulosConStock(erpUrl, stockUrl, K) {
    // Fetch paralelo — no esperamos uno para empezar el otro
    const [articulos, stockData] = await Promise.all([
        fetchURL(erpUrl),
        stockUrl ? fetchURL(stockUrl).catch(err => {
            console.warn(`⚠️  Stock endpoint falló, se mostrará stock no disponible: ${err.message}`);
            return null;
        }) : Promise.resolve(null),
    ]);

    if (!Array.isArray(articulos)) {
        throw new Error('El ERP no devolvió un array de productos.');
    }

    // Si no hay endpoint de stock, devolvemos artículos sin modificar
    if (!stockData || !Array.isArray(stockData)) {
        console.warn('⚠️  Sin datos de stock real. Se omite el campo stock.');
        return articulos.map(art => ({ ...art, _stock_real: null }));
    }

    // Claves del join — vienen del mapping configurado por la empresa
    // stock_join_id:  clave del endpoint secundario que se cruza con el ID del artículo
    // stock_real_key: clave que contiene el valor de stock real
    const joinKey     = K.stock_join_id  || 'id_articulo';
    const stockValKey = K.stock_real_key || 'stock_real';

    // Construimos un Map para join O(1)
    const stockMap = new Map(
        stockData.map(s => [String(s[joinKey] ?? ''), s[stockValKey] ?? null])
    );

    // Enriquecemos cada artículo con su stock real
    return articulos.map(art => {
        const artId      = String(art[K.id] || '');
        const stockReal  = stockMap.has(artId) ? stockMap.get(artId) : null;
        return { ...art, _stock_real: stockReal };
    });
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
 * @param {object}  params.erpMapping     - Diccionario de claves { id, sku, nombre, precio, stock, categoria, stock_url }
 *                                          stock_url: URL del endpoint de stock real (asignacion-det)
 * @returns {object} { productos, meta }
 */
async function buscarEnERP({ termino, filtro, erpUrl, erpMapping }) {

    // ── Claves del mapeo (agnóstico al tenant) ────────────────────────────────
    const K = {
        id:        erpMapping?.id        || 'id',
        sku:       erpMapping?.sku       || 'sku',
        nombre:    erpMapping?.nombre    || 'articulo',
        precio:    erpMapping?.precio    || 'precio_tienda',
        stock:     erpMapping?.stock     || 'stock_min',  // fallback si no hay stock_url
        categoria: erpMapping?.categoria || 'categoria',
        stock_url:     erpMapping?.stock_url     || null,  // URL del endpoint secundario
        stock_join_id: erpMapping?.stock_join_id || null,  // Clave de cruce en el endpoint secundario
        stock_real_key: erpMapping?.stock_real_key || null, // Clave del valor de stock real
    };

    // ── Fetch paralelo: artículos + stock real (con join en memoria) ──────────
    let articulos;
    try {
        articulos = await fetchArticulosConStock(erpUrl, K.stock_url, K);
    } catch (err) {
        return {
            productos: [],
            meta: { error: `No se pudo conectar al ERP: ${err.message}`, termino_usado: termino }
        };
    }

    // ── Búsqueda con intentos (feedback loop) ────────────────────────────────
    // Caso especial: termino "ALL" → usar todos los artículos sin filtrar.
    // Se usa cuando el usuario pregunta por el más caro/barato/mayor stock
    // de TODO el inventario sin especificar categoría.
    let resultados = [];
    let terminoUsado = termino;

    if (termino === 'ALL') {
        resultados  = [...articulos];
        terminoUsado = 'ALL';
    } else {
        // Intento 1: término completo
        // Intento 2: si falla, solo el primer token (término relajado)
        const terminosAIntentar = buildTerminosFallback(termino);

        for (const t of terminosAIntentar) {
            const filtroReal = filtro === 'conteo_total' ? 'busqueda_general' : filtro;
            resultados = filtrarArticulos(articulos, t, filtroReal, K);
            if (resultados.length > 0) {
                terminoUsado = t;
                break;
            }
        }
    }

    // ── Umbral de fricción ────────────────────────────────────────────────────
    // Si hay más de UMBRAL resultados, devolvemos el conteo y pedimos refinar.
    //
    // EXCEPCIONES — filtros que nunca activan el umbral porque ya limitan solos:
    //   - mayor_valor / menor_valor / stock_mayor: el ordenamiento devuelve top N
    //   - stock_critico: siempre mostramos todos (son los urgentes)
    //   - conteo_total: devuelve conteo, no lista
    const UMBRAL = 15;
    const FILTROS_SIN_UMBRAL = new Set([
        'mayor_valor', 'menor_valor', 'stock_mayor', 'stock_critico'
    ]);

    if (filtro === 'conteo_total') {
        return {
            productos: [],
            meta: {
                es_conteo:         true,
                total_encontrados: resultados.length,
                termino_usado:     terminoUsado,
                termino_original:  termino,
                fue_relajado:      terminoUsado !== termino,
            }
        };
    }

    if (!FILTROS_SIN_UMBRAL.has(filtro) && resultados.length > UMBRAL) {
        return {
            productos: [],
            meta: {
                demasiados:        true,
                total_encontrados: resultados.length,
                termino_usado:     terminoUsado,
                termino_original:  termino,
                fue_relajado:      terminoUsado !== termino,
            }
        };
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

        // Match numérico:
        //   - 1 token numérico  → OR  (ej. "29" puede ser aro 29, 29cc, etc.)
        //   - 2+ tokens numéricos → AND (ej. "29 2.10" es medida compuesta,
        //     deben estar AMBOS en el nombre para evitar 166 resultados falsos)
        if (tokensNum.length === 1) {
            if (!valNombre.includes(tokensNum[0])) return false;
        } else if (tokensNum.length > 1) {
            if (!tokensNum.every(t => valNombre.includes(t))) return false;
        }

        // Filtro de stock crítico (≤ 3 unidades)
        // Usa _stock_real si está disponible, sino cae al campo del mapeo
        if (filtro === 'stock_critico') {
            const stockVal = art._stock_real !== null && art._stock_real !== undefined
                ? art._stock_real
                : parseFloat(art[K.stock] || 0);
            return stockVal <= 3;
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
            // Ordena por precio desc. El umbral ya garantiza ≤ 15 resultados.
            return r.sort((a, b) => parseFloat(b[K.precio] || 0) - parseFloat(a[K.precio] || 0));
        case 'menor_valor':
            return r.sort((a, b) => parseFloat(a[K.precio] || 0) - parseFloat(b[K.precio] || 0));
        case 'stock_mayor':
            return r.sort((a, b) => {
                const sa = a._stock_real ?? parseFloat(a[K.stock] || 0);
                const sb = b._stock_real ?? parseFloat(b[K.stock] || 0);
                return sb - sa;
            });
        case 'stock_critico':
            // stock_critico muestra todos sin límite (son los urgentes)
            return r.sort((a, b) => {
                const sa = a._stock_real ?? parseFloat(a[K.stock] || 0);
                const sb = b._stock_real ?? parseFloat(b[K.stock] || 0);
                return sa - sb;
            });
        default:
            return r;
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
// Acepta la URL de artículos y opcionalmente la de stock.
// =============================================================================
function invalidarCache(erpUrl, stockUrl = null) {
    erpCache.delete(erpUrl);
    if (stockUrl) erpCache.delete(stockUrl);
}

module.exports = { buscarEnERP, invalidarCache };