// backend/services/textUtils.service.js
//
// Utilidades de texto compartidas por el motor de búsqueda ERP
// y el extractor de intención.

'use strict';

// =============================================================================
// NORMALIZACIÓN: quita tildes, pasa a minúsculas
// =============================================================================
function normalize(text) {
    if (!text) return '';
    return String(text)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // quita diacríticos
        .toLowerCase()
        .trim();
}

// =============================================================================
// STOP WORDS: basura gramatical del español + términos genéricos del rubro
// (las stop words de rubro vienen del business_context en BD,
//  estas son las universales del idioma)
// =============================================================================
const STOP_WORDS = new Set([
    'de', 'para', 'el', 'la', 'los', 'las', 'con', 'sin',
    'en', 'un', 'una', 'unos', 'unas', 'y', 'o', 'a',
    'que', 'del', 'al', 'por', 'se', 'su', 'es',
]);

function removeStopWords(tokens) {
    return tokens
        .filter(t => t.length > 1 && !STOP_WORDS.has(t))
        .map(t => t.endsWith('s') && t.length > 3 ? t.slice(0, -1) : t); // corte simple de plural
}

// =============================================================================
// DISTANCIA DE LEVENSHTEIN (fuzzy match para errores de tipeo)
// =============================================================================
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

module.exports = { normalize, removeStopWords, levenshtein };