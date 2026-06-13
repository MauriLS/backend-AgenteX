

'use strict';

const { normalize, removeStopWords, levenshtein } = require('../services/text-utils.service');

// =============================================================================
// normalize()
// =============================================================================
describe('normalize()', () => {
    test('quita tildes', () => {
        expect(normalize('neumático')).toBe('neumatico');
    });

    test('convierte a minúsculas', () => {
        expect(normalize('NEUMATICO')).toBe('neumatico');
    });

    test('quita espacios al inicio y final', () => {
        expect(normalize('  bicicleta  ')).toBe('bicicleta');
    });

    test('combina tildes, mayúsculas y espacios', () => {
        expect(normalize('  Cámara DE Aire  ')).toBe('camara de aire');
    });

    test('devuelve string vacío si recibe null', () => {
        expect(normalize(null)).toBe('');
    });

    test('devuelve string vacío si recibe undefined', () => {
        expect(normalize(undefined)).toBe('');
    });

    test('devuelve string vacío si recibe string vacío', () => {
        expect(normalize('')).toBe('');
    });

    test('convierte números a string sin alterarlos', () => {
        expect(normalize(29)).toBe('29');
    });

    test('maneja múltiples vocales con tilde', () => {
        expect(normalize('ÁÉÍÓÚ')).toBe('aeiou');
    });

    test('la ñ se normaliza a n (NFKD descompone la tilde combinante)', () => {
        // Comportamiento correcto: permite que "niño" y "nino" sean equivalentes
        // en la búsqueda — más permisivo para el usuario.
        expect(normalize('Niño')).toBe('nino');
    });
});

// =============================================================================
// removeStopWords()
// =============================================================================
describe('removeStopWords()', () => {
    test('elimina stop words comunes del español', () => {
        expect(removeStopWords(['el', 'neumatico', 'de', 'la', 'bicicleta']))
            .toEqual(['neumatico', 'bicicleta']);
    });

    test('elimina palabras de un solo caracter', () => {
        expect(removeStopWords(['a', 'y', 'o', 'bicicleta']))
            .toEqual(['bicicleta']);
    });

    test('recorta plurales simples en palabras largas (>3 chars terminadas en s)', () => {
        expect(removeStopWords(['neumaticos']))
            .toEqual(['neumatico']);
    });

    test('no recorta palabras cortas terminadas en s (longitud <= 3)', () => {
        expect(removeStopWords(['mas']))
            .toEqual(['mas']);
    });

    test('no recorta si la palabra no termina en s', () => {
        expect(removeStopWords(['bicicleta']))
            .toEqual(['bicicleta']);
    });

    test('devuelve array vacío si todos los tokens son stop words', () => {
        expect(removeStopWords(['el', 'la', 'de', 'a']))
            .toEqual([]);
    });

    test('devuelve array vacío si el input es vacío', () => {
        expect(removeStopWords([]))
            .toEqual([]);
    });

    test('mantiene tokens numéricos intactos', () => {
        expect(removeStopWords(['29', '2.10']))
            .toEqual(['29', '2.10']);
    });

    test('caso real: "el neumatico de bicicletas mtb" → ["neumatico","bicicleta","mtb"]', () => {
        const tokens = 'el neumatico de bicicletas mtb'.split(' ');
        expect(removeStopWords(tokens)).toEqual(['neumatico', 'bicicleta', 'mtb']);
    });
});

// =============================================================================
// levenshtein()
// =============================================================================
describe('levenshtein()', () => {
    test('distancia 0 para strings idénticos', () => {
        expect(levenshtein('neumatico', 'neumatico')).toBe(0);
    });

    test('distancia 1 por una letra agregada (plural simple)', () => {
        expect(levenshtein('neumatico', 'neumaticos')).toBe(1);
    });

    test('distancia 1 por una letra distinta', () => {
        expect(levenshtein('casa', 'casa'.replace('s', 'z'))).toBe(1);
    });

    test('distancia 1 por una letra eliminada', () => {
        expect(levenshtein('bicicleta', 'biciceta')).toBe(1);
    });

    test('distancia mayor para palabras completamente distintas', () => {
        expect(levenshtein('neumatico', 'llanta')).toBeGreaterThan(5);
    });

    test('distancia respecto a string vacío es igual a la longitud del otro string', () => {
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', '')).toBe(3);
    });

    test('distancia entre dos strings vacíos es 0', () => {
        expect(levenshtein('', '')).toBe(0);
    });

    test('es simétrica: levenshtein(a,b) === levenshtein(b,a)', () => {
        expect(levenshtein('camara', 'camera')).toBe(levenshtein('camera', 'camara'));
    });

    test('detecta error de tipeo típico dentro del umbral de fuzzy match (<= 2)', () => {
        // "neumatico" vs "neumattico" (letra duplicada)
        expect(levenshtein('neumatico', 'neumattico')).toBeLessThanOrEqual(2);
    });
});