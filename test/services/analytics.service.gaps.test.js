// backend/__tests__/analytics.service.gaps.test.js
//
// Cierra las 2 ramas "E" (else nunca tomado) detectadas en el reporte HTML:
//   1. fetchData: cache hit pero TTL expirado -> vuelve a fetchear
//   2. formatearAnaliticsParaLLM: meta.modo no es 'crudo' ni 'agregado'

'use strict';

const { consultarAnalitica, formatearAnaliticsParaLLM } = require('../../services/analytics.service');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

let companyCounter = 9000;
function nextCompanyId() {
  return `gap-${companyCounter++}`;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('analytics.service — ramas adicionales (else branches)', () => {
  test('fetchData: cache hit con TTL expirado vuelve a fetchear el ERP', async () => {
    const erpUrl = 'http://erp.test/ttl-expirado';
    const companyId = nextCompanyId();

    let now = 1_000_000_000_000; // timestamp base fijo
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    global.fetch = jest.fn((url) => {
      if (url === erpUrl) return Promise.resolve({ ok: true, json: async () => [{ id: '1', fecha_orden: '2025-09-01', ingreso: '100' }] });
      if (url === DEEPSEEK_API_URL) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"fecha_inicio":null,"fecha_fin":null}' } }] }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    // Primera llamada — cachea con timestamp `now`
    await consultarAnalitica({ mensaje: 'todo', erpUrl, erpMapping: {}, companyId });
    const erpCallsAfterFirst = global.fetch.mock.calls.filter(c => c[0] === erpUrl).length;
    expect(erpCallsAfterFirst).toBe(1);

    // Avanzamos el reloj más allá del TTL (5 minutos = 300_000 ms)
    now += 6 * 60_000;

    // Segunda llamada — el cache hit existe pero el TTL ya expiró → debe re-fetchear
    await consultarAnalitica({ mensaje: 'todo', erpUrl, erpMapping: {}, companyId });
    const erpCallsAfterSecond = global.fetch.mock.calls.filter(c => c[0] === erpUrl).length;
    expect(erpCallsAfterSecond).toBe(2);

    dateNowSpy.mockRestore();
  });

  test('formatearAnaliticsParaLLM: modo desconocido no agrega bloque de datos ni rompe', () => {
    const meta = { modo: 'otro_modo_no_contemplado', filtrados: 0, total_base: 0, rango: null };
    const out = formatearAnaliticsParaLLM(null, null, meta, { fecha: 'fecha_orden' });

    expect(out).toContain('[DATOS ANALÍTICA');
    expect(out).not.toContain('REGISTROS COMPLETOS DEL PERÍODO');
    expect(out).not.toContain('DATOS PRE-AGREGADOS');
    expect(out).toContain('ORDEN ABSOLUTA');
  });
});