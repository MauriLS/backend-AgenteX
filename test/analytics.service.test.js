// backend/__tests__/analytics.service.test.js
//
// Pruebas para analytics.service.js
// Mockea fetch global para dos destinos distintos:
//   - erpUrl                → datos del ERP (instalaciones)
//   - DEEPSEEK_API_URL      → extractor de rango (LLM auxiliar)
// Cada test usa companyId único para evitar colisiones de caché (TTL 5 min).

'use strict';

const { consultarAnalitica, formatearAnaliticsParaLLM, invalidarCache } = require('../services/analytics.service');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const ERP_URL = 'http://erp.test/instalaciones';

const ERP_MAPPING = {
    id: 'id',
    fecha: 'fecha_orden',
    categoria: 'tipo_servicio',
    precio: 'ingreso_clp',
    costo: 'costo_materiales',
    tecnico: 'tecnico_asignado',
    comuna: 'comuna',
};

let companyCounter = 5000;
function nextCompanyId() {
    return companyCounter++;
}

// =============================================================================
// HELPERS DE MOCK
// =============================================================================

/** Respuesta del extractor de rango (LLM auxiliar de DeepSeek) */
function deepseekRangoResponse(fechaInicio, fechaFin) {
    return {
        ok: true,
        json: async () => ({
            choices: [{ message: { content: JSON.stringify({ fecha_inicio: fechaInicio, fecha_fin: fechaFin }) } }],
        }),
    };
}

/**
 * Mock de fetch que responde:
 *  - erpUrl        → registros del ERP
 *  - DEEPSEEK_API_URL → rango (fechaInicio/fechaFin pueden ser null)
 */
function mockFetch({ erpUrl = ERP_URL, registros, fechaInicio = null, fechaFin = null, erpOk = true, deepseekOk = true }) {
    global.fetch = jest.fn((url) => {
        if (url === erpUrl) {
            if (!erpOk) return Promise.resolve({ ok: false, status: 500 });
            return Promise.resolve({ ok: true, json: async () => registros });
        }
        if (url === DEEPSEEK_API_URL) {
            if (!deepseekOk) return Promise.resolve({ ok: false, status: 500 });
            return Promise.resolve(deepseekRangoResponse(fechaInicio, fechaFin));
        }
        return Promise.resolve({ ok: false, status: 404 });
    });
}

function generarRegistro(overrides = {}) {
    return {
        id: String(overrides.id ?? 1),
        fecha_orden: overrides.fecha_orden ?? '2025-09-15T10:00:00.000Z',
        tipo_servicio: overrides.tipo_servicio ?? 'PLUS',
        ingreso_clp: overrides.ingreso_clp ?? '10000',
        costo_materiales: overrides.costo_materiales ?? '5000',
        tecnico_asignado: overrides.tecnico_asignado ?? 'Tecnico A',
        comuna: overrides.comuna ?? 'Santiago',
    };
}

afterEach(() => {
    jest.restoreAllMocks();
});

// =============================================================================
// MODO CRUDO — sin rango, bajo volumen
// =============================================================================
describe('consultarAnalitica() — modo crudo', () => {
    test('sin referencia temporal → rango null y devuelve todos los registros crudos', async () => {
        const registros = [
            generarRegistro({ id: 1, fecha_orden: '2025-09-01T00:00:00.000Z' }),
            generarRegistro({ id: 2, fecha_orden: '2025-09-15T00:00:00.000Z' }),
        ];
        mockFetch({ registros, fechaInicio: null, fechaFin: null });

        const { registros: out, agregado, meta } = await consultarAnalitica({
            mensaje: 'cuántas instalaciones tenemos',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.modo).toBe('crudo');
        expect(meta.rango).toBeNull();
        expect(meta.total_base).toBe(2);
        expect(meta.filtrados).toBe(2);
        expect(out).toHaveLength(2);
        expect(agregado).toBeNull();
    });

    test('con rango detectado → filtra solo los registros dentro del período', async () => {
        const registros = [
            generarRegistro({ id: 1, fecha_orden: '2025-08-15T00:00:00.000Z' }), // fuera de rango
            generarRegistro({ id: 2, fecha_orden: '2025-09-10T00:00:00.000Z' }), // dentro
            generarRegistro({ id: 3, fecha_orden: '2025-09-25T00:00:00.000Z' }), // dentro
            generarRegistro({ id: 4, fecha_orden: '2025-10-05T00:00:00.000Z' }), // fuera de rango
        ];
        mockFetch({ registros, fechaInicio: '2025-09-01', fechaFin: '2025-09-30' });

        const { registros: out, meta } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.modo).toBe('crudo');
        expect(meta.rango).toEqual({ fecha_inicio: '2025-09-01', fecha_fin: '2025-09-30' });
        expect(meta.total_base).toBe(4);
        expect(meta.filtrados).toBe(2);
        expect(out.map(r => r.id).sort()).toEqual(['2', '3']);
    });

    test('rango sin coincidencias → 0 registros filtrados, modo crudo', async () => {
        const registros = [
            generarRegistro({ id: 1, fecha_orden: '2025-01-15T00:00:00.000Z' }),
        ];
        mockFetch({ registros, fechaInicio: '2025-09-01', fechaFin: '2025-09-30' });

        const { registros: out, meta } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.filtrados).toBe(0);
        expect(out).toHaveLength(0);
        expect(meta.modo).toBe('crudo');
    });
});

// =============================================================================
// MODO AGREGADO — alto volumen (> 300)
// =============================================================================
describe('consultarAnalitica() — modo agregado (pre-agregación dinámica)', () => {
    test('más de 300 registros filtrados → modo agregado con agregaciones por dimensión', async () => {
        // 301 registros, todos en septiembre 2025, dos técnicos
        const registros = Array.from({ length: 301 }, (_, i) => generarRegistro({
            id: i + 1,
            fecha_orden: '2025-09-10T00:00:00.000Z',
            tecnico_asignado: i % 2 === 0 ? 'Tecnico A' : 'Tecnico B',
            tipo_servicio: i % 3 === 0 ? 'PLUS' : 'BASICO',
            ingreso_clp: '10000',
            costo_materiales: '4000',
        }));
        mockFetch({ registros, fechaInicio: '2025-09-01', fechaFin: '2025-09-30' });

        const { registros: out, agregado, meta } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.modo).toBe('agregado');
        expect(meta.filtrados).toBe(301);
        expect(out).toBeNull();
        expect(agregado).not.toBeNull();

        // Dimensiones de texto detectadas
        expect(agregado.campos_texto).toEqual(
            expect.arrayContaining(['tipo_servicio', 'tecnico_asignado', 'comuna'])
        );
        // Campos numéricos detectados
        expect(agregado.campos_numericos).toEqual(
            expect.arrayContaining(['ingreso_clp', 'costo_materiales'])
        );

        // Agregación por técnico — 2 grupos
        const porTecnico = agregado.agregaciones.tecnico_asignado;
        expect(porTecnico).toHaveLength(2);

        const tecnicoA = porTecnico.find(g => g._dimension === 'Tecnico A');
        const tecnicoB = porTecnico.find(g => g._dimension === 'Tecnico B');
        // 301 registros alternando 0,1,0,1... → A tiene 151, B tiene 150
        expect(tecnicoA._count + tecnicoB._count).toBe(301);
        expect(tecnicoA.ingreso_clp_suma).toBe(tecnicoA._count * 10000);
    });

    test('resumen global suma y promedia correctamente los campos numéricos', async () => {
        const registros = Array.from({ length: 305 }, (_, i) => generarRegistro({
            id: i + 1,
            fecha_orden: '2025-09-10T00:00:00.000Z',
            ingreso_clp: '1000',
            costo_materiales: '500',
        }));
        mockFetch({ registros, fechaInicio: '2025-09-01', fechaFin: '2025-09-30' });

        const { agregado } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(agregado.global._total_registros).toBe(305);
        expect(agregado.global.ingreso_clp_suma).toBe(305 * 1000);
        expect(agregado.global.ingreso_clp_promedio).toBeCloseTo(1000);
        expect(agregado.global.costo_materiales_suma).toBe(305 * 500);
    });

    test('exactamente 300 registros NO activa el modo agregado (límite inclusive)', async () => {
        const registros = Array.from({ length: 300 }, (_, i) => generarRegistro({
            id: i + 1,
            fecha_orden: '2025-09-10T00:00:00.000Z',
        }));
        mockFetch({ registros, fechaInicio: '2025-09-01', fechaFin: '2025-09-30' });

        const { meta, registros: out, agregado } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.modo).toBe('crudo');
        expect(out).toHaveLength(300);
        expect(agregado).toBeNull();
    });
});

// =============================================================================
// MANEJO DE ERRORES
// =============================================================================
describe('consultarAnalitica() — manejo de errores', () => {
    test('si el endpoint del ERP falla, devuelve meta.error sin lanzar excepción', async () => {
        mockFetch({ registros: [], erpOk: false });

        const { registros, agregado, meta } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(registros).toBeNull();
        expect(agregado).toBeNull();
        expect(meta.error).toBeDefined();
    });

    test('si el ERP no devuelve un array, devuelve meta.error', async () => {
        global.fetch = jest.fn((url) => {
            if (url === ERP_URL + '/no-array') {
                return Promise.resolve({ ok: true, json: async () => ({ no: 'array' }) });
            }
            return Promise.resolve({ ok: false, status: 404 });
        });

        const { registros, meta } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL + '/no-array',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(registros).toBeNull();
        expect(meta.error).toContain('no devolvió un array');
    });

    test('si el extractor de rango (DeepSeek) falla, rango queda null y no filtra', async () => {
        const registros = [
            generarRegistro({ id: 1, fecha_orden: '2025-01-01T00:00:00.000Z' }),
            generarRegistro({ id: 2, fecha_orden: '2025-09-01T00:00:00.000Z' }),
        ];
        mockFetch({ registros, deepseekOk: false });

        const { registros: out, meta } = await consultarAnalitica({
            mensaje: 'ventas de septiembre',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.rango).toBeNull();
        expect(meta.filtrados).toBe(2); // sin filtro, todos pasan
        expect(out).toHaveLength(2);
    });

    test('si el extractor de rango devuelve JSON inválido, rango queda null', async () => {
        const registros = [generarRegistro({ id: 1 })];
        global.fetch = jest.fn((url) => {
            if (url === ERP_URL) return Promise.resolve({ ok: true, json: async () => registros });
            if (url === DEEPSEEK_API_URL) {
                return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'esto no es json' } }] }) });
            }
            return Promise.resolve({ ok: false, status: 404 });
        });

        const { meta } = await consultarAnalitica({
            mensaje: 'ventas',
            erpUrl: ERP_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.rango).toBeNull();
    });
});

// =============================================================================
// CACHÉ
// =============================================================================
describe('consultarAnalitica() — caché por companyId:url', () => {
    test('segunda consulta con mismo companyId y url no vuelve a fetchear el ERP', async () => {
        const registros = [generarRegistro({ id: 1 })];
        mockFetch({ registros, fechaInicio: null, fechaFin: null });

        const companyId = nextCompanyId();
        const params = { mensaje: 'cuántas instalaciones tenemos', erpUrl: ERP_URL, erpMapping: ERP_MAPPING, companyId };

        await consultarAnalitica(params);
        const erpCallsAfterFirst = global.fetch.mock.calls.filter(c => c[0] === ERP_URL).length;

        await consultarAnalitica({ ...params, mensaje: 'cuántas instalaciones hay en total' });
        const erpCallsAfterSecond = global.fetch.mock.calls.filter(c => c[0] === ERP_URL).length;

        expect(erpCallsAfterFirst).toBe(1);
        expect(erpCallsAfterSecond).toBe(1); // cache hit — no nuevo fetch al ERP
    });
});

// =============================================================================
// formatearAnaliticsParaLLM()
// =============================================================================
describe('formatearAnaliticsParaLLM()', () => {
    test('caso error → mensaje de error para el LLM', () => {
        const out = formatearAnaliticsParaLLM(null, null, { error: 'conexión falló' }, ERP_MAPPING);
        expect(out).toContain('ERROR: conexión falló');
    });

    test('modo crudo → incluye los registros como JSON y guía de campos', () => {
        const registros = [generarRegistro({ id: 1 })];
        const meta = { modo: 'crudo', filtrados: 1, total_base: 1, rango: { fecha_inicio: '2025-09-01', fecha_fin: '2025-09-30' } };

        const out = formatearAnaliticsParaLLM(registros, null, meta, ERP_MAPPING);

        expect(out).toContain('2025-09-01 al 2025-09-30');
        expect(out).toContain('REGISTROS COMPLETOS DEL PERÍODO');
        expect(out).toContain('"tipo_servicio" significa categoria');
        expect(out).toContain(JSON.stringify(registros));
    });

    test('modo crudo sin rango → "todos los registros disponibles"', () => {
        const registros = [generarRegistro({ id: 1 })];
        const meta = { modo: 'crudo', filtrados: 1, total_base: 1, rango: null };

        const out = formatearAnaliticsParaLLM(registros, null, meta, ERP_MAPPING);

        expect(out).toContain('todos los registros disponibles');
    });

    test('modo agregado → incluye agregaciones por dimensión y resumen global', () => {
        const agregado = {
            campos_numericos: ['ingreso_clp'],
            campos_texto: ['tecnico_asignado'],
            agregaciones: {
                tecnico_asignado: [
                    { _dimension: 'Tecnico A', _count: 10, ingreso_clp_suma: 100000 },
                    { _dimension: 'Tecnico B', _count: 5,  ingreso_clp_suma: 50000 },
                ],
            },
            global: { _total_registros: 15, ingreso_clp_suma: 150000, ingreso_clp_promedio: 10000 },
        };
        const meta = { modo: 'agregado', filtrados: 15, total_base: 15, rango: null };

        const out = formatearAnaliticsParaLLM(null, agregado, meta, ERP_MAPPING);

        expect(out).toContain('DATOS PRE-AGREGADOS');
        expect(out).toContain('POR TECNICO_ASIGNADO');
        expect(out).toContain('Tecnico A → 10 registros');
        expect(out).toContain('RESUMEN GLOBAL');
        expect(out).toContain('ingreso_clp_total: 150000.00');
        expect(out).toContain('ingreso_clp_promedio: 10000.00');
    });

    test('siempre incluye la ORDEN ABSOLUTA anti-alucinación al final', () => {
        const registros = [generarRegistro({ id: 1 })];
        const meta = { modo: 'crudo', filtrados: 1, total_base: 1, rango: null };

        const out = formatearAnaliticsParaLLM(registros, null, meta, ERP_MAPPING);

        expect(out).toContain('ORDEN ABSOLUTA: Solo menciona datos que aparezcan explícitamente arriba.');
    });

    test('sin erpMapping no incluye sección de guía de campos', () => {
        const registros = [generarRegistro({ id: 1 })];
        const meta = { modo: 'crudo', filtrados: 1, total_base: 1, rango: null };

        const out = formatearAnaliticsParaLLM(registros, null, meta, {});

        expect(out).not.toContain('Guía de campos');
    });
});

// =============================================================================
// invalidarCache()
// =============================================================================
describe('invalidarCache()', () => {
    test('no lanza error al invalidar una URL no cacheada', () => {
        expect(() => invalidarCache('http://erp.test/no-existe')).not.toThrow();
    });
});