// backend/test/integration/users.integration.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('bcrypt');

const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcrypt');
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

describe('rutas /api/users — integración', () => {
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

  test('GET /api/users/me devuelve el perfil del usuario autenticado', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: { id: 'user1', username: 'mauri', email: 'mauri@acme.com', role: 'USER', status: 'active', created_at: '2026-01-01', company_id: 'co1' },
      error: null,
    }));

    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('mauri');
  });

  test('GET /api/users/me con usuario inexistente devuelve 404', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: null, error: { message: 'no encontrado' } }));

    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
  });

  test('PATCH /api/users/me sin campos devuelve 400', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('PATCH /api/users/me con password hashea antes de guardar', async () => {
    bcrypt.hash = jest.fn().mockResolvedValue('hash-seguro');
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: { id: 'user1', username: 'mauri', email: 'mauri@acme.com', role: 'USER', status: 'active' },
      error: null,
    }));

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password: 'nuevaClave123' });

    expect(res.status).toBe(200);
    expect(bcrypt.hash).toHaveBeenCalledWith('nuevaClave123', 10);
  });

  test('GET /api/users sin rol ADMIN devuelve 403', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  test('GET /api/users con rol ADMIN devuelve usuarios de la empresa', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({
      data: [{ id: 'user1', username: 'mauri', email: 'mauri@acme.com', role: 'USER', status: 'active', created_at: '2026-01-01' }],
      error: null,
    }));

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
  });

  test('DELETE /api/users/:id intentando eliminarse a sí mismo devuelve 400', async () => {
    const res = await request(app)
      .delete('/api/users/admin1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });

  test('DELETE /api/users/:id de otra empresa devuelve 404', async () => {
    supabase.from = jest.fn().mockReturnValueOnce(buildChain({ data: { id: 'user2', company_id: 'co-otra' }, error: null }));

    const res = await request(app)
      .delete('/api/users/user2')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  test('DELETE /api/users/:id exitoso elimina el usuario', async () => {
    supabase.from = jest.fn()
      .mockReturnValueOnce(buildChain({ data: { id: 'user2', company_id: 'co1' }, error: null }))
      .mockReturnValueOnce(buildChain({ error: null }));

    const res = await request(app)
      .delete('/api/users/user2')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Usuario eliminado.');
  });
});