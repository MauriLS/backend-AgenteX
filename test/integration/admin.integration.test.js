// backend/test/integration/admin.integration.test.js
'use strict';

jest.mock('../../config/supabase');

const jwt      = require('jsonwebtoken');
const supabase = require('../../config/supabase');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
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

describe('rutas /api/admin/companies — integración', () => {
  let request, app, superAdminToken, adminToken;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV   = 'development';
    request         = require('supertest');
    app             = require('../../app');
    superAdminToken = makeToken({ id: 'sa1', role: 'SUPER_ADMIN', company_id: null });
    adminToken      = makeToken({ id: 'admin1', role: 'ADMIN', company_id: 'co1' });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /api/admin/companies con rol ADMIN (no SUPER_ADMIN) devuelve 403', async () => {
    const res = await request(app)
      .get('/api/admin/companies')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
  });

  test('GET /api/admin/companies con SUPER_ADMIN devuelve la lista de empresas', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: [{ id: 'co1', name: 'ACME', subscription_status: 'active', erp_mapping: null, created_at: '2026-01-01' }],
      error: null,
    }));

    const res = await request(app)
      .get('/api/admin/companies')
      .set('Authorization', `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
  });

  test('PATCH /api/admin/companies/:id con rol ADMIN devuelve 403', async () => {
    const res = await request(app)
      .patch('/api/admin/companies/co1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Nuevo Nombre' });

    expect(res.status).toBe(403);
  });

  test('PATCH /api/admin/companies/:id con SUPER_ADMIN actualiza la empresa', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: { id: 'co1', name: 'ACME Renovada', subscription_status: 'active' },
      error: null,
    }));

    const res = await request(app)
      .patch('/api/admin/companies/co1')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'ACME Renovada' });

    expect(res.status).toBe(200);
    expect(res.body.company.name).toBe('ACME Renovada');
  });

  test('DELETE /api/admin/companies/:id con rol ADMIN devuelve 403', async () => {
    const res = await request(app)
      .delete('/api/admin/companies/co1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
  });

  test('DELETE /api/admin/companies/:id con SUPER_ADMIN elimina la empresa', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({ error: null }));

    const res = await request(app)
      .delete('/api/admin/companies/co1')
      .set('Authorization', `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Empresa eliminada.');
  });
});