// backend/test/services/logistics-search.service.gaps.test.js
//
// Cierra las ramas detectadas en el reporte HTML:
//   1. normalizar(): valor null/undefined explícito
//   2. formatearLogisticaParaLLM: guia vacía (erpMapping con keys pero todas filtradas)
//   3. formatearLogisticaParaLLM: modo agregado SIN alta_prioridad

'use strict';

const { consultarLogistica, formatearLogisticaParaLLM } = require('../../services/logistics-search.service');

function setupFetch({ ordenes, rango = { fecha_inicio: null, fecha_fin: null } }) {
  global.fetch = jest.fn((url) => {
    const u = String(url);
    if (u.includes('deepseek.com')) {
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(rango) } }] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ordenes });
  });
}

describe('logistics-search.service — ramas adicionales', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  test('normalizar(): orden con estado/prioridad null o undefined no rompe la normalización', async () => {
    const erpUrl = 'https://erp.test/ordenes-null';
    const ordenes = [
      { id: 1, estado: null, prioridad: undefined, fecha_creacion: '2026-06-01' },
      { id: 2, estado: 'pendiente', prioridad: 'alta', fecha_creacion: '2026-06-02' },
    ];
    setupFetch({ ordenes });

    const result = await consultarLogistica({
      mensaje: 'pendientes', erpUrl, erpMapping: {}, companyId: 'co-normalizar-null',
    });

    expect(result.meta.modo).toBe('crudo');
    expect(result.ordenes[0].estado).toBe('');
    expect(result.ordenes[0].prioridad).toBe('');
  });

  test('formatearLogisticaParaLLM: erpMapping con solo keys filtrables no agrega "Guía de campos"', () => {
    const meta = { rango: null, filtradas: 1, total_base: 1, modo: 'crudo' };
    // Todas las keys empiezan con "_" o terminan en "_url", así que `guia` queda vacío tras el filtro
    const erpMapping = { _candidatos_previos: 'x', productos_url: 'https://erp.test/productos' };
    const out = formatearLogisticaParaLLM([{ id: 1 }], null, meta, erpMapping);

    expect(out).not.toContain('Guía de campos');
  });

  test('formatearLogisticaParaLLM: modo agregado sin alta_prioridad no agrega esa sección', () => {
    const agregado = {
      por_estado: { pendiente: 5 },
      por_responsable: { Juan: { total: 5, estados: { pendiente: 5 } } },
      alta_prioridad: [],
    };
    const meta = { rango: null, filtradas: 5, total_base: 5, modo: 'agregado' };
    const out = formatearLogisticaParaLLM(null, agregado, meta, {});

    expect(out).toContain('RESUMEN PRE-AGREGADO');
    expect(out).not.toContain('ALTA PRIORIDAD PENDIENTES');
  });
});