// backend/__tests__/sales-search.service.test.js
//
// Pruebas para sales-search.service.js
//
// Mocks:
//   - erp-search.service::buscarEnERP → jest.mock (no toca red real del ERP)
//   - global.fetch → responde según URL:
//       CLIENTES_URL      → lista de clientes
//       HISTORIAL_URL     → historial de compras
//       DEEPSEEK_API_URL  → identificación de cliente (LLM auxiliar)

'use strict';

jest.mock('../services/erp-search.service');
const { buscarEnERP } = require('../services/erp-search.service');

const {
    buscarParaVentas,
    formatearVentasParaLLM,
    invalidarCache,
} = require('../services/sales-search.service');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const CLIENTES_URL     = 'https://mockapi.test/clientes';
const HISTORIAL_URL    = 'https://mockapi.test/historial';

const ERP_MAPPING = {
    id: 'id',
    nombre: 'articulo',
    precio: 'precio_tienda',
    descripcion: 'descripcion',
    sku: 'sku',
    clientes_url: CLIENTES_URL,
    historial_url: HISTORIAL_URL,
    cliente_id_campo: 'rut',
    clientes_nombre: 'name',
};

const CLIENTES = [
    { id: '1', rut: '18.452.781-3', name: 'Leonard Schinner', segmento: 'Ciclismo Urbano', presupuesto_habitual: 185000 },
    { id: '2', rut: '12.345.678-9', name: 'Juan Perez',       segmento: 'MTB' },
    { id: '3', rut: '98.765.432-1', name: 'Juan Rodriguez',   segmento: 'Ruta' },
];

const HISTORIAL = [
    { cliente_id: '1', fecha_compra: '2025-03-15', producto: 'Neumatico 29' },
    { cliente_id: '1', fecha_compra: '2025-01-10', producto: 'Casco' },
    { cliente_id: '2', fecha_compra: '2025-02-01', producto: 'Bicicleta' },
];

let companyCounter = 9000;
function nextCompanyId() {
    return companyCounter++;
}

// =============================================================================
// HELPER DE MOCK PARA fetch GLOBAL
// =============================================================================
function mockFetchVentas({
    clientes      = CLIENTES,
    historial     = HISTORIAL,
    deepseekBody  = { estado: 'no_encontrado' },
    clientesOk    = true,
    historialOk   = true,
    deepseekOk    = true,
    clientesUrl   = CLIENTES_URL,
    historialUrl  = HISTORIAL_URL,
}) {
    global.fetch = jest.fn((url) => {
        if (url === clientesUrl) {
            if (!clientesOk) return Promise.resolve({ ok: false, status: 500 });
            return Promise.resolve({ ok: true, json: async () => clientes });
        }
        if (url === historialUrl) {
            if (!historialOk) return Promise.resolve({ ok: false, status: 500 });
            return Promise.resolve({ ok: true, json: async () => historial });
        }
        if (url === DEEPSEEK_API_URL) {
            if (!deepseekOk) return Promise.resolve({ ok: false, status: 500 });
            return Promise.resolve({
                ok: true,
                json: async () => ({ choices: [{ message: { content: JSON.stringify(deepseekBody) } }] }),
            });
        }
        return Promise.resolve({ ok: false, status: 404 });
    });
}

beforeEach(() => {
    buscarEnERP.mockReset();
    buscarEnERP.mockResolvedValue({ productos: [], meta: {} });
});

afterEach(() => {
    jest.restoreAllMocks();
});

// =============================================================================
// IDENTIFICACIÓN DE CLIENTE — estados
// =============================================================================
describe('buscarParaVentas() — identificación de cliente', () => {
    test('estado "encontrado" → perfilCliente incluye datos + historial_compras', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'encontrado', cliente_id: '1' } });

        const { identificacion, perfilCliente, totalClientes } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(identificacion.estado).toBe('encontrado');
        expect(totalClientes).toBe(3);
        expect(perfilCliente).not.toBeNull();
        expect(perfilCliente.name).toBe('Leonard Schinner');
        expect(perfilCliente.historial_compras).toHaveLength(2);
    });

    test('historial_compras ordenado por fecha descendente', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'encontrado', cliente_id: '1' } });

        const { perfilCliente } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        const fechas = perfilCliente.historial_compras.map(h => h.fecha_compra);
        expect(fechas[0]).toBe('2025-03-15'); // más reciente primero
        expect(fechas[1]).toBe('2025-01-10');
    });

    test('historial_compras se limita a los 10 más recientes', async () => {
        const historialLargo = Array.from({ length: 15 }, (_, i) => ({
            cliente_id: '1',
            fecha_compra: `2025-01-${String(i + 1).padStart(2, '0')}`,
            producto: `Producto ${i}`,
        }));
        mockFetchVentas({
            historial: historialLargo,
            deepseekBody: { estado: 'encontrado', cliente_id: '1' },
        });

        const { perfilCliente } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(perfilCliente.historial_compras).toHaveLength(10);
        // El más reciente (día 15) debe ser el primero
        expect(perfilCliente.historial_compras[0].fecha_compra).toBe('2025-01-15');
    });

    test('estado "ambiguo" → devuelve candidatos y perfilCliente null', async () => {
        const candidatos = [
            { id: '2', nombre: 'Juan Perez',    segmento: 'MTB' },
            { id: '3', nombre: 'Juan Rodriguez', segmento: 'Ruta' },
        ];
        mockFetchVentas({ deepseekBody: { estado: 'ambiguo', candidatos } });

        const { identificacion, perfilCliente, candidatos: cand } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Juan',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(identificacion.estado).toBe('ambiguo');
        expect(perfilCliente).toBeNull();
        expect(cand).toEqual(candidatos);
    });

    test('estado "no_encontrado" → perfilCliente null y candidatos null', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'no_encontrado' } });

        const { identificacion, perfilCliente, candidatos } = await buscarParaVentas({
            mensaje: 'Dame los clientes que más compran',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(identificacion.estado).toBe('no_encontrado');
        expect(perfilCliente).toBeNull();
        expect(candidatos).toBeNull();
    });

    test('lista de clientes vacía → extraerCliente devuelve no_encontrado sin llamar a DeepSeek', async () => {
        mockFetchVentas({ clientes: [], deepseekBody: { estado: 'encontrado', cliente_id: '1' } });

        const { identificacion, totalClientes } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(identificacion.estado).toBe('no_encontrado');
        expect(totalClientes).toBe(0);

        // No debe haberse llamado a DeepSeek (lista vacía → early return)
        const deepseekCalls = global.fetch.mock.calls.filter(c => c[0] === DEEPSEEK_API_URL);
        expect(deepseekCalls).toHaveLength(0);
    });
});

// =============================================================================
// PRODUCTOS — integración con buscarEnERP
// =============================================================================
describe('buscarParaVentas() — búsqueda de productos', () => {
    test('término vacío → no llama a buscarEnERP, productos vacíos', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'no_encontrado' } });

        const { productos, metaProductos } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(buscarEnERP).not.toHaveBeenCalled();
        expect(productos).toEqual([]);
        expect(metaProductos).toEqual({});
    });

    test('término no vacío → llama a buscarEnERP y propaga productos', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'no_encontrado' } });
        const productosERP = [{ id: 1, articulo: 'Neumatico 29', precio_tienda: 32990, sku: 'NEU-001' }];
        buscarEnERP.mockResolvedValue({ productos: productosERP, meta: { total_encontrados: 1 } });

        const { productos, metaProductos } = await buscarParaVentas({
            mensaje: 'Tienen neumaticos 29?',
            termino: 'neumatico 29',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({
            termino: 'neumatico 29',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
        }));
        expect(productos).toEqual(productosERP);
        expect(metaProductos.total_encontrados).toBe(1);
    });

    test('si buscarEnERP lanza error, productos queda vacío con meta.error', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'no_encontrado' } });
        buscarEnERP.mockRejectedValue(new Error('ERP caído'));

        const { productos, metaProductos } = await buscarParaVentas({
            mensaje: 'Tienen neumaticos 29?',
            termino: 'neumatico 29',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toEqual([]);
        expect(metaProductos.error).toBe('ERP caído');
    });
});

// =============================================================================
// MANEJO DE ENDPOINTS DE CLIENTES/HISTORIAL
// =============================================================================
describe('buscarParaVentas() — endpoints clientes/historial', () => {
    test('clientes_url no configurado → clientes vacío, no_encontrado', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'no_encontrado' } });

        const mappingSinClientes = { ...ERP_MAPPING, clientes_url: null };
        const { totalClientes, identificacion } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: mappingSinClientes,
            companyId: nextCompanyId(),
        });

        expect(totalClientes).toBe(0);
        expect(identificacion.estado).toBe('no_encontrado');
    });

    test('si clientes_url falla, clientes queda vacío sin lanzar excepción', async () => {
        mockFetchVentas({ clientesOk: false, deepseekBody: { estado: 'no_encontrado' } });

        const { totalClientes } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(totalClientes).toBe(0);
    });

    test('si historial_url falla, perfilCliente.historial_compras queda vacío', async () => {
        mockFetchVentas({ historialOk: false, deepseekBody: { estado: 'encontrado', cliente_id: '1' } });

        const { perfilCliente } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(perfilCliente).not.toBeNull();
        expect(perfilCliente.historial_compras).toEqual([]);
    });

    test('caché: misma companyId + mismas URLs → segunda llamada no re-fetchea clientes/historial', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'no_encontrado' } });
        const companyId = nextCompanyId();
        const params = {
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId,
        };

        await buscarParaVentas(params);
        const clientesCallsAfterFirst  = global.fetch.mock.calls.filter(c => c[0] === CLIENTES_URL).length;
        const historialCallsAfterFirst = global.fetch.mock.calls.filter(c => c[0] === HISTORIAL_URL).length;

        await buscarParaVentas({ ...params, mensaje: 'Dame el perfil de Juan' });
        const clientesCallsAfterSecond  = global.fetch.mock.calls.filter(c => c[0] === CLIENTES_URL).length;
        const historialCallsAfterSecond = global.fetch.mock.calls.filter(c => c[0] === HISTORIAL_URL).length;

        expect(clientesCallsAfterFirst).toBe(1);
        expect(clientesCallsAfterSecond).toBe(1);  // cache hit
        expect(historialCallsAfterFirst).toBe(1);
        expect(historialCallsAfterSecond).toBe(1); // cache hit
    });
});

// =============================================================================
// DESAMBIGUACIÓN — candidatos previos
// =============================================================================
describe('buscarParaVentas() — desambiguación con candidatos previos', () => {
    test('si el último turno del asistente pidió desambiguación, usa _candidatos_previos en la lista para DeepSeek', async () => {
        mockFetchVentas({ deepseekBody: { estado: 'encontrado', cliente_id: '2' } });

        const candidatosPrevios = [
            { id: '2', nombre: 'Juan Perez',    segmento: 'MTB' },
            { id: '3', nombre: 'Juan Rodriguez', segmento: 'Ruta' },
        ];

        const historialConversacion = [
            { role: 'user',      content: 'Dame el perfil de Juan' },
            { role: 'assistant', content: '¿A cuál de estos clientes te refieres?' },
        ];

        await buscarParaVentas({
            mensaje: 'El primero',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: { ...ERP_MAPPING, _candidatos_previos: candidatosPrevios },
            historialConversacion,
            companyId: nextCompanyId(),
        });

        // Verificar que el body enviado a DeepSeek incluye la lista reducida de candidatos
        const deepseekCall = global.fetch.mock.calls.find(c => c[0] === DEEPSEEK_API_URL);
        const body = JSON.parse(deepseekCall[1].body);
        const systemMsg = body.messages.find(m => m.role === 'system').content;

        expect(systemMsg).toContain('Juan Perez');
        expect(systemMsg).toContain('Juan Rodriguez');
        expect(systemMsg).not.toContain('Leonard Schinner'); // candidato no incluido
        expect(systemMsg).toContain('respondiendo a una selección previa');
    });
});

// =============================================================================
// ERRORES DEL EXTRACTOR DE CLIENTE (DeepSeek)
// =============================================================================
describe('buscarParaVentas() — errores del identificador de cliente', () => {
    test('si DeepSeek falla (HTTP error), identificacion.estado = "error"', async () => {
        mockFetchVentas({ deepseekOk: false });

        const { identificacion, perfilCliente } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(identificacion.estado).toBe('error');
        expect(perfilCliente).toBeNull();
    });

    test('si DeepSeek devuelve JSON inválido, identificacion.estado = "error"', async () => {
        global.fetch = jest.fn((url) => {
            if (url === CLIENTES_URL)  return Promise.resolve({ ok: true, json: async () => CLIENTES });
            if (url === HISTORIAL_URL) return Promise.resolve({ ok: true, json: async () => HISTORIAL });
            if (url === DEEPSEEK_API_URL) {
                return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'no es json' } }] }) });
            }
            return Promise.resolve({ ok: false, status: 404 });
        });

        const { identificacion } = await buscarParaVentas({
            mensaje: 'Dame el perfil de Leonard',
            termino: '',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/articulos',
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(identificacion.estado).toBe('error');
    });
});

// =============================================================================
// formatearVentasParaLLM()
// =============================================================================
describe('formatearVentasParaLLM()', () => {
    test('estado "ambiguo" → instruye mostrar tabla de candidatos y no continuar', () => {
        const identificacion = {
            estado: 'ambiguo',
            candidatos: [
                { id: '2', nombre: 'Juan Perez', segmento: 'MTB' },
                { id: '3', nombre: 'Juan Rodriguez', segmento: 'Ruta' },
            ],
        };

        const out = formatearVentasParaLLM([], {}, identificacion, null, ERP_MAPPING);

        expect(out).toContain('ESTADO: CLIENTE AMBIGUO');
        expect(out).toContain('Se encontraron 2 clientes');
        expect(out).toContain('¿A cuál de estos clientes te refieres?');
        expect(out).toContain('Juan Perez');
    });

    test('estado "no_encontrado" → instruye informar que el cliente no existe', () => {
        const out = formatearVentasParaLLM([], {}, { estado: 'no_encontrado' }, null, ERP_MAPPING);

        expect(out).toContain('ESTADO: CLIENTE NO ENCONTRADO');
        expect(out).toContain('no está registrado en el sistema');
    });

    test('estado "error" → se trata igual que no_encontrado', () => {
        const out = formatearVentasParaLLM([], {}, { estado: 'error', mensaje: 'timeout' }, null, ERP_MAPPING);

        expect(out).toContain('ESTADO: CLIENTE NO ENCONTRADO');
    });

    test('estado "encontrado" → incluye perfil del cliente e instrucciones de asesor', () => {
        const perfilCliente = {
            id: '1', name: 'Leonard Schinner', segmento: 'Ciclismo Urbano',
            presupuesto_habitual: 185000, historial_compras: [],
        };

        const out = formatearVentasParaLLM([], {}, { estado: 'encontrado' }, perfilCliente, ERP_MAPPING);

        expect(out).toContain('PERFIL DEL CLIENTE IDENTIFICADO');
        expect(out).toContain('Leonard Schinner');
        expect(out).toContain('Eres un asesor comercial');
        expect(out).toContain('lenguaje persuasivo');
    });

    test('metaProductos.error → muestra ERROR DE INVENTARIO', () => {
        const out = formatearVentasParaLLM([], { error: 'ERP caído' }, { estado: 'no_encontrado' }, null, ERP_MAPPING);

        expect(out).toContain('ERROR DE INVENTARIO: ERP caído');
    });

    test('metaProductos.demasiados → pide especificar más', () => {
        const meta = { demasiados: true, total_encontrados: 80 };
        const out = formatearVentasParaLLM([], meta, { estado: 'no_encontrado' }, null, ERP_MAPPING);

        expect(out).toContain('BÚSQUEDA AMPLIA: 80 productos');
    });

    test('lista de productos → formatea ID, SKU, nombre, precio y stock', () => {
        const productos = [
            { id: 1, sku: 'NEU-001', articulo: 'Neumatico Maxxis 29x2.10', precio_tienda: 32990, _stock_real: '45', descripcion: 'Neumatico MTB' },
        ];

        const out = formatearVentasParaLLM(productos, { total_encontrados: 1 }, { estado: 'no_encontrado' }, null, ERP_MAPPING);

        expect(out).toContain('PRODUCTOS DISPONIBLES (1)');
        expect(out).toContain('ID: 1 | SKU: NEU-001 | Neumatico Maxxis 29x2.10');
        expect(out).toContain('Precio: $32990 | Stock: 45');
        expect(out).toContain('Descripción: Neumatico MTB');
    });

    test('producto sin _stock_real muestra "N/D"', () => {
        const productos = [{ id: 1, sku: 'NEU-001', articulo: 'Neumatico', precio_tienda: 1000 }];
        const out = formatearVentasParaLLM(productos, {}, { estado: 'no_encontrado' }, null, ERP_MAPPING);

        expect(out).toContain('Stock: N/D');
    });

    test('siempre incluye la ORDEN ABSOLUTA al final', () => {
        const out = formatearVentasParaLLM([], {}, { estado: 'no_encontrado' }, null, ERP_MAPPING);
        expect(out).toContain('ORDEN ABSOLUTA: Solo menciona datos que aparezcan explícitamente en esta sección.');
    });
});

// =============================================================================
// invalidarCache()
// =============================================================================
describe('invalidarCache()', () => {
    test('no lanza error al invalidar una URL no cacheada', () => {
        expect(() => invalidarCache('http://no-existe.test')).not.toThrow();
    });
});