// backend/test/integration/agent.integration.test.js
'use strict';

jest.mock('../../config/supabase');

const jwt      = require('jsonwebtoken');
const supabase = require('../../config/supabase');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq:     jest.fn(() => chain),
    order:  jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function makeToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('rutas /api/agents — integración', () => {
  let request, app, adminToken, userToken;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV   = 'development';
    request    = require('supertest');
    app        = require('../../app');
    adminToken = makeToken({ id: 'admin1', role: 'ADMIN', company_id: 'co1' });
    userToken  = makeToken({ id: 'user1',  role: 'USER',  company_id: 'co1' });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /api/agents/my-agents devuelve agentes activos del usuario', async () => {
    supabase.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: { company_id: 'co1' }, error: null }))
      .mockReturnValueOnce(buildChain({
        data: [{ id: 'ca1', agent_template_id: 'tpl-1', agent_templates: { name: 'Bodega' } }],
        error: null,
      }));

    const res = await request(app)
      .get('/api/agents/my-agents')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([{ instanceId: 'ca1', templateId: 'tpl-1', name: 'Bodega' }]);
  });

  test('GET /api/agents/templates devuelve todos los templates', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: [{ id: 'tpl-1', name: 'Bodega', motor: 'erp_search', allowed_tools: [] }],
      error: null,
    }));

    const res = await request(app)
      .get('/api/agents/templates')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
  });

  test('GET /api/agents sin rol ADMIN devuelve 403', async () => {
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  test('GET /api/agents con rol ADMIN devuelve los agentes de la empresa', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: [{ id: 'ca1', agent_template_id: 'tpl-1', custom_instructions: 'x', temperature: 0.3, is_active: true, created_at: '2026-01-01', agent_templates: { name: 'Bodega', motor: 'erp_search' } }],
      error: null,
    }));

    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
  });

  test('POST /api/agents sin agent_template_id devuelve 400', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ custom_instructions: 'Eres un bot' });

    expect(res.status).toBe(400);
  });

  test('POST /api/agents con template inexistente devuelve 404', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: null, error: null }));

    const res = await request(app)
      .post('/api/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_template_id: 'tpl-fantasma', custom_instructions: 'Eres un bot' });

    expect(res.status).toBe(404);
  });

  test('POST /api/agents con agente ya activo devuelve 409', async () => {
    supabase.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: { id: 'tpl-1', name: 'Bodega' }, error: null }))
      .mockReturnValueOnce(buildChain({ data: { id: 'ca-existente' }, error: null }));

    const res = await request(app)
      .post('/api/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_template_id: 'tpl-1', custom_instructions: 'Eres un bot' });

    expect(res.status).toBe(409);
  });

  test('POST /api/agents exitoso devuelve 201', async () => {
    supabase.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: { id: 'tpl-1', name: 'Bodega' }, error: null }))
      .mockReturnValueOnce(buildChain({ data: null, error: null }))
      .mockReturnValueOnce(buildChain({ data: { id: 'ca-new', agent_template_id: 'tpl-1', custom_instructions: 'Eres un bot', temperature: 0.3, is_active: true }, error: null }));

    const res = await request(app)
      .post('/api/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_template_id: 'tpl-1', custom_instructions: 'Eres un bot' });

    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBe('ca-new');
  });

  test('PATCH /api/agents/:id de agente de otra empresa devuelve 404', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: { id: 'ca1', company_id: 'co-otra' }, error: null }));

    const res = await request(app)
      .patch('/api/agents/ca1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ temperature: 0.5 });

    expect(res.status).toBe(404);
  });

  test('PATCH /api/agents/:id exitoso devuelve el agente actualizado', async () => {
    supabase.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: { id: 'ca1', company_id: 'co1' }, error: null }))
      .mockReturnValueOnce(buildChain({ data: { id: 'ca1', agent_template_id: 'tpl-1', custom_instructions: 'x', temperature: 0.5, is_active: true }, error: null }));

    const res = await request(app)
      .patch('/api/agents/ca1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ temperature: 0.5 });

    expect(res.status).toBe(200);
    expect(res.body.agent.temperature).toBe(0.5);
  });

  test('DELETE /api/agents/:id exitoso desactiva el agente', async () => {
    supabase.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: { id: 'ca1', company_id: 'co1' }, error: null }))
      .mockReturnValueOnce(buildChain({ error: null }));

    const res = await request(app)
      .delete('/api/agents/ca1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Agente desactivado.');
  });
});