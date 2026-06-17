// backend/test/integration/chat.message.integration.test.js
//
// Test de integración: POST /api/chat/message a través de supertest contra
// la app real (app.js), pasando por verifyToken real (JWT firmado de verdad)
// y el controller completo. Se mockean solo las dependencias externas:
// config/supabase.js (cliente único compartido) y fetch global (DeepSeek + Python).

'use strict';

jest.mock('../../config/supabase');

const jwt      = require('jsonwebtoken');
const supabase = require('../../config/supabase');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    eq:     jest.fn(() => chain),
    order:  jest.fn(() => chain),
    limit:  jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function makeToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('POST /api/chat/message — integración', () => {
  let request;
  let app;
  let token;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV   = 'development';
    request = require('supertest');
    app     = require('../../app');
    token   = makeToken({ id: 'u1', role: 'ADMIN', company_id: 'co1' });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sin token devuelve 401 antes de llegar al controller', async () => {
    const res = await request(app)
      .post('/api/chat/message')
      .send({ message: 'hola', agent_id: 'tpl-1' });

    expect(res.status).toBe(401);
  });

  test('token válido + agente sin ERP configurado -> 200 con respuesta del motor IA', async () => {
    const config = {
      id: 'ca1',
      custom_instructions: 'Eres un asistente.',
      temperature: 0.3,
      max_memory_messages: 6,
      agent_templates: { base_system_prompt: '', allowed_tools: [], motor: 'erp_search' },
      companies: { name: 'ACME', erp_base_url: null, erp_mapping: null, business_context: '' },
    };

    const chainConfig     = buildChain({ data: config, error: null });
    const chainNewSession = buildChain({ data: { id: 'new-session-1' }, error: null });
    const chainMessages   = buildChain({ error: null });
    supabase.from = jest.fn()
      .mockReturnValueOnce(chainConfig)
      .mockReturnValueOnce(chainNewSession)
      .mockReturnValueOnce(chainMessages);

    global.fetch = jest.fn((url) => {
      // Sin erp_mapping.productos_url -> tieneERP es false, nunca llama a DeepSeek
      return Promise.resolve({
        ok: true,
        json: async () => ({ reply: 'Hola, soy tu asistente. ¿En qué te ayudo?', prompt_tokens: 5, completion_tokens: 8 }),
        text: async () => '',
      });
    });

    const res = await request(app)
      .post('/api/chat/message')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hola', agent_id: 'tpl-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reply).toBe('Hola, soy tu asistente. ¿En qué te ayudo?');
    expect(res.body.session_chat_id).toBe('new-session-1');
  });

  test('falta message en el body -> 400 sin tocar la BD', async () => {
    const res = await request(app)
      .post('/api/chat/message')
      .set('Authorization', `Bearer ${token}`)
      .send({ agent_id: 'tpl-1' }); // sin message

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('obligatorios');
  });

  test('agente no encontrado en BD -> 403', async () => {
    const chainConfig = buildChain({ data: null, error: { message: 'not found' } });
    supabase.from = jest.fn().mockReturnValueOnce(chainConfig);

    const res = await request(app)
      .post('/api/chat/message')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hola', agent_id: 'tpl-inexistente' });

    expect(res.status).toBe(403);
  });

  test('token inválido/expirado devuelve 403', async () => {
    const tokenInvalido = jwt.sign({ id: 'u1' }, 'otro-secret-distinto');

    const res = await request(app)
      .post('/api/chat/message')
      .set('Authorization', `Bearer ${tokenInvalido}`)
      .send({ message: 'hola', agent_id: 'tpl-1' });

    expect(res.status).toBe(403);
  });
});