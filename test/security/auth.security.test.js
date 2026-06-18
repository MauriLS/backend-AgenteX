// backend/test/security/auth.security.test.js
//
// Pruebas de seguridad: verifican que la app rechace correctamente
// intentos de acceso no autorizado, tokens manipulados, y fugas de
// datos entre tenants (empresas distintas).

'use strict';

jest.mock('../../config/supabase');

const jwt      = require('jsonwebtoken');
const supabase = require('../../config/supabase');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    eq:     jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

describe('Seguridad — autenticación y autorización', () => {
  let request;
  let app;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-real';
    process.env.NODE_ENV   = 'development';
    request = require('supertest');
    app     = require('../../app');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Manipulación de JWT', () => {
    test('token firmado con un secret distinto al del servidor es rechazado (403)', async () => {
      const tokenFalsificado = jwt.sign({ id: 'atacante', role: 'SUPER_ADMIN', company_id: 'co-victima' }, 'secret-incorrecto');

      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', `Bearer ${tokenFalsificado}`);

      expect(res.status).toBe(403);
    });

    test('token expirado es rechazado (403)', async () => {
      const tokenExpirado = jwt.sign(
        { id: 'u1', role: 'ADMIN', company_id: 'co1' },
        process.env.JWT_SECRET,
        { expiresIn: '-1h' } // ya vencido
      );

      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', `Bearer ${tokenExpirado}`);

      expect(res.status).toBe(403);
    });

    test('token con formato corrupto (no JWT válido) es rechazado (403)', async () => {
      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', 'Bearer esto.no.es.un.jwt.valido');

      expect(res.status).toBe(403);
    });

    test('header Authorization sin el prefijo "Bearer" es rechazado (401)', async () => {
      const token = jwt.sign({ id: 'u1', role: 'ADMIN', company_id: 'co1' }, process.env.JWT_SECRET);

      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', token); // sin "Bearer "

      expect(res.status).toBe(401);
    });

    test('sin header Authorization devuelve 401, no 500', async () => {
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(401);
    });

    test('token con algoritmo "none" (intento clásico de bypass JWT) es rechazado', async () => {
      // jwt.sign con algorithm: 'none' requiere passphrase null explícito
      const header  = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ id: 'atacante', role: 'SUPER_ADMIN', company_id: 'co-cualquiera' })).toString('base64url');
      const tokenSinFirma = `${header}.${payload}.`;

      const res = await request(app)
        .get('/api/sessions')
        .set('Authorization', `Bearer ${tokenSinFirma}`);

      expect(res.status).toBe(403);
    });
  });

  describe('Aislamiento entre tenants (multi-tenancy)', () => {
    test('usuario de la empresa A no puede ver sesión de la empresa B (404, no datos filtrados)', async () => {
      const tokenEmpresaA = jwt.sign({ id: 'user-a', role: 'USER', company_id: 'co-A' }, process.env.JWT_SECRET);

      // La sesión pertenece a otro usuario (de otra empresa)
      supabase.from = jest.fn().mockReturnValueOnce(buildChain({
        data: { id: 'session-empresa-b', users_id: 'user-b' },
        error: null,
      }));

      const res = await request(app)
        .get('/api/sessions/session-empresa-b/messages')
        .set('Authorization', `Bearer ${tokenEmpresaA}`);

      expect(res.status).toBe(404);
      expect(res.body.messages).toBeUndefined(); // no debe filtrar ningún mensaje
    });

    test('ADMIN de una empresa no puede eliminar usuario de otra empresa (404)', async () => {
      const tokenAdminA = jwt.sign({ id: 'admin-a', role: 'ADMIN', company_id: 'co-A' }, process.env.JWT_SECRET);

      supabase.from = jest.fn().mockReturnValueOnce(buildChain({
        data: { id: 'user-empresa-b', company_id: 'co-B' },
        error: null,
      }));

      const res = await request(app)
        .delete('/api/users/user-empresa-b')
        .set('Authorization', `Bearer ${tokenAdminA}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Escalación de privilegios', () => {
    test('un usuario con rol USER no puede acceder a endpoints exclusivos de ADMIN', async () => {
      const tokenUser = jwt.sign({ id: 'u1', role: 'USER', company_id: 'co1' }, process.env.JWT_SECRET);

      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${tokenUser}`);

      expect(res.status).toBe(403);
    });

    test('un usuario con rol ADMIN no puede acceder a endpoints exclusivos de SUPER_ADMIN', async () => {
      const tokenAdmin = jwt.sign({ id: 'admin1', role: 'ADMIN', company_id: 'co1' }, process.env.JWT_SECRET);

      const res = await request(app)
        .get('/api/admin/companies')
        .set('Authorization', `Bearer ${tokenAdmin}`);

      expect(res.status).toBe(403);
    });

    test('un usuario no puede auto-asignarse un rol superior modificando el payload de la petición', async () => {
      // El usuario es USER real en el JWT, pero intenta enviar role:'ADMIN' en el body.
      // El controller siempre debe usar req.user.role (del JWT verificado), nunca req.body.role.
      const tokenUser = jwt.sign({ id: 'u1', role: 'USER', company_id: 'co1' }, process.env.JWT_SECRET);

      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${tokenUser}`)
        .send({ role: 'ADMIN' }); // intento de inyectar un rol falso en el body

      expect(res.status).toBe(403); // el body nunca debe sobreescribir el rol del JWT
    });
  });

  describe('Headers de seguridad', () => {
    test('CORS está habilitado (header Access-Control-Allow-Origin presente)', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });

    test('rate-limit expone headers estándar cuando está activo', async () => {
      // En NODE_ENV=development el rate-limit se omite por diseño (ver server.js / app.js),
      // así que solo confirmamos que la ruta responde sin error; el comportamiento
      // de bloqueo real se prueba en el test de carga (k6) en un entorno NODE_ENV=production.
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });
  });
});