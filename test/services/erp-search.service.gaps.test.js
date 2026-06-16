// backend/test/services/erp-search.service.gaps.test.js
//
// Cierra la única rama "E" detectada en el reporte HTML:
// fetchURL — cache hit pero TTL expirado -> vuelve a fetchear.

'use strict';

const { buscarEnERP } = require('../../services/erp-search.service');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('erp-search.service — rama adicional (TTL expirado)', () => {
  test('cache hit con TTL expirado vuelve a fetchear el ERP', async () => {
    const erpUrl = 'https://erp.test/ttl-expirado-erp-search';
    const companyId = 'co-ttl-expirado';

    let now = 2_000_000_000_000;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    const articulos = [{ id: 1, sku: 'A1', articulo: 'Producto Test', precio_tienda: 1000, stock_min: 5, categoria: 'General' }];
    global.fetch = jest.fn((url) => {
      if (url === erpUrl) return Promise.resolve({ ok: true, json: async () => articulos });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    await buscarEnERP({ termino: 'ALL', filtro: 'busqueda_general', erpUrl, erpMapping: {}, companyId });
    const callsAfterFirst = global.fetch.mock.calls.filter(c => c[0] === erpUrl).length;
    expect(callsAfterFirst).toBe(1);

    // Avanzamos el reloj más allá del TTL (60 segundos)
    now += 61_000;

    await buscarEnERP({ termino: 'ALL', filtro: 'busqueda_general', erpUrl, erpMapping: {}, companyId });
    const callsAfterSecond = global.fetch.mock.calls.filter(c => c[0] === erpUrl).length;
    expect(callsAfterSecond).toBe(2);

    dateNowSpy.mockRestore();
  });
});