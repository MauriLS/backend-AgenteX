
'use strict';

const { buscarEnERP, invalidarCache } = require('../../services/erp-search.service');

const PRODUCTOS_URL = 'http://erp.test/articulos';
const STOCK_URL     = 'http://erp.test/asignacion-det';

const ERP_MAPPING = {
    id: 'id',
    sku: 'sku',
    nombre: 'articulo',
    precio: 'precio_tienda',
    stock: 'stock_min',
    categoria: 'categoria',
    stock_url: STOCK_URL,
    stock_join_id: 'id_articulo',
    stock_real_key: 'stock_real',
};

const ARTICULOS = [
    { id: 1, sku: 'NEU-001', articulo: 'Neumatico Maxxis 29x2.10', precio_tienda: 32990, stock_min: 45, categoria: 'Neumaticos MTB' },
    { id: 2, sku: 'NEU-002', articulo: 'Neumatico Schwalbe 29x2.25', precio_tienda: 45990, stock_min: 8, categoria: 'Neumaticos MTB' },
    { id: 3, sku: 'NEU-003', articulo: 'Neumatico Continental 26x2.0', precio_tienda: 28990, stock_min: 0, categoria: 'Neumaticos MTB' },
    { id: 4, sku: 'BIC-001', articulo: 'Bicicleta Aro 29 MTB', precio_tienda: 350000, stock_min: 2, categoria: 'Bicicletas' },
];

const STOCK_DATA = [
    { id_articulo: 1, stock_real: '45' },
    { id_articulo: 2, stock_real: '8' },
    { id_articulo: 3, stock_real: '0' },
    { id_articulo: 4, stock_real: '2' },
];

// =============================================================================
// MOCK DE FETCH GLOBAL
// Responde según la URL solicitada — simula el ERP real.
// =============================================================================
function mockFetchOk(productosUrl = PRODUCTOS_URL, productos = ARTICULOS, stockUrl = STOCK_URL, stock = STOCK_DATA) {
    global.fetch = jest.fn((url) => {
        if (url === productosUrl) {
            return Promise.resolve({ ok: true, json: async () => productos });
        }
        if (url === stockUrl) {
            return Promise.resolve({ ok: true, json: async () => stock });
        }
        return Promise.resolve({ ok: false, status: 404 });
    });
}

let companyCounter = 1000;
function nextCompanyId() {
    // companyId único por test → evita colisiones de caché entre tests
    return companyCounter++;
}

afterEach(() => {
    jest.restoreAllMocks();
});

// =============================================================================
// BÚSQUEDA BÁSICA
// =============================================================================
describe('buscarEnERP() — búsqueda básica', () => {
    test('encuentra productos por término exacto', async () => {
        mockFetchOk();
        const { productos, meta } = await buscarEnERP({
            termino: 'neumatico maxxis',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(1);
        expect(productos[0].id).toBe(1);
        expect(meta.fue_relajado).toBe(false);
    });

    test('enriquece productos con _stock_real desde el join', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'neumatico maxxis',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos[0]._stock_real).toBe('45');
    });

    test('fuzzy match — tolera error de tipeo (Levenshtein <= 2)', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            // "maxxiss" en vez de "maxxis" — distancia 1
            termino: 'neumatico maxxiss',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(1);
        expect(productos[0].id).toBe(1);
    });

    test('CERO RESULTADOS — término que no existe en el catálogo', async () => {
        mockFetchOk();
        const { productos, meta } = await buscarEnERP({
            termino: 'motocicleta',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(0);
        expect(meta.total_encontrados).toBe(0);
        expect(meta.termino_original).toBe('motocicleta');
    });

    test('match por SKU exacto', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'NEU-002',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(1);
        expect(productos[0].id).toBe(2);
    });
});

// =============================================================================
// TOKENS NUMÉRICOS — medidas compuestas
// =============================================================================
describe('buscarEnERP() — tokens numéricos', () => {
    test('un solo token numérico usa OR — "29" matchea cualquier producto con 29', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'neumatico 29',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        // Maxxis 29x2.10 y Schwalbe 29x2.25 contienen "29"
        expect(productos.map(p => p.id).sort()).toEqual([1, 2]);
    });

    test('dos tokens numéricos usan AND — medida compuesta exacta', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'neumatico 29 2.10',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        // Solo el Maxxis tiene "29" Y "2.10"
        expect(productos).toHaveLength(1);
        expect(productos[0].id).toBe(1);
    });
});

// =============================================================================
// FILTROS DE ORDENAMIENTO
// =============================================================================
describe('buscarEnERP() — filtros mayor_valor / menor_valor / stock', () => {
    test('filtro "ALL" + mayor_valor devuelve el producto más caro primero', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'ALL',
            filtro: 'mayor_valor',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos[0].id).toBe(4); // Bicicleta $350.000
    });

    test('filtro "ALL" + menor_valor devuelve el producto más barato primero', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'ALL',
            filtro: 'menor_valor',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos[0].id).toBe(3); // Continental $28.990
    });

    test('filtro stock_mayor ordena por _stock_real descendente', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'ALL',
            filtro: 'stock_mayor',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos[0].id).toBe(1); // stock 45 — el mayor
    });

    test('filtro stock_critico devuelve solo productos con stock <= 3', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'ALL',
            filtro: 'stock_critico',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        // Continental (stock 0) y Bicicleta (stock 2)
        expect(productos.map(p => p.id).sort()).toEqual([3, 4]);
    });

    test('conteo_total devuelve es_conteo=true sin productos', async () => {
        mockFetchOk();
        const { productos, meta } = await buscarEnERP({
            termino: 'ALL',
            filtro: 'conteo_total',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(0);
        expect(meta.es_conteo).toBe(true);
        expect(meta.total_encontrados).toBe(4);
    });
});

// =============================================================================
// FILTROS DE RANGO — rango_precio / rango_stock
// =============================================================================
describe('buscarEnERP() — rango_precio y rango_stock', () => {
    test('rango_precio filtra por min y max', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'min:30000 max:50000',
            filtro: 'rango_precio',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        // Maxxis 32990 y Schwalbe 45990 caen en [30000, 50000]
        expect(productos.map(p => p.id).sort()).toEqual([1, 2]);
    });

    test('rango_precio combinado con término de texto y número', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'neumatico 26 min:9000',
            filtro: 'rango_precio',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        // Solo el Continental 26x2.0 ($28.990) tiene "neumatico" + "26"
        expect(productos).toHaveLength(1);
        expect(productos[0].id).toBe(3);
    });

    test('rango_precio ordena ascendente', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'min:20000 max:400000',
            filtro: 'rango_precio',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        const precios = productos.map(p => p.precio_tienda);
        expect(precios).toEqual([...precios].sort((a, b) => a - b));
    });

    test('rango_stock filtra usando _stock_real', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'min:5 max:50',
            filtro: 'rango_stock',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        // stock_real entre 5 y 50 → id 1 (45) y id 2 (8)
        expect(productos.map(p => p.id).sort()).toEqual([1, 2]);
    });

    test('rango_precio sin resultados — fuera de rango', async () => {
        mockFetchOk();
        const { productos } = await buscarEnERP({
            termino: 'min:1000000 max:2000000',
            filtro: 'rango_precio',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(0);
    });

    test('rango_precio y rango_stock no activan el umbral de fricción', async () => {
        // Generamos 60 productos — todos con precio en rango
        const muchosProductos = Array.from({ length: 60 }, (_, i) => ({
            id: i + 1, sku: `SKU-${i}`, articulo: `Producto ${i}`,
            precio_tienda: 10000, stock_min: 10, categoria: 'General',
        }));
        const muchosStock = muchosProductos.map(p => ({ id_articulo: p.id, stock_real: '10' }));

        const url = 'http://erp.test/muchos-articulos';
        const surl = 'http://erp.test/muchos-stock';
        mockFetchOk(url, muchosProductos, surl, muchosStock);

        const { productos, meta } = await buscarEnERP({
            termino: 'min:5000 max:20000',
            filtro: 'rango_precio',
            erpUrl: url,
            erpMapping: { ...ERP_MAPPING, stock_url: surl },
            companyId: nextCompanyId(),
        });

        expect(meta.demasiados).toBeUndefined();
        expect(productos).toHaveLength(60);
    });
});

// =============================================================================
// UMBRAL DE FRICCIÓN
// =============================================================================
describe('buscarEnERP() — umbral de fricción (UMBRAL=50)', () => {
    test('más de 50 resultados con busqueda_general → demasiados:true', async () => {
        const muchosProductos = Array.from({ length: 51 }, (_, i) => ({
            id: i + 1, sku: `SKU-${i}`, articulo: `Repuesto generico ${i}`,
            precio_tienda: 1000, stock_min: 10, categoria: 'General',
        }));

        const url = 'http://erp.test/51-articulos';
        mockFetchOk(url, muchosProductos, 'http://erp.test/no-stock', []);

        const { productos, meta } = await buscarEnERP({
            termino: 'ALL',
            filtro: 'busqueda_general',
            erpUrl: url,
            erpMapping: { ...ERP_MAPPING, stock_url: 'http://erp.test/no-stock' },
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(0);
        expect(meta.demasiados).toBe(true);
        expect(meta.total_encontrados).toBe(51);
    });

    test('exactamente 50 resultados NO activa el umbral (límite inclusive)', async () => {
        const productos50 = Array.from({ length: 50 }, (_, i) => ({
            id: i + 1, sku: `SKU-${i}`, articulo: `Repuesto generico ${i}`,
            precio_tienda: 1000, stock_min: 10, categoria: 'General',
        }));

        const url = 'http://erp.test/50-articulos';
        mockFetchOk(url, productos50, 'http://erp.test/no-stock-2', []);

        const { productos, meta } = await buscarEnERP({
            termino: 'ALL',
            filtro: 'busqueda_general',
            erpUrl: url,
            erpMapping: { ...ERP_MAPPING, stock_url: 'http://erp.test/no-stock-2' },
            companyId: nextCompanyId(),
        });

        expect(meta.demasiados).toBeUndefined();
        expect(productos).toHaveLength(50);
    });
});

// =============================================================================
// FEEDBACK LOOP (fallback de términos)
// =============================================================================
describe('buscarEnERP() — feedback loop (término relajado)', () => {
    test('si el término completo no matchea, reintenta con el primer sustantivo válido', async () => {
        mockFetchOk();
        const { productos, meta } = await buscarEnERP({
            // "zzzzz" no existe → fallback a "neumatico"
            termino: 'neumatico zzzzz',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(meta.fue_relajado).toBe(true);
        expect(meta.termino_usado).toBe('neumatico');
        expect(productos.length).toBeGreaterThan(0);
    });

    test('si ni el término ni el fallback matchean, devuelve cero resultados', async () => {
        mockFetchOk();
        const { productos, meta } = await buscarEnERP({
            termino: 'zzzzzzz wwwwwww',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });

        expect(productos).toHaveLength(0);
        expect(meta.total_encontrados).toBe(0);
    });
});

// =============================================================================
// MANEJO DE ERRORES
// =============================================================================
describe('buscarEnERP() — manejo de errores', () => {
    test('si el endpoint de productos falla, devuelve meta.error sin lanzar excepción', async () => {
        global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500 }));

        const { productos, meta } = await buscarEnERP({
            termino: 'neumatico',
            filtro: 'busqueda_general',
            erpUrl: 'http://erp.test/falla',
            erpMapping: { ...ERP_MAPPING, stock_url: null },
            companyId: nextCompanyId(),
        });

        expect(productos).toEqual([]);
        expect(meta.error).toBeDefined();
        expect(meta.error).toContain('No se pudo conectar al ERP');
    });

    test('si el endpoint de stock falla pero productos responde, _stock_real queda null', async () => {
        const url = 'http://erp.test/productos-ok';
        global.fetch = jest.fn((reqUrl) => {
            if (reqUrl === url) {
                return Promise.resolve({ ok: true, json: async () => ARTICULOS });
            }
            return Promise.resolve({ ok: false, status: 500 });
        });

        const { productos } = await buscarEnERP({
            termino: 'neumatico maxxis',
            filtro: 'busqueda_general',
            erpUrl: url,
            erpMapping: { ...ERP_MAPPING, stock_url: 'http://erp.test/stock-falla' },
            companyId: nextCompanyId(),
        });

        expect(productos[0]._stock_real).toBeNull();
    });

    test('si el ERP no devuelve un array, retorna meta.error', async () => {
        const url = 'http://erp.test/no-array';
        global.fetch = jest.fn((reqUrl) => {
            if (reqUrl === url) {
                return Promise.resolve({ ok: true, json: async () => ({ no: 'es array' }) });
            }
            return Promise.resolve({ ok: false, status: 404 });
        });

        const { productos, meta } = await buscarEnERP({
            termino: 'neumatico',
            filtro: 'busqueda_general',
            erpUrl: url,
            erpMapping: { ...ERP_MAPPING, stock_url: null },
            companyId: nextCompanyId(),
        });

        expect(productos).toEqual([]);
        expect(meta.error).toContain('No se pudo conectar al ERP');
    });
});

// =============================================================================
// CACHÉ EN MEMORIA
// =============================================================================
describe('buscarEnERP() — caché por companyId:url', () => {
    test('la segunda búsqueda con mismos parámetros usa caché — fetch se llama solo una vez por endpoint', async () => {
        mockFetchOk();
        const companyId = nextCompanyId();
        const params = {
            termino: 'neumatico maxxis',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId,
        };

        await buscarEnERP(params);
        const callsAfterFirst = global.fetch.mock.calls.length;

        await buscarEnERP({ ...params, termino: 'neumatico schwalbe' });
        const callsAfterSecond = global.fetch.mock.calls.length;

        // Mismo companyId + misma URL → segunda llamada no debe re-fetchear
        expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    test('companyIds distintos no comparten caché (aislamiento multi-tenant)', async () => {
        mockFetchOk();

        await buscarEnERP({
            termino: 'neumatico',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(),
        });
        const callsAfterFirst = global.fetch.mock.calls.length;

        await buscarEnERP({
            termino: 'neumatico',
            filtro: 'busqueda_general',
            erpUrl: PRODUCTOS_URL,
            erpMapping: ERP_MAPPING,
            companyId: nextCompanyId(), // empresa distinta
        });
        const callsAfterSecond = global.fetch.mock.calls.length;

        // Empresa nueva → vuelve a fetchear (no comparte caché)
        expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
    });
});

// =============================================================================
// invalidarCache()
// =============================================================================
describe('invalidarCache()', () => {
    test('no lanza error al invalidar URLs no cacheadas', () => {
        expect(() => invalidarCache('http://erp.test/no-existe')).not.toThrow();
    });

    test('invalida productos y stock sin lanzar error', () => {
        expect(() => invalidarCache(PRODUCTOS_URL, STOCK_URL)).not.toThrow();
    });
});