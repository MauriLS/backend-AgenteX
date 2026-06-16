// backend/test/services/sales-search.service.branches.test.js
'use strict';

jest.mock('../../services/erp-search.service');
const { buscarEnERP } = require('../../services/erp-search.service');
const { buscarParaVentas, formatearVentasParaLLM, invalidarCache } = require('../../services/sales-search.service');

function setupFetch({
  clientesUrl = null, clientes = [], clientesOk = true,
  historialUrl = null, historial = [], historialOk = true,
  identificaciones = [{ estado: 'no_encontrado' }],
  identificacionRaw = null, identificacionOk = true,
} = {}) {
  let i = 0;
  global.fetch = jest.fn((url) => {
    const u = String(url);
    if (u.includes('deepseek.com')) {
      if (!identificacionOk) return Promise.resolve({ ok: false, status: 500 });
      if (identificacionRaw !== null) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: identificacionRaw } }] }) });
      }
      const ident = identificaciones[Math.min(i, identificaciones.length - 1)];
      i++;
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(ident) } }] }) });
    }
    if (clientesUrl && u === clientesUrl) {
      return Promise.resolve({ ok: clientesOk, status: 500, json: async () => clientes });
    }
    if (historialUrl && u === historialUrl) {
      return Promise.resolve({ ok: historialOk, status: 500, json: async () => historial });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

function deepseekSystemPrompt() {
  const call = global.fetch.mock.calls.find(([url]) => String(url).includes('deepseek.com'));
  const body = JSON.parse(call[1].body);
  return body.messages[0].content;
}

describe('sales-search.service - branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  describe('extraerCliente', () => {
    test('sin clientes retorna no_encontrado sin llamar a DeepSeek', async () => {
      setupFetch();
      const res = await buscarParaVentas({
        mensaje: 'hola', termino: '', filtro: 'busqueda_general',
        erpUrl: null, erpMapping: {}, companyId: 'co-sin-clientes',
      });

      expect(res.identificacion).toEqual({ estado: 'no_encontrado' });
      const deepseekCalls = global.fetch.mock.calls.filter(([url]) => String(url).includes('deepseek.com'));
      expect(deepseekCalls).toHaveLength(0);
    });

    test('maneja clientes con campos incompletos (fallbacks de nombre/segmento)', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes', clientes: [{ id: 'c1' }],
        identificaciones: [{ estado: 'no_encontrado' }],
      });

      const res = await buscarParaVentas({
        mensaje: 'hola', termino: '', filtro: 'busqueda_general',
        erpUrl: null, erpMapping: { clientes_url: 'https://erp.test/clientes' }, companyId: 'co-fallback-campos',
      });

      expect(res.totalClientes).toBe(1);
    });

    test('retorna estado error si DeepSeek responde !ok', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes',
        clientes: [{ id: 'c1', nombre: 'Juan', rut: '111' }],
        identificacionOk: false,
      });

      const res = await buscarParaVentas({
        mensaje: 'busco a Juan', termino: '', filtro: 'busqueda_general',
        erpUrl: null, erpMapping: { clientes_url: 'https://erp.test/clientes' }, companyId: 'co-deepseek-fail',
      });

      expect(res.identificacion.estado).toBe('error');
      expect(res.identificacion.mensaje).toBeDefined();
    });

    test('retorna estado error si la respuesta de DeepSeek no es JSON válido', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes',
        clientes: [{ id: 'c1', nombre: 'Juan', rut: '111' }],
        identificacionRaw: 'esto no es json',
      });

      const res = await buscarParaVentas({
        mensaje: 'busco a Juan', termino: '', filtro: 'busqueda_general',
        erpUrl: null, erpMapping: { clientes_url: 'https://erp.test/clientes' }, companyId: 'co-deepseek-json-invalido',
      });

      expect(res.identificacion.estado).toBe('error');
    });

    test('usa candidatos previos cuando el turno anterior fue ambiguo', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes',
        clientes: [{ id: 'c3', nombre: 'Otro Cliente', rut: '999' }],
        identificaciones: [{ estado: 'encontrado', cliente_id: 'c1' }],
      });

      const erpMapping = {
        clientes_url: 'https://erp.test/clientes',
        _candidatos_previos: [{ id: 'c1', nombre: 'Juan Perez', segmento: 'retail' }],
      };
      const historialConversacion = [{ role: 'assistant', content: '¿A cuál de estos te refieres?' }];

      await buscarParaVentas({
        mensaje: 'el primero', termino: '', filtro: 'busqueda_general',
        erpUrl: null, erpMapping, historialConversacion, companyId: 'co-candidatos-previos-1',
      });

      const prompt = deepseekSystemPrompt();
      expect(prompt).toContain('selección previa');
      expect(prompt).toContain('Juan Perez');
      expect(prompt).not.toContain('Otro Cliente');
    });

    test('detecta candidatos previos con la frase "cuál es el cliente correcto"', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes',
        clientes: [{ id: 'c3', nombre: 'Otro Cliente', rut: '999' }],
        identificaciones: [{ estado: 'no_encontrado' }],
      });

      const erpMapping = {
        clientes_url: 'https://erp.test/clientes',
        _candidatos_previos: [{ id: 'c1', nombre: 'Juan Perez', segmento: 'retail' }],
      };
      const historialConversacion = [{ role: 'assistant', content: 'no sé cuál es el cliente correcto, dime el RUT' }];

      await buscarParaVentas({
        mensaje: 'opcion 1', termino: '', filtro: 'busqueda_general',
        erpUrl: null, erpMapping, historialConversacion, companyId: 'co-candidatos-previos-2',
      });

      const prompt = deepseekSystemPrompt();
      expect(prompt).toContain('selección previa');
    });

    test('sin desambiguación previa usa la lista completa de clientes', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes',
        clientes: [{ id: 'c1', nombre: 'Juan', rut: '111' }],
        identificaciones: [{ estado: 'no_encontrado' }],
      });

      const historialConversacion = [{ role: 'assistant', content: 'Hola, ¿en qué te ayudo?' }];

      await buscarParaVentas({
        mensaje: 'busco a Juan', termino: '', filtro: 'busqueda_general',
        erpUrl: null, erpMapping: { clientes_url: 'https://erp.test/clientes' }, historialConversacion, companyId: 'co-sin-desambiguacion',
      });

      const prompt = deepseekSystemPrompt();
      expect(prompt).toContain('Busca al cliente mencionado');
    });
  });

  describe('perfil completo del cliente', () => {
    test('arma el perfil con historial ordenado y limitado a 10 compras', async () => {
      const clientes = [{ id: 'c1', nombre: 'Juan', rut: '111' }];
      const historial = [];
      for (let i = 0; i < 12; i++) {
        historial.push({ cliente_id: 'c1', fecha_compra: `2026-01-${String(i + 1).padStart(2, '0')}`, total: i });
      }
      historial.push({ cliente_id: 'c2', fecha_compra: '2026-06-01', total: 999 });

      setupFetch({
        clientesUrl: 'https://erp.test/clientes', clientes,
        historialUrl: 'https://erp.test/historial', historial,
        identificaciones: [{ estado: 'encontrado', cliente_id: 'c1' }],
      });

      const res = await buscarParaVentas({
        mensaje: 'busco a Juan', termino: '', filtro: 'busqueda_general', erpUrl: null,
        erpMapping: { clientes_url: 'https://erp.test/clientes', historial_url: 'https://erp.test/historial' },
        companyId: 'co-historial-ordenado',
      });

      expect(res.perfilCliente.historial_compras).toHaveLength(10);
      expect(res.perfilCliente.historial_compras[0].fecha_compra).toBe('2026-01-12');
      expect(res.perfilCliente.historial_compras.every(h => h.cliente_id === 'c1')).toBe(true);
    });

    test('retorna perfilCliente null si el cliente identificado no está en la lista', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes', clientes: [{ id: 'c1', nombre: 'Juan', rut: '111' }],
        identificaciones: [{ estado: 'encontrado', cliente_id: 'c-x' }],
      });

      const res = await buscarParaVentas({
        mensaje: 'busco a alguien', termino: '', filtro: 'busqueda_general', erpUrl: null,
        erpMapping: { clientes_url: 'https://erp.test/clientes' }, companyId: 'co-perfil-no-encontrado',
      });

      expect(res.perfilCliente).toBeNull();
    });
  });

  describe('fuentes de datos y catches', () => {
    test('termino vacío no consulta el ERP', async () => {
      setupFetch();
      const res = await buscarParaVentas({
        mensaje: 'hola', termino: '', filtro: 'busqueda_general', erpUrl: 'https://erp.test/productos',
        erpMapping: {}, companyId: 'co-termino-vacio',
      });

      expect(buscarEnERP).not.toHaveBeenCalled();
      expect(res.productos).toEqual([]);
      expect(res.metaProductos).toEqual({});
    });

    test('si buscarEnERP falla, productos queda vacío y meta tiene error', async () => {
      setupFetch();
      buscarEnERP.mockRejectedValue(new Error('erp down'));

      const res = await buscarParaVentas({
        mensaje: 'bici', termino: 'bici', filtro: 'busqueda_general', erpUrl: 'https://erp.test/productos',
        erpMapping: {}, companyId: 'co-erp-down',
      });

      expect(res.productos).toEqual([]);
      expect(res.metaProductos.error).toBe('erp down');
    });

    test('sin clientes_url, totalClientes es 0', async () => {
      setupFetch();
      const res = await buscarParaVentas({
        mensaje: 'hola', termino: '', filtro: 'busqueda_general', erpUrl: null,
        erpMapping: {}, companyId: 'co-sin-clientes-url',
      });

      expect(res.totalClientes).toBe(0);
    });

    test('si falla el fetch de clientes, clientes queda vacío', async () => {
      setupFetch({ clientesUrl: 'https://erp.test/clientes', clientes: [], clientesOk: false });

      const res = await buscarParaVentas({
        mensaje: 'hola', termino: '', filtro: 'busqueda_general', erpUrl: null,
        erpMapping: { clientes_url: 'https://erp.test/clientes' }, companyId: 'co-clientes-fail',
      });

      expect(res.totalClientes).toBe(0);
    });

    test('si falla el fetch de historial, no rompe la consulta', async () => {
      setupFetch({
        clientesUrl: 'https://erp.test/clientes', clientes: [{ id: 'c1', nombre: 'Juan', rut: '111' }],
        historialUrl: 'https://erp.test/historial', historialOk: false,
        identificaciones: [{ estado: 'encontrado', cliente_id: 'c1' }],
      });

      const res = await buscarParaVentas({
        mensaje: 'busco a Juan', termino: '', filtro: 'busqueda_general', erpUrl: null,
        erpMapping: { clientes_url: 'https://erp.test/clientes', historial_url: 'https://erp.test/historial' },
        companyId: 'co-historial-fail',
      });

      expect(res.perfilCliente.historial_compras).toEqual([]);
    });

    test('identificacion ambigua devuelve la lista de candidatos', async () => {
      const candidatos = [{ id: 'c1', nombre: 'Juan Perez' }, { id: 'c2', nombre: 'Juan Soto' }];
      setupFetch({
        clientesUrl: 'https://erp.test/clientes',
        clientes: [{ id: 'c1', nombre: 'Juan Perez', rut: '111' }, { id: 'c2', nombre: 'Juan Soto', rut: '222' }],
        identificaciones: [{ estado: 'ambiguo', candidatos }],
      });

      const res = await buscarParaVentas({
        mensaje: 'busco a Juan', termino: '', filtro: 'busqueda_general', erpUrl: null,
        erpMapping: { clientes_url: 'https://erp.test/clientes' }, companyId: 'co-ambiguo',
      });

      expect(res.candidatos).toEqual(candidatos);
      expect(res.perfilCliente).toBeNull();
    });
  });

  describe('formatearVentasParaLLM', () => {
    test('estado ambiguo genera tabla de candidatos', () => {
      const candidatos = [{ id: 'c1', nombre: 'Juan Perez', segmento: 'retail' }];
      const out = formatearVentasParaLLM([], {}, { estado: 'ambiguo', candidatos }, null, {});
      expect(out).toContain('CLIENTE AMBIGUO');
      expect(out).toContain('¿A cuál de estos clientes te refieres?');
    });

    test('estado no_encontrado informa que el cliente no está registrado', () => {
      const out = formatearVentasParaLLM([], {}, { estado: 'no_encontrado' }, null, {});
      expect(out).toContain('CLIENTE NO ENCONTRADO');
    });

    test('estado encontrado incluye perfil del cliente y productos con descripción', () => {
      const productos = [{ id: 1, nombre: 'Bici', precio: 1000, descripcion: 'Bici urbana', sku: 'SKU1', _stock_real: 5 }];
      const perfilCliente = { id: 'c1', nombre: 'Juan', historial_compras: [] };
      const out = formatearVentasParaLLM(productos, {}, { estado: 'encontrado', cliente_id: 'c1' }, perfilCliente, {});

      expect(out).toContain('PERFIL DEL CLIENTE IDENTIFICADO');
      expect(out).toContain('PRODUCTOS DISPONIBLES');
      expect(out).toContain('Descripción: Bici urbana');
      expect(out).toContain('Usa lenguaje persuasivo');
    });

    test('producto sin descripción no agrega la línea de descripción', () => {
      const productos = [{ id: 1, nombre: 'Bici', precio: 1000 }];
      const out = formatearVentasParaLLM(productos, {}, { estado: 'no_encontrado' }, null, {});
      expect(out).not.toContain('Descripción:');
    });

    test('metaProductos.error genera ERROR DE INVENTARIO', () => {
      const out = formatearVentasParaLLM([], { error: 'erp down' }, { estado: 'no_encontrado' }, null, {});
      expect(out).toContain('ERROR DE INVENTARIO: erp down');
    });

    test('metaProductos.demasiados genera aviso de búsqueda amplia', () => {
      const out = formatearVentasParaLLM([], { demasiados: true, total_encontrados: 120 }, { estado: 'no_encontrado' }, null, {});
      expect(out).toContain('BÚSQUEDA AMPLIA: 120 productos');
    });
  });

  describe('invalidarCache', () => {
    test('no lanza error al invalidar una key', () => {
      expect(() => invalidarCache('https://erp.test/clientes')).not.toThrow();
    });
  });
});