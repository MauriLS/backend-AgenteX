// backend/__tests__/logisticsSearch.service.test.js
'use strict';

const {
  consultarLogistica,
  formatearLogisticaParaLLM,
  invalidarCache,
} = require('../../services/logistics-search.service');

describe('logisticsSearch.service', () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    jest.restoreAllMocks();
  });

  describe('consultarLogistica', () => {
    test('retorna error si fetch a ERP falla', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
      const result = await consultarLogistica({
        mensaje: 'pendientes', erpUrl: 'https://erp.test/ordenes', erpMapping: {}, companyId: 'c1',
      });
      expect(result.ordenes).toBeNull();
      expect(result.agregado).toBeNull();
      expect(result.meta.error).toBe('Network error');
    });

    test('retorna error si endpoint responde !ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      const result = await consultarLogistica({
        mensaje: 'pendientes', erpUrl: 'https://erp.test/ordenes2', erpMapping: {}, companyId: 'c2',
      });
      expect(result.meta.error).toContain('500');
    });

    test('retorna error si respuesta no es array', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: 'no-array' }),
      });
      const result = await consultarLogistica({
        mensaje: 'pendientes', erpUrl: 'https://erp.test/ordenes3', erpMapping: {}, companyId: 'c3',
      });
      expect(result.meta.error).toBe('El endpoint no devolvió un array.');
    });

    test('modo crudo cuando hay <=200 órdenes, normalizando campos array', async () => {
      const ordenes = [
        { id: 1, estado: 'pendiente', prioridad: 'alta', fecha_creacion: '2026-06-01' },
        { id: 2, estado: ['en_ruta'], prioridad: 'baja', fecha_creacion: '2026-06-02' },
      ];
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ordenes })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"fecha_inicio":null,"fecha_fin":null}' } }] }),
        });

      const result = await consultarLogistica({
        mensaje: 'órdenes pendientes', erpUrl: 'https://erp.test/ordenes4', erpMapping: {}, companyId: 'c4',
      });

      expect(result.meta.modo).toBe('crudo');
      expect(result.ordenes).toHaveLength(2);
      expect(result.ordenes[1].estado).toBe('en_ruta');
      expect(result.agregado).toBeNull();
    });

    test('filtra por rango cuando el LLM devuelve fechas válidas', async () => {
      const ordenes = [
        { id: 1, estado: 'pendiente', prioridad: 'alta', fecha_creacion: '2026-06-05' },
        { id: 2, estado: 'completado', prioridad: 'baja', fecha_creacion: '2026-05-01' },
      ];
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ordenes })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"fecha_inicio":"2026-06-01","fecha_fin":"2026-06-10"}' } }] }),
        });

      const result = await consultarLogistica({
        mensaje: 'órdenes de esta semana', erpUrl: 'https://erp.test/ordenes5', erpMapping: {}, companyId: 'c5',
      });

      expect(result.meta.rango).toEqual({ fecha_inicio: '2026-06-01', fecha_fin: '2026-06-10' });
      expect(result.meta.filtradas).toBe(1);
      expect(result.ordenes[0].id).toBe(1);
    });

    test('extractor de rango maneja respuesta !ok de DeepSeek sin romper la consulta', async () => {
      const ordenes = [{ id: 1, estado: 'pendiente', prioridad: 'alta', fecha_creacion: '2026-06-01' }];
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ordenes })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await consultarLogistica({
        mensaje: 'pendientes', erpUrl: 'https://erp.test/ordenes6', erpMapping: {}, companyId: 'c6',
      });

      expect(result.meta.rango).toBeNull();
      expect(result.meta.modo).toBe('crudo');
    });

    test('extractor de rango maneja JSON inválido del LLM', async () => {
      const ordenes = [{ id: 1, estado: 'pendiente', prioridad: 'alta', fecha_creacion: '2026-06-01' }];
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ordenes })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'no es json' } }] }),
        });

      const result = await consultarLogistica({
        mensaje: 'pendientes', erpUrl: 'https://erp.test/ordenes7', erpMapping: {}, companyId: 'c7',
      });

      expect(result.meta.rango).toBeNull();
    });

    test('modo agregado cuando hay más de 200 órdenes', async () => {
      const ordenes = Array.from({ length: 201 }, (_, i) => ({
        id: i,
        numero_orden: `ORD-${i}`,
        estado: i % 2 === 0 ? 'pendiente' : 'completado',
        prioridad: i % 5 === 0 ? 'alta' : 'baja',
        responsable: i % 3 === 0 ? 'Juan' : 'Maria',
        fecha_creacion: '2026-06-01',
        cliente_nombre: 'Cliente Test',
        fecha_compromiso: '2026-06-10',
      }));

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ordenes })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"fecha_inicio":null,"fecha_fin":null}' } }] }),
        });

      const result = await consultarLogistica({
        mensaje: 'todas las órdenes', erpUrl: 'https://erp.test/ordenes8', erpMapping: {}, companyId: 'c8',
      });

      expect(result.meta.modo).toBe('agregado');
      expect(result.ordenes).toBeNull();
      expect(result.agregado.total).toBe(201);
      expect(result.agregado.por_estado).toHaveProperty('pendiente');
      expect(result.agregado.por_estado).toHaveProperty('completado');
      expect(result.agregado.por_responsable).toHaveProperty('Juan');
      expect(result.agregado.alta_prioridad.length).toBeGreaterThan(0);
      expect(result.agregado.alta_prioridad.length).toBeLessThanOrEqual(10);
    });

    test('usa caché en segunda llamada con misma companyId/url', async () => {
      const ordenes = [{ id: 1, estado: 'pendiente', prioridad: 'baja', fecha_creacion: '2026-06-01' }];
      const rangoVacio = { ok: true, json: async () => ({ choices: [{ message: { content: '{"fecha_inicio":null,"fecha_fin":null}' } }] }) };
      const fetchMock = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ordenes })
        .mockResolvedValueOnce(rangoVacio)
        .mockResolvedValueOnce(rangoVacio);
      global.fetch = fetchMock;

      const opts = { mensaje: 'pendientes', erpUrl: 'https://erp.test/ordenes-cache', erpMapping: {}, companyId: 'cache1' };
      await consultarLogistica(opts);
      await consultarLogistica(opts);

      const erpCalls = fetchMock.mock.calls.filter(([url]) => url === opts.erpUrl);
      expect(erpCalls).toHaveLength(1);
    });

    test('aplica erp_token como header Authorization', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"fecha_inicio":null,"fecha_fin":null}' } }] }) });

      await consultarLogistica({
        mensaje: 'pendientes', erpUrl: 'https://erp.test/ordenes-token', erpMapping: { erp_token: 'Bearer abc123' }, companyId: 'c-token',
      });

      const [, opts] = global.fetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer abc123');
    });
  });

  describe('formatearLogisticaParaLLM', () => {
    test('formatea error', () => {
      const out = formatearLogisticaParaLLM(null, null, { error: 'falló' });
      expect(out).toContain('ERROR: falló');
    });

    test('formatea modo crudo con órdenes y guía de campos', () => {
      const ordenes = [{ id: 1, estado: 'pendiente' }];
      const meta = { rango: { fecha_inicio: '2026-06-01', fecha_fin: '2026-06-10' }, filtradas: 1, total_base: 1, modo: 'crudo' };
      const out = formatearLogisticaParaLLM(ordenes, null, meta, { numero_orden: 'numero' });
      expect(out).toContain('ÓRDENES COMPLETAS');
      expect(out).toContain('2026-06-01 al 2026-06-10');
      expect(out).toContain('"numero" = numero_orden');
    });

    test('formatea modo agregado con alta prioridad', () => {
      const agregado = {
        por_estado: { pendiente: 5, completado: 3 },
        por_responsable: { Juan: { total: 4, estados: { pendiente: 2, completado: 2 } } },
        alta_prioridad: [{ numero: 'ORD-1', estado: 'pendiente', responsable: 'Juan', cliente: 'Cliente X', compromiso: '2026-06-15' }],
      };
      const meta = { rango: null, filtradas: 8, total_base: 8, modo: 'agregado' };
      const out = formatearLogisticaParaLLM(null, agregado, meta, {});
      expect(out).toContain('RESUMEN PRE-AGREGADO');
      expect(out).toContain('POR ESTADO');
      expect(out).toContain('POR RESPONSABLE');
      expect(out).toContain('ALTA PRIORIDAD PENDIENTES');
    });

    test('formatea cuando no hay órdenes para el período', () => {
      const meta = { rango: null, filtradas: 0, total_base: 0, modo: 'crudo' };
      const out = formatearLogisticaParaLLM([], null, meta, {});
      expect(out).toContain('Sin órdenes para el período solicitado');
    });
  });

  describe('invalidarCache', () => {
    test('no lanza error al invalidar una key inexistente', () => {
      expect(() => invalidarCache('https://no-existe')).not.toThrow();
    });
  });
});