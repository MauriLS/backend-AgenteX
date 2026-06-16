// backend/test/controllers/chat.controller.gaps2.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/erp-search.service');
jest.mock('../../services/analytics.service');
jest.mock('../../services/sales-search.service');
jest.mock('../../services/logistics-search.service');

const supabase = require('../../config/supabase');
const { buscarParaVentas, formatearVentasParaLLM } = require('../../services/sales-search.service');
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
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function setupFetch(deepseekRespuestas = {}, pythonReply = { reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }) {
  global.fetch = jest.fn((url, opts) => {
    if (String(url).includes('deepseek.com')) {
      const body = JSON.parse(opts.body);
      const userMsg = body.messages[1].content;
      const intencion = deepseekRespuestas[userMsg] || { termino: 'producto', filtro: 'busqueda_general' };
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(intencion) } }] }) });
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

describe('chat.controller — última rama OR de candidatos previos (ventas)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  test('detecta candidatos previos con la frase "cuál es el cliente correcto" en el flujo completo', async () => {
    const candidatosPrevios = [{ id: 'c1', nombre: 'Juan Perez' }, { id: 'c2', nombre: 'Juan Soto' }];
    const config = makeConfig('ventas', { productos_url: 'https://erp.test/productos', _candidatos_previos: candidatosPrevios });
    const chainConfig  = buildChain({ data: config, error: null });
    const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
    const chainHistory = buildChain({
      data: [
        { content: 'busco a Juan', sender_type: 'USER' },
        { content: 'No tengo claro cuál es el cliente correcto, dime el RUT', sender_type: 'IA' },
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

    setupFetch({ '12345678-9': { termino: 'rut', filtro: 'busqueda_general' } });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: '12345678-9', agent_id: 'tpl-1', session_chat_id: 's1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    const llamada = buscarParaVentas.mock.calls[0][0];
    expect(llamada.erpMapping._candidatos_previos).toEqual(candidatosPrevios);
  });

  test('motor ventas: mensaje del asistente sin ninguna frase de desambiguación deja candidatos_previos en null', async () => {
    const config = makeConfig('ventas', { productos_url: 'https://erp.test/productos', _candidatos_previos: [{ id: 'c1', nombre: 'Juan' }] });
    const chainConfig  = buildChain({ data: config, error: null });
    const chainSession = buildChain({ data: { id: 's2', users_id: 'u1' }, error: null });
    const chainHistory = buildChain({
      data: [
        { content: 'tienen bicicletas?', sender_type: 'USER' },
        { content: 'Sí, tenemos varios modelos disponibles en stock.', sender_type: 'IA' },
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
      productos: [], metaProductos: {}, identificacion: { estado: 'no_encontrado' },
      perfilCliente: null, totalClientes: 0, candidatos: null,
    });
    formatearVentasParaLLM.mockReturnValue('NIVEL4_VENTAS');

    setupFetch({ 'cuál es el precio?': { termino: 'precio', filtro: 'busqueda_general' } });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'cuál es el precio?', agent_id: 'tpl-1', session_chat_id: 's2' } };
    const res = mockRes();

    await processChatMessage(req, res);

    const llamada = buscarParaVentas.mock.calls[0][0];
    expect(llamada.erpMapping._candidatos_previos).toBeNull();
  });
});