// backend/test/controllers/chat.controller.gaps3.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/erp-search.service');

const supabase = require('../../config/supabase');
const { buscarEnERP } = require('../../services/erp-search.service');
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

function makeConfig(erpMapping) {
  return {
    id: 'ca1',
    custom_instructions: 'Eres un asistente.',
    temperature: 0.3,
    max_memory_messages: 6,
    agent_templates: { base_system_prompt: '', allowed_tools: [], motor: 'erp_search' },
    companies: { name: 'ACME', erp_base_url: null, erp_mapping: erpMapping, business_context: '' },
  };
}

describe('chat.controller — catches finales en rojo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
  });

  test('extraerIntencion: DeepSeek responde JSON malformado -> catch interno usa mensaje crudo (líneas 141-142)', async () => {
    const config = makeConfig({ productos_url: 'https://erp.test/productos' });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'producto', termino_original: 'producto', fue_relajado: false } });

    global.fetch = jest.fn((url) => {
      if (String(url).includes('deepseek.com')) {
        // Respuesta ok:true pero con contenido que no parsea como JSON -> dispara el catch interno
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'esto no es json valido {{{' } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'tienen productos', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    // El fallback del catch interno normaliza el mensaje crudo como término
    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: 'tienen productos' }));
  });

  test('refinamiento: extraerIntencion del penúltimo mensaje falla -> catch de contexto anterior (líneas ~376)', async () => {
    const config = makeConfig({ productos_url: 'https://erp.test/productos' });
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

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: '29 2.10', termino_original: '29 2.10', fue_relajado: false } });

    let callCount = 0;
    global.fetch = jest.fn((url, opts) => {
      if (String(url).includes('deepseek.com')) {
        callCount++;
        const body = JSON.parse(opts.body);
        const userMsg = body.messages[1].content;
        if (userMsg === 'busco neumaticos') {
          // La extracción del término ANTERIOR (penultimoUser) falla con error de red
          return Promise.reject(new Error('Timeout de red simulando fallo de extracción de contexto anterior'));
        }
        // La extracción del mensaje actual funciona normal
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"29 2.10","filtro":"busqueda_general"}' } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: '29 2.10', agent_id: 'tpl-1', session_chat_id: 's1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    // El catch atrapó el fallo y el término actual queda sin combinar
    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: '29 2.10' }));
  });

  test('motor erp_search: buscarEnERP lanza excepción -> catch del router de motores (líneas 488-489)', async () => {
    const config = makeConfig({ productos_url: 'https://erp.test/productos' });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockRejectedValue(new Error('Conexión al ERP rechazada'));

    global.fetch = jest.fn((url) => {
      if (String(url).includes('deepseek.com')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"producto","filtro":"busqueda_general"}' } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'Inventario no disponible por el momento.', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'tienen productos', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessage(req, res);

    // El catch capturó el error de buscarEnERP y la respuesta sigue siendo 200
    // porque metaERP = { error: ... } se propaga al formateador en vez de hacer throw.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      _debug: expect.objectContaining({ erp_meta: expect.objectContaining({ error: 'Conexión al ERP rechazada' }) }),
    }));
  });
});