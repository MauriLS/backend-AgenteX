// backend/test/controllers/chat.controller.motores.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/erp-search.service');
jest.mock('../../services/analytics.service');
jest.mock('../../services/sales-search.service');
jest.mock('../../services/logistics-search.service');

const supabase = require('../../config/supabase');
const { buscarEnERP } = require('../../services/erp-search.service');
const { consultarAnalitica, formatearAnaliticsParaLLM } = require('../../services/analytics.service');
const { buscarParaVentas, formatearVentasParaLLM } = require('../../services/sales-search.service');
const { consultarLogistica, formatearLogisticaParaLLM } = require('../../services/logistics-search.service');
const { processChatMessage } = require('../../controllers/chat.controller');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

// fetch mock: responde DeepSeek según el mensaje de usuario enviado, y al motor Python por defecto.
function setupFetch(deepseekRespuestas = {}, pythonReply = { reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }) {
  global.fetch = jest.fn((url, opts) => {
    if (String(url).includes('deepseek.com')) {
      const body = JSON.parse(opts.body);
      const userMsg = body.messages[1].content;
      const intencion = deepseekRespuestas[userMsg] || { termino: 'producto', filtro: 'busqueda_general' };
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(intencion) } }] }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => pythonReply, text: async () => '' });
  });
}

function makeConfig(motor, erpMapping) {
  return {
    id: 'ca1',
    custom_instructions: 'Eres un asistente.',
    temperature: 0.3,
    max_memory_messages: 6,
    agent_templates: { base_system_prompt: '', allowed_tools: [], motor },
    companies: { name: 'ACME', erp_base_url: null, erp_mapping: erpMapping, business_context: '' },
  };
}

describe('chat.controller processChatMessage - motores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  describe('motor analytics', () => {
    test('consulta analítica y formatea NIVEL 4 con los datos', async () => {
      const config = makeConfig('analytics', { productos_url: 'https://erp.test/ventas' });
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
      const chainMessages   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession)
        .mockReturnValueOnce(chainMessages);

      consultarAnalitica.mockResolvedValue({
        registros: [{ id: 1, total: 1000 }],
        agregado: null,
        meta: { modo: 'crudo', filtrados: 1, total_base: 1, rango: null },
      });
      formatearAnaliticsParaLLM.mockReturnValue('NIVEL4_ANALYTICS');

      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'ventas de este mes', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      // motor analytics no usa el extractor de intención de DeepSeek
      const deepseekCalls = global.fetch.mock.calls.filter(([url]) => String(url).includes('deepseek.com'));
      expect(deepseekCalls).toHaveLength(0);

      expect(consultarAnalitica).toHaveBeenCalledWith({
        mensaje: 'ventas de este mes',
        erpUrl: 'https://erp.test/ventas',
        erpMapping: config.companies.erp_mapping,
        companyId: 'co1',
      });
      expect(formatearAnaliticsParaLLM).toHaveBeenCalledWith(
        [{ id: 1, total: 1000 }],
        null,
        expect.objectContaining({ modo: 'crudo', filtrados: 1, total_base: 1 }),
        config.companies.erp_mapping,
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('si consultarAnalitica falla, metaERP queda con error y la respuesta sigue siendo 200', async () => {
      const config = makeConfig('analytics', { productos_url: 'https://erp.test/ventas' });
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
      const chainMessages   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession)
        .mockReturnValueOnce(chainMessages);

      consultarAnalitica.mockRejectedValue(new Error('analytics down'));
      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'ventas de este mes', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      const respuesta = res.json.mock.calls[0][0];
      expect(respuesta._debug.erp_meta.error).toBe('analytics down');
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('motor ventas', () => {
    test('busca productos y cliente, formatea NIVEL 4', async () => {
      const config = makeConfig('ventas', { productos_url: 'https://erp.test/productos', clientes_url: 'https://erp.test/clientes' });
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
      const chainMessages   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession)
        .mockReturnValueOnce(chainMessages);

      buscarParaVentas.mockResolvedValue({
        productos: [{ id: 1, nombre: 'Bici', precio: 100 }],
        metaProductos: { total_encontrados: 1, termino_usado: 'bici', termino_original: 'bici', fue_relajado: false },
        identificacion: { estado: 'encontrado', cliente_id: 'c1' },
        perfilCliente: { id: 'c1', nombre: 'Juan' },
        totalClientes: 5,
        candidatos: null,
      });
      formatearVentasParaLLM.mockReturnValue('NIVEL4_VENTAS');

      setupFetch({ 'tienen bicicletas?': { termino: 'bici', filtro: 'busqueda_general' } });

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'tienen bicicletas?', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      expect(buscarParaVentas).toHaveBeenCalledWith({
        mensaje: 'tienen bicicletas?',
        termino: 'bici',
        filtro: 'busqueda_general',
        erpUrl: 'https://erp.test/productos',
        erpMapping: { ...config.companies.erp_mapping, _candidatos_previos: null },
        historialConversacion: [],
        companyId: 'co1',
      });
      expect(formatearVentasParaLLM).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('recupera candidatos previos cuando el turno anterior fue ambiguo', async () => {
      const candidatosPrevios = [{ id: 'c1', nombre: 'Juan Perez' }, { id: 'c2', nombre: 'Juan Soto' }];
      const config = makeConfig('ventas', { productos_url: 'https://erp.test/productos', _candidatos_previos: candidatosPrevios });
      const chainConfig  = buildChain({ data: config, error: null });
      const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
      const chainHistory = buildChain({
        data: [
          { content: 'busco a Juan', sender_type: 'USER' },
          { content: 'Encontré varios clientes que podrían coincidir. ¿A cuál de estos te refieres?', sender_type: 'IA' },
        ],
        error: null,
      });
      const chainMessages = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainSession)
        .mockReturnValueOnce(chainHistory)
        .mockReturnValueOnce(chainMessages);

      buscarParaVentas.mockResolvedValue({
        productos: [], metaProductos: {}, identificacion: { estado: 'encontrado', cliente_id: 'c1' },
        perfilCliente: { id: 'c1', nombre: 'Juan Perez' }, totalClientes: 2, candidatos: null,
      });
      formatearVentasParaLLM.mockReturnValue('NIVEL4_VENTAS');

      setupFetch({ 'el primero': { termino: 'primero', filtro: 'busqueda_general' } });

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'el primero', agent_id: 'tpl-1', session_chat_id: 's1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      const llamada = buscarParaVentas.mock.calls[0][0];
      expect(llamada.erpMapping._candidatos_previos).toEqual(candidatosPrevios);
    });

    test('si buscarParaVentas falla, metaERP queda con error', async () => {
      const config = makeConfig('ventas', { productos_url: 'https://erp.test/productos' });
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
      const chainMessages   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession)
        .mockReturnValueOnce(chainMessages);

      buscarParaVentas.mockRejectedValue(new Error('ventas down'));
      formatearVentasParaLLM.mockReturnValue('NIVEL4_VENTAS');
      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'tienen bicicletas?', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      const respuesta = res.json.mock.calls[0][0];
      expect(respuesta._debug.erp_meta.error).toBe('ventas down');
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('motor logistica', () => {
    test('usa erp_mapping.ordenes_url cuando está configurado', async () => {
      const config = makeConfig('logistica', { productos_url: 'https://erp.test/productos', ordenes_url: 'https://erp.test/ordenes' });
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
      const chainMessages   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession)
        .mockReturnValueOnce(chainMessages);

      consultarLogistica.mockResolvedValue({
        ordenes: [{ id: 1, numero_orden: 'OT-1', estado: 'pendiente' }],
        agregado: null,
        meta: { modo: 'crudo', filtradas: 1, total_base: 1, rango: null },
      });
      formatearLogisticaParaLLM.mockReturnValue('NIVEL4_LOGISTICA');
      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'órdenes pendientes', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      expect(consultarLogistica).toHaveBeenCalledWith({
        mensaje: 'órdenes pendientes',
        erpUrl: 'https://erp.test/ordenes',
        erpMapping: config.companies.erp_mapping,
        companyId: 'co1',
      });
      expect(formatearLogisticaParaLLM).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('cae a erp_mapping.productos_url si no hay ordenes_url', async () => {
      const config = makeConfig('logistica', { productos_url: 'https://erp.test/productos' });
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
      const chainMessages   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession)
        .mockReturnValueOnce(chainMessages);

      consultarLogistica.mockResolvedValue({ ordenes: [], agregado: null, meta: { modo: 'crudo', filtradas: 0, total_base: 0, rango: null } });
      formatearLogisticaParaLLM.mockReturnValue('NIVEL4_LOGISTICA');
      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'órdenes pendientes', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      expect(consultarLogistica.mock.calls[0][0].erpUrl).toBe('https://erp.test/productos');
    });

    test('si consultarLogistica falla, metaERP queda con error', async () => {
      const config = makeConfig('logistica', { productos_url: 'https://erp.test/productos' });
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
      const chainMessages   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession)
        .mockReturnValueOnce(chainMessages);

      consultarLogistica.mockRejectedValue(new Error('logistica down'));
      formatearLogisticaParaLLM.mockReturnValue('NIVEL4_LOGISTICA');
      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'órdenes pendientes', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      const respuesta = res.json.mock.calls[0][0];
      expect(respuesta._debug.erp_meta.error).toBe('logistica down');
    });
  });

  describe('combinación de refinamiento (motor erp_search)', () => {
    test('combina el término actual con el de la consulta anterior cuando el asistente pidió refinar', async () => {
      const config = makeConfig('erp_search', { productos_url: 'https://erp.test/productos' });
      const chainConfig  = buildChain({ data: config, error: null });
      const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
      const chainHistory = buildChain({
        data: [
          { content: 'busco neumaticos', sender_type: 'USER' },
          { content: 'Encontré muchos resultados, ¿puedes especificar la medida?', sender_type: 'IA' },
        ],
        error: null,
      });
      const chainMessages = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainSession)
        .mockReturnValueOnce(chainHistory)
        .mockReturnValueOnce(chainMessages);

      buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'neumatico 29 2.10', termino_original: 'neumatico 29 2.10', fue_relajado: false } });

      setupFetch({
        '29 2.10':          { termino: '29 2.10', filtro: 'busqueda_general' },
        'busco neumaticos': { termino: 'neumatico', filtro: 'busqueda_general' },
      });

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: '29 2.10', agent_id: 'tpl-1', session_chat_id: 's1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: 'neumatico 29 2.10' }));
    });
  });

  describe('casos restantes de persistencia e historial', () => {
    test('sin mensajes previos en BD, el historial queda vacío', async () => {
      const config = makeConfig('erp_search', null);
      const chainConfig  = buildChain({ data: config, error: null });
      const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
      const chainHistory = buildChain({ data: [], error: null });
      const chainMessages = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainSession)
        .mockReturnValueOnce(chainHistory)
        .mockReturnValueOnce(chainMessages);

      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola', agent_id: 'tpl-1', session_chat_id: 's1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      const respuesta = res.json.mock.calls[0][0];
      expect(respuesta._debug.intencion.termino).toBe('hola');
    });

    test('si falla la creación de la sesión nueva, no inserta mensajes y responde 200', async () => {
      const config = makeConfig('erp_search', null);
      const chainConfig     = buildChain({ data: config, error: null });
      const chainNewSession = buildChain({ data: null, error: { message: 'insert session failed' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainConfig)
        .mockReturnValueOnce(chainNewSession);

      setupFetch();

      const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola', agent_id: 'tpl-1' } };
      const res = mockRes();

      await processChatMessage(req, res);

      expect(supabase.from).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ session_chat_id: null }));
    });
  });
});