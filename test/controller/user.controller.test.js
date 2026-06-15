// backend/test/controllers/users.controller.test.js
'use strict';

jest.mock('../../config/supabase');
jest.mock('bcrypt');

const bcrypt = require('bcrypt');
const supabase = require('../../config/supabase');
const { getMe, updateMe, getUsers, deleteUser } = require('../../controllers/users.controller');

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

describe('users.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMe', () => {
    test('retorna el usuario autenticado', async () => {
      const user = { id: 'u1', username: 'mauri', email: 'm@test.com', role: 'ADMIN', status: 'active', created_at: '2026-01-01', company_id: 'co1' };
      const chain = buildChain({ data: user, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getMe(req, res);

      expect(supabase.from).toHaveBeenCalledWith('users');
      expect(chain.eq).toHaveBeenCalledWith('id', 'u1');
      expect(res.json).toHaveBeenCalledWith({ success: true, user });
    });

    test('retorna 404 si el usuario no existe', async () => {
      const chain = buildChain({ data: null, error: { message: 'not found' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { id: 'u-x' } };
      const res = mockRes();

      await getMe(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Usuario no encontrado.' });
    });
  });

  describe('updateMe', () => {
    test('retorna 400 si no hay campos para actualizar', async () => {
      const req = { user: { id: 'u1' }, body: {} };
      const res = mockRes();

      await updateMe(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No hay campos para actualizar.' });
    });

    test('actualiza username y email sin tocar password', async () => {
      const actualizado = { id: 'u1', username: 'nuevo', email: 'nuevo@test.com', role: 'USER', status: 'active' };
      const chain = buildChain({ data: actualizado, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { id: 'u1' }, body: { username: 'nuevo', email: 'nuevo@test.com' } };
      const res = mockRes();

      await updateMe(req, res);

      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(chain.update).toHaveBeenCalledWith({ username: 'nuevo', email: 'nuevo@test.com' });
      expect(res.json).toHaveBeenCalledWith({ success: true, user: actualizado });
    });

    test('hashea el password antes de actualizar', async () => {
      bcrypt.hash.mockResolvedValue('hashed_pw');
      const actualizado = { id: 'u1', username: 'mauri', email: 'm@test.com', role: 'USER', status: 'active' };
      const chain = buildChain({ data: actualizado, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { id: 'u1' }, body: { password: 'nuevoPass123' } };
      const res = mockRes();

      await updateMe(req, res);

      expect(bcrypt.hash).toHaveBeenCalledWith('nuevoPass123', 10);
      expect(chain.update).toHaveBeenCalledWith({ password_hash: 'hashed_pw' });
      expect(res.json).toHaveBeenCalledWith({ success: true, user: actualizado });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { id: 'u1' }, body: { username: 'x' } };
      const res = mockRes();

      await updateMe(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('getUsers', () => {
    test('retorna 403 si el rol no es ADMIN ni SUPER_ADMIN', async () => {
      const req = { user: { role: 'USER', company_id: 'co1' } };
      const res = mockRes();

      await getUsers(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos.' });
    });

    test('retorna usuarios de la empresa para ADMIN', async () => {
      const users = [{ id: 'u1', username: 'a' }, { id: 'u2', username: 'b' }];
      const chain = buildChain({ data: users, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'ADMIN', company_id: 'co1' } };
      const res = mockRes();

      await getUsers(req, res);

      expect(chain.eq).toHaveBeenCalledWith('company_id', 'co1');
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(res.json).toHaveBeenCalledWith({ success: true, users });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'SUPER_ADMIN', company_id: 'co1' } };
      const res = mockRes();

      await getUsers(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('deleteUser', () => {
    test('retorna 403 si el rol no es ADMIN ni SUPER_ADMIN', async () => {
      const req = { user: { role: 'USER', id: 'u1', company_id: 'co1' }, params: { id: 'u2' } };
      const res = mockRes();

      await deleteUser(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos.' });
    });

    test('retorna 400 si intenta eliminarse a sí mismo', async () => {
      const req = { user: { role: 'ADMIN', id: 'u1', company_id: 'co1' }, params: { id: 'u1' } };
      const res = mockRes();

      await deleteUser(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No puedes eliminar tu propio usuario.' });
    });

    test('retorna 404 si el usuario objetivo no existe', async () => {
      const chainTarget = buildChain({ data: null, error: null });
      supabase.from = jest.fn(() => chainTarget);

      const req = { user: { role: 'ADMIN', id: 'u1', company_id: 'co1' }, params: { id: 'u2' } };
      const res = mockRes();

      await deleteUser(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Usuario no encontrado.' });
    });

    test('retorna 404 si el usuario objetivo es de otra empresa', async () => {
      const chainTarget = buildChain({ data: { id: 'u2', company_id: 'co2' }, error: null });
      supabase.from = jest.fn(() => chainTarget);

      const req = { user: { role: 'ADMIN', id: 'u1', company_id: 'co1' }, params: { id: 'u2' } };
      const res = mockRes();

      await deleteUser(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Usuario no encontrado.' });
    });

    test('elimina el usuario cuando pertenece a la misma empresa', async () => {
      const chainTarget = buildChain({ data: { id: 'u2', company_id: 'co1' }, error: null });
      const chainDelete = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainTarget)
        .mockReturnValueOnce(chainDelete);

      const req = { user: { role: 'ADMIN', id: 'u1', company_id: 'co1' }, params: { id: 'u2' } };
      const res = mockRes();

      await deleteUser(req, res);

      expect(chainDelete.delete).toHaveBeenCalled();
      expect(chainDelete.eq).toHaveBeenCalledWith('id', 'u2');
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Usuario eliminado.' });
    });

    test('retorna 500 si falla el delete', async () => {
      const chainTarget = buildChain({ data: { id: 'u2', company_id: 'co1' }, error: null });
      const chainDelete = buildChain({ error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainTarget)
        .mockReturnValueOnce(chainDelete);

      const req = { user: { role: 'SUPER_ADMIN', id: 'u1', company_id: 'co1' }, params: { id: 'u2' } };
      const res = mockRes();

      await deleteUser(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });
});