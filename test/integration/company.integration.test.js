// backend/test/integration/company.integration.test.js
'use strict';

jest.mock('../../config/supabase');

const jwt      = require('jsonwebtoken');
const supabase = require('../../config/supabase');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    update: jest.fn(() => chain),
    eq:     jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function makeToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('rutas /api/company — integración', () => {
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

  test('GET /api/company devuelve los datos de la empresa del usuario', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: { id: 'co1', name: 'ACME', erp_mapping: null, business_context: '', subscription_status: 'active', created_at: '2026-01-01' },
      error: null,
    }));

    const res = await request(app)
      .get('/api/company')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.company.name).toBe('ACME');
  });

  test('GET /api/company con empresa inexistente devuelve 404', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: null, error: { message: 'no encontrada' } }));

    const res = await request(app)
      .get('/api/company')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
  });

  test('PATCH /api/company sin rol ADMIN devuelve 403', async () => {
    const res = await request(app)
      .patch('/api/company')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Nuevo Nombre' });

    expect(res.status).toBe(403);
  });

  test('PATCH /api/company sin campos devuelve 400', async () => {
    const res = await request(app)
      .patch('/api/company')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('PATCH /api/company exitoso devuelve la empresa actualizada', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: { id: 'co1', name: 'ACME Renovada', erp_mapping: null, business_context: '' },
      error: null,
    }));

    const res = await request(app)
      .patch('/api/company')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ACME Renovada' });

    expect(res.status).toBe(200);
    expect(res.body.company.name).toBe('ACME Renovada');
  });
});