// backend/test/services/sales-search.service.test.js
'use strict';

jest.mock('../../services/erp-search.service');
const { buscarEnERP } = require('../../services/erp-search.service');
const { buscarParaVentas, formatearVentasParaLLM, invalidarCache } = require('../../services/sales-search.service');

function setupFetch({
  clientesUrl = null, clientes = [],
  historialUrl = null, historial = [],
  identificacion = { estado: 'no_encontrado' },
} = {}) {
  global.fetch = jest.fn((url) => {
    const u = String(url);
    if (u.includes('deepseek.com')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(identificacion) } }] }),
      });
    }
    if (clientesUrl && u === clientesUrl) {
      return Promise.resolve({ ok: true, json: async () => clientes });
    }
    if (historialUrl && u === historialUrl) {
      return Promise.resolve({ ok: true, json: async () => historial });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

describe('sales-search.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  describe('buscarParaVentas — flujo principal', () => {
    test('busca productos en el ERP cuando hay término', async () => {
      setupFetch();
      buscarEnERP.mockResolvedValue({
        productos: [{ id: 1, nombre: 'Bici', precio: 1000 }],
        meta: { total_encontrados: 1, termino_usado: 'bici', termino_original: 'bici', fue_relajado: false },
      });

      const res = await buscarParaVentas({
        mensaje: 'tienen bicicletas?', termino: 'bici', filtro: 'busqueda_general',
        erpUrl: 'https://erp.test/productos', erpMapping: {}, companyId: 'co1',
      });

      expect(buscarEnERP).toHaveBeenCalledWith({
        termino: 'bici', filtro: 'busqueda_general', erpUrl: 'https://erp.test/productos', erpMapping: {},
      });
      expect(res.productos).toHaveLength(1);
      expect(res.metaProductos.termino_usado).toBe('bici');
    });

    test('identifica al cliente cuando hay un solo match', async () => {
      const clientes = [{ id: 'c1', nombre: 'Juan Perez', rut: '11111111-1' }];
      setupFetch({
        clientesUrl: 'https://erp.test/clientes', clientes,
        identificacion: { estado: 'encontrado', cliente_id: 'c1' },
      });

      const res = await buscarParaVentas({
        mensaje: 'busco a Juan Perez', termino: '', filtro: 'busqueda_general', erpUrl: null,
        erpMapping: { clientes_url: 'https://erp.test/clientes' }, companyId: 'co1',
      });

      expect(res.identificacion).toEqual({ estado: 'encontrado', cliente_id: 'c1' });
      expect(res.perfilCliente.nombre).toBe('Juan Perez');
      expect(res.perfilCliente.historial_compras).toEqual([]);
    });

    test('combina productos, cliente identificado e historial en una sola respuesta', async () => {
      const clientes  = [{ id: 'c1', nombre: 'Juan Perez', rut: '111' }];
      const historial = [{ cliente_id: 'c1', fecha_compra: '2026-05-01', total: 5000 }];
      setupFetch({
        clientesUrl: 'https://erp.test/clientes', clientes,
        historialUrl: 'https://erp.test/historial', historial,
        identificacion: { estado: 'encontrado', cliente_id: 'c1' },
      });
      buscarEnERP.mockResolvedValue({
        productos: [{ id: 1, nombre: 'Bici', precio: 1000 }],
        meta: { total_encontrados: 1, termino_usado: 'bici', termino_original: 'bici', fue_relajado: false },
      });

      const res = await buscarParaVentas({
        mensaje: 'Juan Perez quiere una bici', termino: 'bici', filtro: 'busqueda_general',
        erpUrl: 'https://erp.test/productos',
        erpMapping: { clientes_url: 'https://erp.test/clientes', historial_url: 'https://erp.test/historial' },
        companyId: 'co1',
      });

      expect(res.productos).toHaveLength(1);
      expect(res.perfilCliente.historial_compras).toHaveLength(1);
      expect(res.totalClientes).toBe(1);
    });
  });

  describe('formatearVentasParaLLM — flujo principal', () => {
    test('formatea estado encontrado con productos y perfil', () => {
      const productos = [{ id: 1, nombre: 'Bici', precio: 1000, sku: 'SKU1', _stock_real: 5 }];
      const perfilCliente = { id: 'c1', nombre: 'Juan', historial_compras: [] };
      const out = formatearVentasParaLLM(productos, { total_encontrados: 1 }, { estado: 'encontrado', cliente_id: 'c1' }, perfilCliente, {});

      expect(out).toContain('DATOS DE VENTAS');
      expect(out).toContain('PERFIL DEL CLIENTE IDENTIFICADO');
      expect(out).toContain('PRODUCTOS DISPONIBLES (1)');
      expect(out).toContain('ID: 1');
    });
  });

  describe('invalidarCache', () => {
    test('elimina una entrada de caché sin lanzar error', () => {
      expect(() => invalidarCache('https://erp.test/clientes')).not.toThrow();
    });
  });
});