// backend/__tests__/company.controller.test.js
'use strict';

jest.mock('../../config/supabase');
const supabase = require('../../config/supabase');
const { getCompany, updateCompany } = require('../../controllers/company.controller');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    update: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
  };
  return chain;
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('company.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCompany', () => {
    test('retorna la empresa del usuario autenticado', async () => {
      const empresa = { id: 'co1', name: 'ACME', erp_mapping: {}, business_context: '', subscription_status: 'active', created_at: '2026-01-01' };
      const chain = buildChain({ data: empresa, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { company_id: 'co1' } };
      const res = mockRes();

      await getCompany(req, res);

      expect(supabase.from).toHaveBeenCalledWith('companies');
      expect(chain.eq).toHaveBeenCalledWith('id', 'co1');
      expect(res.json).toHaveBeenCalledWith({ success: true, company: empresa });
    });

    test('retorna 404 si la empresa no existe', async () => {
      const chain = buildChain({ data: null, error: { message: 'not found' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { company_id: 'co-x' } };
      const res = mockRes();

      await getCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Empresa no encontrada.' });
    });
  });

  describe('updateCompany', () => {
    test('retorna 403 si el rol no es ADMIN ni SUPER_ADMIN', async () => {
      const req = { user: { role: 'USER', company_id: 'co1' }, body: { name: 'Nuevo nombre' } };
      const res = mockRes();

      await updateCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos.' });
    });

    test('retorna 400 si no hay campos para actualizar', async () => {
      const req = { user: { role: 'ADMIN', company_id: 'co1' }, body: {} };
      const res = mockRes();

      await updateCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No hay campos para actualizar.' });
    });

    test('actualiza la empresa cuando el rol es ADMIN', async () => {
      const actualizado = { id: 'co1', name: 'Nuevo nombre', erp_mapping: {}, business_context: '' };
      const chain = buildChain({ data: actualizado, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, body: { name: 'Nuevo nombre' } };
      const res = mockRes();

      await updateCompany(req, res);

      expect(chain.update).toHaveBeenCalledWith({ name: 'Nuevo nombre' });
      expect(chain.eq).toHaveBeenCalledWith('id', 'co1');
      expect(res.json).toHaveBeenCalledWith({ success: true, company: actualizado });
    });

    test('permite actualizar cuando el rol es SUPER_ADMIN', async () => {
      const actualizado = { id: 'co1', name: 'ACME', erp_mapping: { id: 'sku' }, business_context: 'ctx' };
      const chain = buildChain({ data: actualizado, error: null });
      supabase.from = jest.fn(() => chain);

      const req = {
        user: { role: 'SUPER_ADMIN', company_id: 'co1' },
        body: { erp_mapping: { id: 'sku' }, business_context: 'ctx' },
      };
      const res = mockRes();

      await updateCompany(req, res);

      expect(chain.update).toHaveBeenCalledWith({ erp_mapping: { id: 'sku' }, business_context: 'ctx' });
      expect(res.json).toHaveBeenCalledWith({ success: true, company: actualizado });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, body: { name: 'X' } };
      const res = mockRes();

      await updateCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });
});