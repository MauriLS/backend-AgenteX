// backend/test/integration/sessions.integration.test.js
//
// Test de integración: rutas de sessions a través de supertest contra app.js.
// Ejercita verifyToken real y el controller completo. Solo se mockea
// config/supabase.js (cliente único compartido por este controller).

'use strict';

jest.mock('../../config/supabase');

const jwt      = require('jsonwebtoken');
const supabase = require('../../config/supabase');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq:     jest.fn(() => chain),
    order:  jest.fn(() => chain),
    limit:  jest.fn(() => chain),
    in:     jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function makeToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('rutas /api/sessions — integración', () => {
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

  describe('GET /api/sessions', () => {
    test('sin token devuelve 401', async () => {
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(401);
    });

    test('token válido devuelve la lista de sesiones del usuario', async () => {
      const sessions = [
        { id: 's1', created_at: '2026-06-01T00:00:00Z', alerted: false, seen: true, company_agents: { agent_template_id: 'tpl-1', custom_instructions: 'x' } },
      ];
      supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: sessions, error: null }));

      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sessions).toEqual(sessions);
    });

    test('error de BD devuelve 500', async () => {
      supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: null, error: { message: 'conexión perdida' } }));

      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('conexión perdida');
    });
  });

  describe('GET /api/sessions/:id/messages', () => {
    test('sesión de otro usuario devuelve 404 (ownership check)', async () => {
      supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: { id: 's1', users_id: 'otro-usuario' }, error: null }));

      const res = await request(app)
        .get('/api/sessions/s1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    test('sesión propia devuelve los mensajes ordenados', async () => {
      const messages = [{ id: 'm1', content: 'hola', sender_type: 'USER', prompt_tokens: 0, completion_tokens: 0, created_at: '2026-06-01T00:00:00Z' }];
      supabase.from = jest.fn()
        .mockReturnValueOnce(buildChain({ data: { id: 's1', users_id: 'u1' }, error: null }))
        .mockReturnValueOnce(buildChain({ data: messages, error: null }));

      const res = await request(app)
        .get('/api/sessions/s1/messages')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual(messages);
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    test('sesión de otro usuario devuelve 404', async () => {
      supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: { id: 's1', users_id: 'otro-usuario' }, error: null }));

      const res = await request(app)
        .delete('/api/sessions/s1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    test('sesión propia se elimina correctamente', async () => {
      supabase.from = jest.fn()
        .mockReturnValueOnce(buildChain({ data: { id: 's1', users_id: 'u1' }, error: null }))
        .mockReturnValueOnce(buildChain({ error: null }));

      const res = await request(app)
        .delete('/api/sessions/s1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/sessions/stats', () => {
    test('sin sesiones devuelve stats vacío', async () => {
      supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: [], error: null }));

      const res = await request(app)
        .get('/api/sessions/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.stats).toEqual([]);
    });

    test('con sesiones y mensajes agrega métricas por agente', async () => {
      const sessions = [{ id: 's1', company_agents: { agent_template_id: 'tpl-1', agent_templates: { name: 'Bodega' } } }];
      const messages  = [{ session_chat_id: 's1', sender_type: 'USER', prompt_tokens: 10, completion_tokens: 20 }];

      supabase.from = jest.fn()
        .mockReturnValueOnce(buildChain({ data: sessions, error: null }))
        .mockReturnValueOnce(buildChain({ data: messages, error: null }));

      const res = await request(app)
        .get('/api/sessions/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.stats).toHaveLength(1);
      expect(res.body.stats[0]).toEqual(expect.objectContaining({
        agent_id: 'tpl-1', agent_name: 'Bodega', total_sesiones: 1, total_preguntas: 1,
        prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
      }));
    });
  });
});