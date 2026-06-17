// backend/test/integration/auth.login.integration.test.js
//
// Test de integración: ejercita la app real (app.js) con supertest,
// pasando por middlewares (cors, json, rate-limit, logging) y rutas reales.
// Solo se mockea la dependencia externa: @supabase/supabase-js.
// auth.controller.js crea su propio cliente con createClient() directo,
// por eso el mock va sobre ese paquete, no sobre config/supabase.js.

'use strict';

const mockFrom = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: mockFrom })),
}));
jest.mock('bcrypt');

const bcrypt = require('bcrypt');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    eq:     jest.fn(() => chain),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

describe('POST /api/auth/login — integración', () => {
  let request;
  let app;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV   = 'development'; // desactiva rate-limit real para no interferir
    request = require('supertest');
    app     = require('../../app');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('credenciales válidas devuelven 200 con token JWT', async () => {
    bcrypt.compare = jest.fn().mockResolvedValue(true);

    mockFrom.mockReturnValue(buildChain({
      data: [{ id: 'u1', email: 'admin@acme.com', password_hash: 'hashed', username: 'admin', role: 'ADMIN', company_id: 'co1' }],
      error: null,
    }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password: 'clave123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toEqual({ username: 'admin', role: 'ADMIN' });
  });

  test('email no encontrado devuelve 401 sin filtrar detalles', async () => {
    mockFrom.mockReturnValue(buildChain({ data: [], error: null }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'noexiste@acme.com', password: 'cualquiera' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Credenciales inválidas.');
  });

  test('password incorrecta devuelve 401', async () => {
    bcrypt.compare = jest.fn().mockResolvedValue(false);
    mockFrom.mockReturnValue(buildChain({
      data: [{ id: 'u1', email: 'admin@acme.com', password_hash: 'hashed', username: 'admin', role: 'ADMIN', company_id: 'co1' }],
      error: null,
    }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@acme.com', password: 'incorrecta' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Credenciales inválidas.');
  });

  test('POST /api/auth/register sin token devuelve 401 (ruta protegida)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ company_name: 'Nueva Empresa' });

    expect(res.status).toBe(401);
  });
});