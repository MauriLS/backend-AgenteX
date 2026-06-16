// backend/test/controllers/chat.controller.gaps.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/erp-search.service');
jest.mock('../../services/analytics.service');
jest.mock('../../services/sales-search.service');
jest.mock('../../services/logistics-search.service');

const supabase = require('../../config/supabase');
const { buscarEnERP } = require('../../services/erp-search.service');
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

describe('chat.controller processChatMessage - ramas faltantes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  test('formatearProductos: meta.es_conteo genera el mensaje de conteo (motor erp_search)', async () => {
    const config = makeConfig('erp_search', { productos_url: 'https://erp.test/productos' });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({
      productos: [],
      meta: { es_conteo: true, total_encontrados: 7, termino_usado: 'triciclo', termino_original: 'triciclo', fue_relajado: false },
    });

    setupFetch({ 'cuántos triciclos tengo?': { termino: 'triciclo', filtro: 'conteo_total' } },
      { reply: 'Tienes 7 triciclos en inventario.', prompt_tokens: 1, completion_tokens: 1 });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'cuántos triciclos tengo?', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reply: 'Tienes 7 triciclos en inventario.' }));
  });

  test('formatearProductos: meta.demasiados genera el bloqueo total (motor erp_search)', async () => {
    const config = makeConfig('erp_search', { productos_url: 'https://erp.test/productos' });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({
      productos: [],
      meta: { demasiados: true, total_encontrados: 120, termino_usado: 'producto', termino_original: 'producto', fue_relajado: false },
    });

    setupFetch({ 'tienen productos?': { termino: 'producto', filtro: 'busqueda_general' } },
      { reply: '¿Puedes especificar más?', prompt_tokens: 1, completion_tokens: 1 });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'tienen productos?', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reply: '¿Puedes especificar más?' }));
  });

  test('refinamiento: combina término actual con el de la consulta anterior real (penultimoUser existe y esRefinamiento es true)', async () => {
    const config = makeConfig('erp_search', { productos_url: 'https://erp.test/productos' });
    const chainConfig  = buildChain({ data: config, error: null });
    const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
    // Historial: el usuario primero pidió "neumaticos", el asistente pidió refinar,
    // luego el usuario respondió con la medida "29 2.10" (mensaje actual).
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
      '29 2.10':          { termino: '29 2.10', filtro: 'busqueda_general' }, // término actual: corto (<=2 tokens)
      'busco neumaticos':  { termino: 'neumatico', filtro: 'busqueda_general' }, // término anterior
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: '29 2.10', agent_id: 'tpl-1', session_chat_id: 's1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    // Confirma que penultimoUser fue encontrado y esRefinamiento combinó los términos
    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: 'neumatico 29 2.10' }));
  });

  test('refinamiento: penultimoUser no existe (todo el historial es del mismo mensaje actual) deja el término sin combinar', async () => {
    const config = makeConfig('erp_search', { productos_url: 'https://erp.test/productos' });
    const chainConfig  = buildChain({ data: config, error: null });
    const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
    // El único mensaje de usuario en el historial es idéntico al mensaje actual,
    // por lo que el filtro `m.content.trim() !== message.trim()` no encuentra penultimoUser.
    const chainHistory = buildChain({
      data: [
        { content: '29 2.10', sender_type: 'USER' },
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

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: '29 2.10', termino_original: '29 2.10', fue_relajado: false } });

    setupFetch({ '29 2.10': { termino: '29 2.10', filtro: 'busqueda_general' } });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: '29 2.10', agent_id: 'tpl-1', session_chat_id: 's1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: '29 2.10' }));
  });

  test('refinamiento: penultimoUser existe pero esRefinamiento es false (término largo) no combina', async () => {
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

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'neumatico mtb aro 29 doble compuesto', termino_original: 'neumatico mtb aro 29 doble compuesto', fue_relajado: false } });

    // El término actual extraído tiene más de 2 tokens → esRefinamiento debe ser false
    setupFetch({
      'neumatico mtb aro 29 doble compuesto': { termino: 'neumatico mtb aro 29 doble compuesto', filtro: 'busqueda_general' },
      'busco neumaticos': { termino: 'neumatico', filtro: 'busqueda_general' },
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'neumatico mtb aro 29 doble compuesto', agent_id: 'tpl-1', session_chat_id: 's1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: 'neumatico mtb aro 29 doble compuesto' }));
  });

  test('motor ventas: detecta candidatos previos con la frase "podrían coincidir"', async () => {
    const candidatosPrevios = [{ id: 'c1', nombre: 'Juan Perez' }, { id: 'c2', nombre: 'Juan Soto' }];
    const config = makeConfig('ventas', { productos_url: 'https://erp.test/productos', _candidatos_previos: candidatosPrevios });
    const chainConfig  = buildChain({ data: config, error: null });
    const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
    const chainHistory = buildChain({
      data: [
        { content: 'busco a Juan', sender_type: 'USER' },
        { content: 'Encontré 2 clientes que podrían coincidir, ¿cuál es?', sender_type: 'IA' },
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
});