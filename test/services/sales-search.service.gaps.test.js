// backend/test/services/sales-search.service.gaps.test.js
//
// Cierra la única rama "E" detectada en el reporte HTML:
// fetchURL — cache hit pero TTL expirado -> vuelve a fetchear.

'use strict';

jest.mock('../../services/erp-search.service');
const { buscarParaVentas } = require('../../services/sales-search.service');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sales-search.service — rama adicional (TTL expirado)', () => {
  test('cache hit con TTL expirado en clientesUrl vuelve a fetchear', async () => {
    const clientesUrl = 'https://erp.test/clientes-ttl-expirado';
    const companyId = 'co-ttl-expirado-sales';

    let now = 3_000_000_000_000;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    global.fetch = jest.fn((url) => {
      if (url === clientesUrl) {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'c1', nombre: 'Juan', rut: '111' }] });
      }
      if (String(url).includes('deepseek.com')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"estado":"no_encontrado"}' } }] }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    const opts = {
      mensaje: 'hola', termino: '', filtro: 'busqueda_general', erpUrl: null,
      erpMapping: { clientes_url: clientesUrl }, companyId,
    };

    await buscarParaVentas(opts);
    const callsAfterFirst = global.fetch.mock.calls.filter(c => c[0] === clientesUrl).length;
    expect(callsAfterFirst).toBe(1);

    // Avanzamos el reloj más allá del TTL (60 segundos)
    now += 61_000;

    await buscarParaVentas(opts);
    const callsAfterSecond = global.fetch.mock.calls.filter(c => c[0] === clientesUrl).length;
    expect(callsAfterSecond).toBe(2);

    dateNowSpy.mockRestore();
  });
});