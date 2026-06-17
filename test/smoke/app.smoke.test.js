// backend/test/smoke/app.smoke.test.js
//
// Smoke tests: verificación rápida y superficial de que la app está "viva".
// No prueban lógica de negocio (eso es integración/unitarias) — solo que
// la app levanta, las rutas existen, y nada explota con un 500 inesperado.

'use strict';

jest.mock('../../config/supabase');

describe('Smoke tests — la app levanta y responde', () => {
  let request;
  let app;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV   = 'development';
    request = require('supertest');
    app     = require('../../app');
  });

  test('la app se importa sin lanzar excepciones', () => {
    expect(app).toBeDefined();
  });

  test('GET /health responde 200 con status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('GET /api/docs (Swagger) responde sin error de servidor', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBeLessThan(500);
  });

  // ── Rutas protegidas: sin token deben dar 401, nunca 500 ──────────────────
  const rutasProtegidasGET = [
    '/api/sessions',
    '/api/sessions/stats',
    '/api/agents/my-agents',
    '/api/agents/templates',
    '/api/agents',
    '/api/users',
    '/api/users/me',
    '/api/company',
    '/api/admin/companies',
  ];

  test.each(rutasProtegidasGET)('GET %s sin token devuelve 401 (no 500)', async (ruta) => {
    const res = await request(app).get(ruta);
    expect(res.status).toBe(401);
  });

  test('POST /api/chat/message sin token devuelve 401 (no 500)', async () => {
    const res = await request(app).post('/api/chat/message').send({});
    expect(res.status).toBe(401);
  });

  test('POST /api/auth/login con body vacío no crashea el servidor (devuelve 401, no 500)', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBeLessThan(500);
  });

  test('ruta inexistente devuelve 404, no 500', async () => {
    const res = await request(app).get('/api/esto-no-existe');
    expect(res.status).toBe(404);
  });
});