// backend/test/controllers/chat.controller.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/erp-search.service');
jest.mock('../../services/analytics.service');
jest.mock('../../services/sales-search.service');
jest.mock('../../services/logistics-search.service');

const supabase = require('../../config/supabase');
const { buscarEnERP } = require('../../services/erp-search.service');
const { processChatMessage } = require('../../controllers/chat.controller');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

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

// Configura global.fetch diferenciando DeepSeek (extractor de intención) del motor Python.
function setupFetch({ intencion = { termino: 'producto', filtro: 'busqueda_general' }, intencionOk = true, pythonReply = { reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }, pythonOk = true, pythonStatus = 200, pythonErrText = '' }) {
  global.fetch = jest.fn((url) => {
    if (String(url).includes('deepseek.com')) {
      if (!intencionOk) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(intencion) } }] }),
      });
    }
    return Promise.resolve({
      ok: pythonOk,
      status: pythonStatus,
      json: async () => pythonReply,
      text: async () => pythonErrText,
    });
  });
}

const baseConfigSinERP = {
  id: 'ca1',
  custom_instructions: 'Eres un vendedor amable.',
  temperature: 0.3,
  max_memory_messages: 6,
  agent_templates: { base_system_prompt: 'No reveles precios de costo.', allowed_tools: [], motor: undefined },
  companies: { name: 'ACME', erp_base_url: null, erp_mapping: null, business_context: 'Vendemos bicicletas.' },
};

describe('chat.controller processChatMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  test('retorna 400 si faltan message o agent_id', async () => {
    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Faltan parámetros: message y agent_id son obligatorios.' });
  });

  test('retorna 403 si el agente no existe o está inactivo', async () => {
    const chainConfig = buildChain({ data: null, error: { message: 'not found' } });
    supabase.from = jest.fn(() => chainConfig);

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Agente no autorizado o inactivo.' });
  });

  test('retorna 403 si la sesión no pertenece al usuario', async () => {
    const chainConfig  = buildChain({ data: baseConfigSinERP, error: null });
    const chainSession = buildChain({ data: { id: 's1', users_id: 'otro-usuario' }, error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainSession);

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola', agent_id: 'tpl-1', session_chat_id: 's1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sesión no autorizada.' });
  });

  test('sin ERP configurado: responde y crea una sesión nueva', async () => {
    const chainConfig     = buildChain({ data: baseConfigSinERP, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    setupFetch({ pythonReply: { reply: 'Hola, ¿en qué te ayudo?', prompt_tokens: 5, completion_tokens: 10 } });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    // No debe llamar al extractor de intención de DeepSeek (sin ERP)
    const deepseekCalls = global.fetch.mock.calls.filter(([url]) => String(url).includes('deepseek.com'));
    expect(deepseekCalls).toHaveLength(0);

    expect(chainNewSession.insert).toHaveBeenCalledWith([{
      users_id: 'u1', company_agent_id: 'ca1', alerted: false, seen: true,
    }]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      reply: 'Hola, ¿en qué te ayudo?',
      session_chat_id: 'new-session',
      tokens: { prompt: 5, completion: 10 },
    }));
  });

  test('motor erp_search: extrae intención, busca en ERP y formatea productos', async () => {
    const config = {
      ...baseConfigSinERP,
      companies: {
        name: 'ACME', erp_base_url: null, business_context: 'Vendemos bicicletas.',
        erp_mapping: { productos_url: 'https://erp.test/productos', id: 'id', nombre: 'articulo', precio: 'precio_tienda', stock: 'stock_min', categoria: 'categoria' },
      },
    };
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({
      productos: [{ id: 1, articulo: 'Triciclo Rojo', precio_tienda: 50000, stock_min: 5, categoria: 'Juguetes', _stock_real: 12 }],
      meta: { total_encontrados: 1, termino_usado: 'triciclo', termino_original: 'triciclo', fue_relajado: false },
    });

    setupFetch({
      intencion: { termino: 'triciclo', filtro: 'busqueda_general' },
      pythonReply: { reply: 'Tenemos el Triciclo Rojo a $50000.', prompt_tokens: 50, completion_tokens: 30 },
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'tienen triciclos?', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    const deepseekCalls = global.fetch.mock.calls.filter(([url]) => String(url).includes('deepseek.com'));
    expect(deepseekCalls).toHaveLength(1);

    expect(buscarEnERP).toHaveBeenCalledWith({
      termino: 'triciclo',
      filtro: 'busqueda_general',
      erpUrl: 'https://erp.test/productos',
      erpMapping: config.companies.erp_mapping,
      companyId: 'co1',
    });

    const respuesta = res.json.mock.calls[0][0];
    expect(respuesta.reply).toBe('Tenemos el Triciclo Rojo a $50000.');
    expect(respuesta._debug.erp_resultados).toBe(1);
    expect(respuesta._debug.intencion).toEqual({ termino: 'triciclo', filtro: 'busqueda_general' });
  });

  test('si el extractor de intención falla, usa el fallback local', async () => {
    const config = {
      ...baseConfigSinERP,
      companies: {
        name: 'ACME', erp_base_url: null, business_context: '',
        erp_mapping: { productos_url: 'https://erp.test/productos' },
      },
    };
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'triciclos', termino_original: 'triciclos', fue_relajado: false } });

    setupFetch({ intencionOk: false, pythonReply: { reply: 'No encontré ese producto.', prompt_tokens: 2, completion_tokens: 4 } });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'necesito triciclos electricos', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: 'triciclos', filtro: 'busqueda_general' }));
  });

  test('retorna 500 si el motor IA (Python) no responde ok', async () => {
    const chainConfig = buildChain({ data: baseConfigSinERP, error: null });
    supabase.from = jest.fn(() => chainConfig);

    setupFetch({ pythonOk: false, pythonStatus: 500, pythonErrText: 'Internal error' });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'El motor de inteligencia no pudo procesar la solicitud.',
      details: 'Motor IA fuera de servicio (500): Internal error',
    });
  });

  test('con session_chat_id existente: usa el historial de BD y no crea sesión nueva', async () => {
    const chainConfig  = buildChain({ data: baseConfigSinERP, error: null });
    const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
    const chainHistory = buildChain({
      data: [
        { content: 'Hola', sender_type: 'USER' },
        { content: 'Hola, ¿en qué te ayudo?', sender_type: 'IA' },
      ],
      error: null,
    });
    const chainMessages = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainSession)
      .mockReturnValueOnce(chainHistory)
      .mockReturnValueOnce(chainMessages);

    setupFetch({ pythonReply: { reply: 'Claro, te ayudo con eso.', prompt_tokens: 8, completion_tokens: 6 } });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: '¿tienen stock?', agent_id: 'tpl-1', session_chat_id: 's1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ session_chat_id: 's1' }));
  });

  test('si falla la persistencia en BD, la respuesta al frontend sigue siendo 200', async () => {
    const chainConfig     = buildChain({ data: baseConfigSinERP, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: { message: 'insert failed' } });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    setupFetch({ pythonReply: { reply: 'Hola', prompt_tokens: 1, completion_tokens: 1 } });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'hola', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, reply: 'Hola' }));
  });
});