// backend/test/controllers/chat.controller.gaps4.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/erp-search.service');

const supabase = require('../../config/supabase');
const { buscarEnERP } = require('../../services/erp-search.service');

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

function makeConfig({ erpMapping, name = 'ACME', customInstructions = 'Eres un asistente.' }) {
  return {
    id: 'ca1',
    custom_instructions: customInstructions,
    temperature: 0.3,
    max_memory_messages: 6,
    agent_templates: { base_system_prompt: '', allowed_tools: [], motor: 'erp_search' },
    companies: { name, erp_base_url: null, erp_mapping: erpMapping, business_context: '' },
  };
}

describe('chat.controller — operadores OR (valores default) en amarillo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = 'test-key';
    delete process.env.PYTHON_ENGINE_URL;
  });

  test('PYTHON_ENGINE_URL definido en env -> usa esa URL en vez del fallback localhost', async () => {
    process.env.PYTHON_ENGINE_URL = 'https://python.test/api/ia/process';
    // Reimport para que el módulo capture la env var al cargarse
    jest.resetModules();
    jest.doMock('../../config/supabase', () => supabase);
    jest.doMock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../../services/erp-search.service', () => ({ buscarEnERP }));
    const { processChatMessage: processChatMessageFresh } = require('../../controllers/chat.controller');

    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' } });
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
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"producto","filtro":"busqueda_general"}' } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'tienen productos', agent_id: 'tpl-1' } };
    const res = mockRes();

    await processChatMessageFresh(req, res);

    const pythonCall = global.fetch.mock.calls.find(c => c[0] === 'https://python.test/api/ia/process');
    expect(pythonCall).toBeDefined();

    delete process.env.PYTHON_ENGINE_URL;
  });

  test('extraerIntencion con parsed.termino y parsed.filtro vacíos cae a los defaults (mensaje crudo y busqueda_general)', async () => {
    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' } });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'producto rojo', termino_original: 'producto rojo', fue_relajado: false } });

    global.fetch = jest.fn((url) => {
      if (String(url).includes('deepseek.com')) {
        // termino y filtro vacíos -> el código cae a `mensajeUsuario` y 'busqueda_general'
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"","filtro":""}' } }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'producto rojo', agent_id: 'tpl-1' } };
    const res = mockRes();

    const { processChatMessage } = require('../../controllers/chat.controller');
    await processChatMessage(req, res);

    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: 'producto rojo', filtro: 'busqueda_general' }));
  });

  test('formatearProductos: fue_relajado true con cero resultados agrega el texto de intento adicional', async () => {
    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' } });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'neumatico', termino_original: 'neumatico 29 2.10', fue_relajado: true } });

    let capturedSystemPrompt = null;
    global.fetch = jest.fn((url, opts) => {
      if (String(url).includes('deepseek.com')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"neumatico 29 2.10","filtro":"busqueda_general"}' } }] }) });
      }
      capturedSystemPrompt = JSON.parse(opts.body).system_prompt;
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'neumatico 29 2.10', agent_id: 'tpl-1' } };
    const res = mockRes();

    const { processChatMessage } = require('../../controllers/chat.controller');
    await processChatMessage(req, res);

    expect(capturedSystemPrompt).toContain('tampoco hubo resultados');
  });

  test('formatearProductos: fue_relajado true CON productos encontrados agrega el aviso de aproximados', async () => {
    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' } });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({
      productos: [{ id: 1, articulo: 'Neumático Genérico', precio_tienda: 5000, stock_min: 10, categoria: 'Neumáticos', _stock_real: null }],
      meta: { total_encontrados: 1, termino_usado: 'neumatico', termino_original: 'neumatico 29 2.10', fue_relajado: true },
    });

    let capturedSystemPrompt = null;
    global.fetch = jest.fn((url, opts) => {
      if (String(url).includes('deepseek.com')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"neumatico 29 2.10","filtro":"busqueda_general"}' } }] }) });
      }
      capturedSystemPrompt = JSON.parse(opts.body).system_prompt;
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'neumatico 29 2.10', agent_id: 'tpl-1' } };
    const res = mockRes();

    const { processChatMessage } = require('../../controllers/chat.controller');
    await processChatMessage(req, res);

    expect(capturedSystemPrompt).toContain('Mostrando aproximados para');
  });

  test('formatearProductos: producto sin campo de stock definido muestra "No disponible"', async () => {
    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' } });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({
      // Sin _stock_real y sin el campo stock_min -> cae al string "No disponible"
      productos: [{ id: 1, articulo: 'Producto Sin Stock Definido', precio_tienda: 5000, categoria: 'General' }],
      meta: { total_encontrados: 1, termino_usado: 'producto', termino_original: 'producto', fue_relajado: false },
    });

    let capturedSystemPrompt = null;
    global.fetch = jest.fn((url, opts) => {
      if (String(url).includes('deepseek.com')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"producto","filtro":"busqueda_general"}' } }] }) });
      }
      capturedSystemPrompt = JSON.parse(opts.body).system_prompt;
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'producto', agent_id: 'tpl-1' } };
    const res = mockRes();

    const { processChatMessage } = require('../../controllers/chat.controller');
    await processChatMessage(req, res);

    expect(capturedSystemPrompt).toContain('Stock: No disponible');
  });

  test('fallback local: mensaje sin ningún sustantivo válido (todo stop words) cae a normalize(message) completo', async () => {
    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' } });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'x', termino_original: 'x', fue_relajado: false } });

    global.fetch = jest.fn((url) => {
      if (String(url).includes('deepseek.com')) {
        // El extractor LLM falla -> dispara el fallback local
        return Promise.reject(new Error('DeepSeek caído'));
      }
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    // Mensaje compuesto solo de stop words cortas -> ningún token pasa el filtro (length >= 4 y no stop word)
    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'de la el', agent_id: 'tpl-1' } };
    const res = mockRes();

    const { processChatMessage } = require('../../controllers/chat.controller');
    await processChatMessage(req, res);

    expect(buscarEnERP).toHaveBeenCalledWith(expect.objectContaining({ termino: 'de la el' }));
  });

  test('empresa sin name definido usa el fallback "la empresa" en NIVEL_1', async () => {
    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' }, name: null });
    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    buscarEnERP.mockResolvedValue({ productos: [], meta: { total_encontrados: 0, termino_usado: 'producto', termino_original: 'producto', fue_relajado: false } });

    let capturedSystemPrompt = null;
    global.fetch = jest.fn((url, opts) => {
      if (String(url).includes('deepseek.com')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"producto","filtro":"busqueda_general"}' } }] }) });
      }
      capturedSystemPrompt = JSON.parse(opts.body).system_prompt;
      return Promise.resolve({ ok: true, json: async () => ({ reply: 'ok', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'producto', agent_id: 'tpl-1' } };
    const res = mockRes();

    const { processChatMessage } = require('../../controllers/chat.controller');
    await processChatMessage(req, res);

    expect(capturedSystemPrompt).toContain('Eres parte del equipo de "la empresa"');
  });

  test('result.reply vacío/falsy en respuesta de Python usa el mensaje de error por defecto', async () => {
    const config = makeConfig({ erpMapping: { productos_url: 'https://erp.test/productos' } });
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
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"termino":"producto","filtro":"busqueda_general"}' } }] }) });
      }
      // reply ausente/vacío -> dispara el fallback 'Error: No se recibió respuesta del motor IA.'
      return Promise.resolve({ ok: true, json: async () => ({ reply: '', prompt_tokens: 1, completion_tokens: 1 }), text: async () => '' });
    });

    const req = { user: { id: 'u1', company_id: 'co1' }, body: { message: 'producto', agent_id: 'tpl-1' } };
    const res = mockRes();

    const { processChatMessage } = require('../../controllers/chat.controller');
    await processChatMessage(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reply: 'Error: No se recibió respuesta del motor IA.' }));
  });
});