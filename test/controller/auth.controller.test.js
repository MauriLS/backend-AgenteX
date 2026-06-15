// backend/test/controllers/auth.controller.test.js
'use strict';

const mockFrom = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: mockFrom })),
}));
jest.mock('bcrypt');
jest.mock('jsonwebtoken');

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { registerB2B, login } = require('../../controllers/auth.controller');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('auth.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('registerB2B', () => {
    const baseBody = {
      company_name: 'ACME',
      email: 'admin@acme.com',
      password: 'pass123',
      agents_to_provision: [{ template_id: 'tpl-1', custom_instructions: 'inst' }],
    };

    test('retorna 403 si el rol no es SUPER_ADMIN', async () => {
      const req = { user: { role: 'ADMIN' }, body: baseBody };
      const res = mockRes();

      await registerB2B(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'No tienes autorización para aprovisionar nuevas empresas.' });
    });

    test('retorna 400 si faltan datos obligatorios', async () => {
      const req = { user: { role: 'SUPER_ADMIN' }, body: { company_name: 'ACME' } };
      const res = mockRes();

      await registerB2B(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Faltan datos obligatorios para el despliegue.' });
    });

    test('retorna 500 si falla la creación de la empresa', async () => {
      bcrypt.hash.mockResolvedValue('hashed');
      const chainCompanies = buildChain({ data: null, error: { message: 'insert failed' } });
      mockFrom.mockReturnValueOnce(chainCompanies);

      const req = { user: { role: 'SUPER_ADMIN' }, body: baseBody };
      const res = mockRes();

      await registerB2B(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Error al crear empresa: insert failed' });
    });

    test('retorna 500 y hace rollback si falla la creación del usuario', async () => {
      bcrypt.hash.mockResolvedValue('hashed');
      const chainCompanies = buildChain({ data: { id: 'co-new' }, error: null });
      const chainUsers     = buildChain({ error: { message: 'user insert failed' } });
      const chainRollback  = buildChain({ error: null });
      mockFrom
        .mockReturnValueOnce(chainCompanies)
        .mockReturnValueOnce(chainUsers)
        .mockReturnValueOnce(chainRollback);

      const req = { user: { role: 'SUPER_ADMIN' }, body: baseBody };
      const res = mockRes();

      await registerB2B(req, res);

      expect(chainRollback.delete).toHaveBeenCalled();
      expect(chainRollback.eq).toHaveBeenCalledWith('id', 'co-new');
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Error al crear usuario: user insert failed' });
    });

    test('retorna 201 con aviso si falla el aprovisionamiento de agentes', async () => {
      bcrypt.hash.mockResolvedValue('hashed');
      const chainCompanies = buildChain({ data: { id: 'co-new' }, error: null });
      const chainUsers     = buildChain({ error: null });
      const chainAgents    = buildChain({ error: { message: 'agents insert failed' } });
      mockFrom
        .mockReturnValueOnce(chainCompanies)
        .mockReturnValueOnce(chainUsers)
        .mockReturnValueOnce(chainAgents);

      const req = { user: { role: 'SUPER_ADMIN' }, body: baseBody };
      const res = mockRes();

      await registerB2B(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Empresa creada, pero hubo un error al aprovisionar los agentes.',
        company_id: 'co-new',
      });
    });

    test('retorna 201 con flujo completo exitoso, mapeando erp_url a erp_mapping.productos_url', async () => {
      bcrypt.hash.mockResolvedValue('hashed');
      const chainCompanies = buildChain({ data: { id: 'co-new' }, error: null });
      const chainUsers     = buildChain({ error: null });
      const chainAgents    = buildChain({ error: null });
      mockFrom
        .mockReturnValueOnce(chainCompanies)
        .mockReturnValueOnce(chainUsers)
        .mockReturnValueOnce(chainAgents);

      const req = {
        user: { role: 'SUPER_ADMIN' },
        body: { ...baseBody, erp_url: 'https://erp.test/productos', erp_mapping: { id: 'sku' }, business_context: 'contexto' },
      };
      const res = mockRes();

      await registerB2B(req, res);

      expect(chainCompanies.insert).toHaveBeenCalledWith([{
        name: 'ACME',
        erp_mapping: { id: 'sku', productos_url: 'https://erp.test/productos' },
        business_context: 'contexto',
      }]);
      expect(bcrypt.hash).toHaveBeenCalledWith('pass123', 10);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Infraestructura desplegada correctamente para "ACME".',
        company_id: 'co-new',
      });
    });

    test('usa username derivado del email cuando no se provee', async () => {
      bcrypt.hash.mockResolvedValue('hashed');
      const chainCompanies = buildChain({ data: { id: 'co-new' }, error: null });
      const chainUsers     = buildChain({ error: null });
      const chainAgents    = buildChain({ error: null });
      mockFrom
        .mockReturnValueOnce(chainCompanies)
        .mockReturnValueOnce(chainUsers)
        .mockReturnValueOnce(chainAgents);

      const req = { user: { role: 'SUPER_ADMIN' }, body: baseBody };
      const res = mockRes();

      await registerB2B(req, res);

      expect(chainUsers.insert).toHaveBeenCalledWith([{
        company_id: 'co-new',
        username: 'admin',
        email: 'admin@acme.com',
        password_hash: 'hashed',
        role: 'ADMIN',
      }]);
    });
  });

  describe('login', () => {
    test('retorna 401 si el email no existe', async () => {
      const chainUsers = buildChain({ data: [], error: null });
      mockFrom.mockReturnValueOnce(chainUsers);

      const req = { body: { email: 'noexiste@test.com', password: 'x' } };
      const res = mockRes();

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Credenciales inválidas.' });
    });

    test('retorna 401 si supabase devuelve error', async () => {
      const chainUsers = buildChain({ data: null, error: { message: 'db error' } });
      mockFrom.mockReturnValueOnce(chainUsers);

      const req = { body: { email: 'admin@acme.com', password: 'x' } };
      const res = mockRes();

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Credenciales inválidas.' });
    });

    test('retorna 401 si el password no coincide', async () => {
      const user = { id: 'u1', username: 'mauri', role: 'ADMIN', company_id: 'co1', password_hash: 'hashed' };
      const chainUsers = buildChain({ data: [user], error: null });
      mockFrom.mockReturnValueOnce(chainUsers);
      bcrypt.compare.mockResolvedValue(false);

      const req = { body: { email: 'admin@acme.com', password: 'wrong' } };
      const res = mockRes();

      await login(req, res);

      expect(bcrypt.compare).toHaveBeenCalledWith('wrong', 'hashed');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Credenciales inválidas.' });
    });

    test('retorna 200 con token cuando las credenciales son válidas', async () => {
      const user = { id: 'u1', username: 'mauri', role: 'ADMIN', company_id: 'co1', password_hash: 'hashed' };
      const chainUsers = buildChain({ data: [user], error: null });
      mockFrom.mockReturnValueOnce(chainUsers);
      bcrypt.compare.mockResolvedValue(true);
      jwt.sign.mockReturnValue('signed-token');

      const req = { body: { email: 'admin@acme.com', password: 'correct' } };
      const res = mockRes();

      await login(req, res);

      expect(jwt.sign).toHaveBeenCalledWith(
        { id: 'u1', role: 'ADMIN', company_id: 'co1' },
        process.env.JWT_SECRET,
        { expiresIn: '8h' },
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Login exitoso',
        token: 'signed-token',
        user: { username: 'mauri', role: 'ADMIN' },
      });
    });

    test('retorna 500 si ocurre una excepción inesperada', async () => {
      mockFrom.mockImplementation(() => { throw new Error('boom'); });

      const req = { body: { email: 'admin@acme.com', password: 'x' } };
      const res = mockRes();

      await login(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'boom' });
    });
  });
});