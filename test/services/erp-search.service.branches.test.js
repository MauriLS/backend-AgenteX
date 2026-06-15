// backend/test/services/erp-search.service.branches.test.js
'use strict';

const { buscarEnERP, invalidarCache } = require('../../services/erp-search.service');

function setupFetch({ articulosUrl, articulos, articulosOk = true, throwArticulos = false, stockUrl = null, stock = null, stockOk = true }) {
  global.fetch = jest.fn((url) => {
    const u = String(url);
    if (throwArticulos && u === articulosUrl) return Promise.reject(new Error('network down'));
    if (u === articulosUrl) return Promise.resolve({ ok: articulosOk, status: 500, json: async () => articulos });
    if (stockUrl && u === stockUrl) return Promise.resolve({ ok: stockOk, status: 500, json: async () => stock });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

const BASE_ARTICULOS = [
  { id: 1, sku: 'TRI-01', articulo: 'Triciclo Rojo',  precio_tienda: 50000,  stock_min: 5,  categoria: 'Juguetes' },
  { id: 2, sku: 'TRI-02', articulo: 'Triciclo Azul',  precio_tienda: 60000,  stock_min: 2,  categoria: 'Juguetes' },
  { id: 3, sku: 'BIC-29', articulo: 'Bicicleta Aro 29', precio_tienda: 150000, stock_min: 10, categoria: 'Bicicletas' },
  { id: 4, sku: 'NEU-29', articulo: 'Neumatico MTB 29 2.10', precio_tienda: 15000, stock_min: 8, categoria: 'Repuestos' },
];

describe('erp-search.service - branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchArticulosConStock', () => {
    test('sin stock_url, _stock_real es null para todos', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/sin-stock', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/sin-stock', erpMapping: {}, companyId: 'co-sin-stock',
      });

      expect(res.productos.every(p => p._stock_real === null)).toBe(true);
    });

    test('si el endpoint de stock falla, _stock_real queda null', async () => {
      setupFetch({
        articulosUrl: 'https://erp.test/con-stock-fail', articulos: BASE_ARTICULOS,
        stockUrl: 'https://erp.test/stock-fail', stockOk: false,
      });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/con-stock-fail',
        erpMapping: { stock_url: 'https://erp.test/stock-fail' }, companyId: 'co-stock-fail',
      });

      expect(res.productos.every(p => p._stock_real === null)).toBe(true);
    });

    test('con stock_url y join por defecto (id_articulo/stock_real)', async () => {
      setupFetch({
        articulosUrl: 'https://erp.test/con-stock-ok', articulos: BASE_ARTICULOS,
        stockUrl: 'https://erp.test/stock-ok',
        stock: [{ id_articulo: '1', stock_real: 12 }, { id_articulo: '2', stock_real: 0 }],
      });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/con-stock-ok',
        erpMapping: { stock_url: 'https://erp.test/stock-ok' }, companyId: 'co-stock-ok',
      });

      const porId = Object.fromEntries(res.productos.map(p => [p.id, p._stock_real]));
      expect(porId[1]).toBe(12);
      expect(porId[2]).toBe(0);
      expect(porId[3]).toBeNull(); // sin registro en el endpoint de stock
    });

    test('con join personalizado (stock_join_id / stock_real_key)', async () => {
      setupFetch({
        articulosUrl: 'https://erp.test/con-stock-custom', articulos: BASE_ARTICULOS,
        stockUrl: 'https://erp.test/stock-custom',
        stock: [{ codigo: '1', cantidad: 7 }],
      });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/con-stock-custom',
        erpMapping: { stock_url: 'https://erp.test/stock-custom', stock_join_id: 'codigo', stock_real_key: 'cantidad' },
        companyId: 'co-stock-custom',
      });

      const porId = Object.fromEntries(res.productos.map(p => [p.id, p._stock_real]));
      expect(porId[1]).toBe(7);
      expect(porId[2]).toBeNull();
    });

    test('si el ERP no devuelve un array, retorna meta.error', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/no-array', articulos: { error: 'bad' } });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/no-array', erpMapping: {}, companyId: 'co-no-array',
      });

      expect(res.meta.error).toContain('no devolvió un array');
    });

    test('si falla la conexión al ERP, retorna meta.error', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/down', articulos: [], throwArticulos: true });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/down', erpMapping: {}, companyId: 'co-down',
      });

      expect(res.meta.error).toContain('No se pudo conectar al ERP');
    });

    test('aplica erp_token como header Authorization', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/con-token', articulos: BASE_ARTICULOS });

      await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/con-token',
        erpMapping: { erp_token: 'Bearer xyz' }, companyId: 'co-token',
      });

      const [, opts] = global.fetch.mock.calls.find(([url]) => url === 'https://erp.test/con-token');
      expect(opts.headers.Authorization).toBe('Bearer xyz');
    });
  });

  describe('termino ALL', () => {
    test('filtro distinto de stock_critico devuelve todos los artículos', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/all-general', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'busqueda_general', erpUrl: 'https://erp.test/all-general', erpMapping: {}, companyId: 'co-all-general',
      });

      expect(res.productos).toHaveLength(BASE_ARTICULOS.length);
      expect(res.meta.termino_usado).toBe('ALL');
    });

    test('stock_critico filtra por stock <= 3', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/all-critico', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'stock_critico', erpUrl: 'https://erp.test/all-critico', erpMapping: {}, companyId: 'co-all-critico',
      });

      expect(res.productos).toHaveLength(1);
      expect(res.productos[0].articulo).toBe('Triciclo Azul');
    });
  });

  test('filtro conteo_total retorna es_conteo sin productos', async () => {
    setupFetch({ articulosUrl: 'https://erp.test/conteo', articulos: BASE_ARTICULOS });

    const res = await buscarEnERP({
      termino: 'triciclo', filtro: 'conteo_total', erpUrl: 'https://erp.test/conteo', erpMapping: {}, companyId: 'co-conteo',
    });

    expect(res.meta.es_conteo).toBe(true);
    expect(res.meta.total_encontrados).toBe(2);
    expect(res.productos).toEqual([]);
  });

  describe('umbral de fricción', () => {
    function generarArticulosMasivos() {
      return Array.from({ length: 60 }, (_, i) => ({
        id: i + 1, sku: `PRD-${i}`, articulo: `Producto ${i}`, precio_tienda: 1000 * (i + 1), stock_min: i, categoria: 'General',
      }));
    }

    test('busqueda_general con >50 resultados activa demasiados', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/masivo-general', articulos: generarArticulosMasivos() });

      const res = await buscarEnERP({
        termino: 'producto', filtro: 'busqueda_general', erpUrl: 'https://erp.test/masivo-general', erpMapping: {}, companyId: 'co-masivo-general',
      });

      expect(res.meta.demasiados).toBe(true);
      expect(res.productos).toEqual([]);
    });

    test('mayor_valor con >50 resultados NO activa demasiados y ordena por precio desc', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/masivo-mayor', articulos: generarArticulosMasivos() });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'mayor_valor', erpUrl: 'https://erp.test/masivo-mayor', erpMapping: {}, companyId: 'co-masivo-mayor',
      });

      expect(res.meta.demasiados).toBeUndefined();
      expect(res.productos[0].precio_tienda).toBeGreaterThan(res.productos[1].precio_tienda);
    });
  });

  describe('ordenar', () => {
    test('menor_valor ordena por precio ascendente', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/menor-valor', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'menor_valor', erpUrl: 'https://erp.test/menor-valor', erpMapping: {}, companyId: 'co-menor-valor',
      });

      expect(res.productos[0].articulo).toBe('Neumatico MTB 29 2.10'); // 15000, el más barato
    });

    test('stock_mayor ordena por stock descendente', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/stock-mayor', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'ALL', filtro: 'stock_mayor', erpUrl: 'https://erp.test/stock-mayor', erpMapping: {}, companyId: 'co-stock-mayor',
      });

      expect(res.productos[0].articulo).toBe('Bicicleta Aro 29'); // stock_min 10, el mayor
    });
  });

  describe('parsearRango / rango_precio / rango_stock', () => {
    test('rango_precio sin texto, solo min y max', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/rango-precio', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'min:40000 max:100000', filtro: 'rango_precio', erpUrl: 'https://erp.test/rango-precio', erpMapping: {}, companyId: 'co-rango-precio',
      });

      expect(res.productos.map(p => p.articulo)).toEqual(['Triciclo Rojo', 'Triciclo Azul']);
    });

    test('rango_precio con texto y rango combinados', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/rango-precio-texto', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'triciclo min:0 max:100000', filtro: 'rango_precio', erpUrl: 'https://erp.test/rango-precio-texto', erpMapping: {}, companyId: 'co-rango-precio-texto',
      });

      expect(res.productos).toHaveLength(2);
      expect(res.productos.every(p => p.articulo.includes('Triciclo'))).toBe(true);
    });

    test('rango_precio con coincidencia difusa (typo)', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/rango-precio-fuzzy', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'tricilo min:0 max:999999', filtro: 'rango_precio', erpUrl: 'https://erp.test/rango-precio-fuzzy', erpMapping: {}, companyId: 'co-rango-precio-fuzzy',
      });

      expect(res.productos.length).toBeGreaterThanOrEqual(1);
      expect(res.productos.every(p => p.articulo.includes('Triciclo'))).toBe(true);
    });

    test('rango_precio con token numérico filtra por nombre', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/rango-precio-num', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: '29 min:0 max:999999', filtro: 'rango_precio', erpUrl: 'https://erp.test/rango-precio-num', erpMapping: {}, companyId: 'co-rango-precio-num',
      });

      // "29" aparece tanto en "Bicicleta Aro 29" como en "Neumatico MTB 29 2.10"
      // ordenado ascendente por precio (rango_precio): Neumatico (15000) antes que Bicicleta (150000)
      expect(res.productos.map(p => p.articulo)).toEqual(['Neumatico MTB 29 2.10', 'Bicicleta Aro 29']);
    });

    test('rango_stock filtra por stock_min y ordena descendente', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/rango-stock', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'min:1 max:6', filtro: 'rango_stock', erpUrl: 'https://erp.test/rango-stock', erpMapping: {}, companyId: 'co-rango-stock',
      });

      expect(res.productos.map(p => p.articulo)).toEqual(['Triciclo Rojo', 'Triciclo Azul']);
    });
  });

  describe('búsqueda no-rango', () => {
    test('coincide por SKU aunque el nombre no matchee', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/sku', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'tri-02', filtro: 'busqueda_general', erpUrl: 'https://erp.test/sku', erpMapping: {}, companyId: 'co-sku',
      });

      expect(res.productos.map(p => p.articulo)).toEqual(['Triciclo Azul']);
    });

    test('token numérico único (OR) filtra por número en el nombre', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/aro29', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'aro 29', filtro: 'busqueda_general', erpUrl: 'https://erp.test/aro29', erpMapping: {}, companyId: 'co-aro29',
      });

      expect(res.productos.map(p => p.articulo)).toEqual(['Bicicleta Aro 29']);
    });

    test('tokens numéricos múltiples (AND) requieren ambos en el nombre', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/neumatico', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'neumatico 29 2.10', filtro: 'busqueda_general', erpUrl: 'https://erp.test/neumatico', erpMapping: {}, companyId: 'co-neumatico',
      });

      expect(res.productos.map(p => p.articulo)).toEqual(['Neumatico MTB 29 2.10']);
    });

    test('si el término exacto no matchea, usa el fallback (primer sustantivo)', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/fallback', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'neumatico 29 3.00', filtro: 'busqueda_general', erpUrl: 'https://erp.test/fallback', erpMapping: {}, companyId: 'co-fallback',
      });

      expect(res.meta.fue_relajado).toBe(true);
      expect(res.meta.termino_usado).toBe('neumatico');
      expect(res.productos.map(p => p.articulo)).toEqual(['Neumatico MTB 29 2.10']);
    });

    test('stock_critico con término específico filtra dentro de los resultados', async () => {
      setupFetch({ articulosUrl: 'https://erp.test/critico-termino', articulos: BASE_ARTICULOS });

      const res = await buscarEnERP({
        termino: 'triciclo', filtro: 'stock_critico', erpUrl: 'https://erp.test/critico-termino', erpMapping: {}, companyId: 'co-critico-termino',
      });

      expect(res.productos.map(p => p.articulo)).toEqual(['Triciclo Azul']);
    });
  });

  describe('invalidarCache', () => {
    test('invalida solo erpUrl cuando no se pasa stockUrl', () => {
      expect(() => invalidarCache('https://erp.test/x')).not.toThrow();
    });

    test('invalida erpUrl y stockUrl cuando ambos se proveen', () => {
      expect(() => invalidarCache('https://erp.test/x', 'https://erp.test/stock')).not.toThrow();
    });
  });
});