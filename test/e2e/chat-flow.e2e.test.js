// backend/test/e2e/chat-flow.e2e.test.js
//
//   1. Login -> obtiene su JWT real generado por el propio sistema
//   2. Entra al chat y hace su primera pregunta -> se crea la sesión,
//      el agente responde
//   3. Continúa la conversación -> segunda pregunta en la MISMA sesión,
//      demostrando que el historial persiste entre turnos
//   4. Revisa su historial -> ve la sesión en su lista y puede abrir
//      el detalle con ambos mensajes


'use strict';

jest.mock('../../config/supabase');
jest.mock('@supabase/supabase-js', () => {
  const mockAuthFromInner = jest.fn();
  return {
    createClient: jest.fn(() => ({ from: mockAuthFromInner })),
    __mockAuthFrom: mockAuthFromInner,
  };
});
jest.mock('bcrypt');

const bcrypt              = require('bcrypt');
const supabaseChat        = require('../../config/supabase'); // usado por chat/sessions controllers
const { __mockAuthFrom: mockAuthFrom } = require('@supabase/supabase-js'); // usado solo por auth.controller

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

describe('E2E — flujo de negocio: login, conversar con el agente, revisar historial', () => {
  let request;
  let app;

  // Estado compartido entre pasos del flujo, igual que lo vería un usuario real
  let token;
  let sessionId;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV   = 'development';
    request = require('supertest');
    app     = require('../../app');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Paso 1 — el usuario inicia sesión y recibe un token JWT válido', async () => {
    bcrypt.compare = jest.fn().mockResolvedValue(true);
    mockAuthFrom.mockReturnValue(buildChain({
      data: [{
        id: 'u1', email: 'vendedor@acme.com', password_hash: 'hash',
        username: 'vendedor', role: 'USER', company_id: 'co1',
      }],
      error: null,
    }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'vendedor@acme.com', password: 'clave123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.username).toBe('vendedor');

    token = res.body.token; // se reutiliza en los pasos siguientes
  });

  test('Paso 2 — el usuario hace su primera pregunta al agente y recibe respuesta', async () => {
    const agentConfig = {
      id: 'ca1',
      custom_instructions: 'Eres un asistente de bodega.',
      temperature: 0.3,
      max_memory_messages: 6,
      agent_templates: { base_system_prompt: '', allowed_tools: [], motor: 'erp_search' },
      companies: { name: 'ACME', erp_base_url: null, erp_mapping: null, business_context: '' },
    };

    supabaseChat.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: agentConfig, error: null })) // 1. carga config del agente
      .mockReturnValueOnce(buildChain({ data: { id: 'session-e2e-1' }, error: null })) // 2. crea sesión nueva
      .mockReturnValueOnce(buildChain({ error: null })); // 3. inserta los 2 mensajes (user + IA)

    global.fetch = jest.fn((url) => Promise.resolve({
      ok: true,
      json: async () => ({ reply: 'Hola, tenemos triciclos eléctricos en stock. ¿Buscas algo en particular?', prompt_tokens: 10, completion_tokens: 15 }),
      text: async () => '',
    }));

    const res = await request(app)
      .post('/api/chat/message')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hola, ¿tienen triciclos eléctricos?', agent_id: 'tpl-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reply).toContain('triciclos eléctricos');
    expect(res.body.session_chat_id).toBe('session-e2e-1');

    sessionId = res.body.session_chat_id; // se reutiliza en los pasos siguientes
  });

  test('Paso 3 — el usuario continúa la conversación en la misma sesión', async () => {
    const agentConfig = {
      id: 'ca1',
      custom_instructions: 'Eres un asistente de bodega.',
      temperature: 0.3,
      max_memory_messages: 6,
      agent_templates: { base_system_prompt: '', allowed_tools: [], motor: 'erp_search' },
      companies: { name: 'ACME', erp_base_url: null, erp_mapping: null, business_context: '' },
    };

    supabaseChat.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: agentConfig, error: null }))                          // 1. carga config
      .mockReturnValueOnce(buildChain({ data: { id: sessionId, users_id: 'u1' }, error: null }))     // 2. verifica ownership de la sesión
      .mockReturnValueOnce(buildChain({                                                              // 3. trae historial previo
        data: [
          { content: 'Hola, ¿tienen triciclos eléctricos?', sender_type: 'USER' },
          { content: 'Hola, tenemos triciclos eléctricos en stock. ¿Buscas algo en particular?', sender_type: 'IA' },
        ],
        error: null,
      }))
      .mockReturnValueOnce(buildChain({ error: null })); // 4. inserta los 2 mensajes nuevos

    global.fetch = jest.fn((url) => Promise.resolve({
      ok: true,
      json: async () => ({ reply: 'El modelo de carga cuesta $450.000 e incluye batería de litio.', prompt_tokens: 12, completion_tokens: 18 }),
      text: async () => '',
    }));

    const res = await request(app)
      .post('/api/chat/message')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '¿Cuánto cuesta el de carga?', agent_id: 'tpl-1', session_chat_id: sessionId });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain('450.000');
    expect(res.body.session_chat_id).toBe(sessionId); // misma sesión, no se creó una nueva
  });

  test('Paso 4 — el usuario revisa su historial: la sesión aparece en la lista y puede ver el detalle', async () => {
    supabaseChat.from = jest.fn()
      .mockReturnValueOnce(buildChain({                                          // GET /api/sessions
        data: [{
          id: sessionId, created_at: '2026-06-16T10:00:00Z', alerted: false, seen: true,
          company_agents: { agent_template_id: 'tpl-1', custom_instructions: 'Eres un asistente de bodega.' },
        }],
        error: null,
      }));

    const resLista = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${token}`);

    expect(resLista.status).toBe(200);
    expect(resLista.body.sessions).toHaveLength(1);
    expect(resLista.body.sessions[0].id).toBe(sessionId);

    supabaseChat.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: { id: sessionId, users_id: 'u1' }, error: null })) // ownership check
      .mockReturnValueOnce(buildChain({                                                           // mensajes de la sesión
        data: [
          { id: 'm1', content: 'Hola, ¿tienen triciclos eléctricos?', sender_type: 'USER', prompt_tokens: 0, completion_tokens: 0, created_at: '2026-06-16T10:00:00Z' },
          { id: 'm2', content: 'Hola, tenemos triciclos eléctricos en stock. ¿Buscas algo en particular?', sender_type: 'IA', prompt_tokens: 10, completion_tokens: 15, created_at: '2026-06-16T10:00:05Z' },
          { id: 'm3', content: '¿Cuánto cuesta el de carga?', sender_type: 'USER', prompt_tokens: 0, completion_tokens: 0, created_at: '2026-06-16T10:01:00Z' },
          { id: 'm4', content: 'El modelo de carga cuesta $450.000 e incluye batería de litio.', sender_type: 'IA', prompt_tokens: 12, completion_tokens: 18, created_at: '2026-06-16T10:01:05Z' },
        ],
        error: null,
      }));

    const resDetalle = await request(app)
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${token}`);

    expect(resDetalle.status).toBe(200);
    expect(resDetalle.body.messages).toHaveLength(4); // las 2 preguntas + las 2 respuestas del flujo completo
  });
});