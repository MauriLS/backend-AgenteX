// backend/test/controllers/admin.controller.test.js
'use strict';

jest.mock('../../config/supabase');
const supabase = require('../../config/supabase');
const { getCompanies, updateCompany, deleteCompany } = require('../../controllers/admin.controller');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
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

describe('admin.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCompanies', () => {
    test('retorna 403 si el rol no es SUPER_ADMIN', async () => {
      const req = { user: { role: 'ADMIN' } };
      const res = mockRes();

      await getCompanies(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Requiere rol SUPER_ADMIN.' });
    });

    test('retorna la lista de empresas', async () => {
      const companies = [{ id: 'co1', name: 'ACME', subscription_status: 'active', erp_mapping: {}, created_at: '2026-01-01' }];
      const chain = buildChain({ data: companies, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'SUPER_ADMIN' } };
      const res = mockRes();

      await getCompanies(req, res);

      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(res.json).toHaveBeenCalledWith({ success: true, companies });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'SUPER_ADMIN' } };
      const res = mockRes();

      await getCompanies(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('updateCompany', () => {
    test('retorna 403 si el rol no es SUPER_ADMIN', async () => {
      const req = { user: { role: 'ADMIN' }, params: { id: 'co1' }, body: { name: 'X' } };
      const res = mockRes();

      await updateCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Requiere rol SUPER_ADMIN.' });
    });

    test('retorna 400 si no hay campos para actualizar', async () => {
      const req = { user: { role: 'SUPER_ADMIN' }, params: { id: 'co1' }, body: {} };
      const res = mockRes();

      await updateCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No hay campos para actualizar.' });
    });

    test('actualiza la empresa con los campos provistos', async () => {
      const actualizado = { id: 'co1', name: 'Nuevo nombre', subscription_status: 'active' };
      const chain = buildChain({ data: actualizado, error: null });
      supabase.from = jest.fn(() => chain);

      const req = {
        user: { role: 'SUPER_ADMIN' },
        params: { id: 'co1' },
        body: { name: 'Nuevo nombre', erp_mapping: { id: 'sku' }, business_context: 'ctx', subscription_status: 'active' },
      };
      const res = mockRes();

      await updateCompany(req, res);

      expect(chain.update).toHaveBeenCalledWith({
        name: 'Nuevo nombre', erp_mapping: { id: 'sku' }, business_context: 'ctx', subscription_status: 'active',
      });
      expect(chain.eq).toHaveBeenCalledWith('id', 'co1');
      expect(res.json).toHaveBeenCalledWith({ success: true, company: actualizado });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'SUPER_ADMIN' }, params: { id: 'co1' }, body: { name: 'X' } };
      const res = mockRes();

      await updateCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('deleteCompany', () => {
    test('retorna 403 si el rol no es SUPER_ADMIN', async () => {
      const req = { user: { role: 'ADMIN' }, params: { id: 'co1' } };
      const res = mockRes();

      await deleteCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Requiere rol SUPER_ADMIN.' });
    });

    test('elimina la empresa', async () => {
      const chain = buildChain({ error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'SUPER_ADMIN' }, params: { id: 'co1' } };
      const res = mockRes();

      await deleteCompany(req, res);

      expect(chain.delete).toHaveBeenCalled();
      expect(chain.eq).toHaveBeenCalledWith('id', 'co1');
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Empresa eliminada.' });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'SUPER_ADMIN' }, params: { id: 'co1' } };
      const res = mockRes();

      await deleteCompany(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });
});