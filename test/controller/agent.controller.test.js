// backend/test/controllers/agent.controller.test.js
'use strict';

jest.mock('../../config/supabase');
const supabase = require('../../config/supabase');
const {
  getMyAgents, getTemplates, getAgents, createAgent, updateAgent, deleteAgent,
} = require('../../controllers/agent.controller');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    insert: jest.fn(() => chain),
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

describe('agent.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMyAgents', () => {
    test('retorna 403 si el usuario no tiene empresa', async () => {
      const chainUser = buildChain({ data: null, error: { message: 'no user' } });
      supabase.from = jest.fn(() => chainUser);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getMyAgents(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Usuario sin empresa.' });
    });

    test('retorna 500 si falla la consulta de agentes', async () => {
      const chainUser   = buildChain({ data: { company_id: 'co1' }, error: null });
      const chainAgents = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainUser)
        .mockReturnValueOnce(chainAgents);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getMyAgents(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Fallo al consultar agentes.' });
    });

    test('retorna los agentes activos mapeados', async () => {
      const chainUser = buildChain({ data: { company_id: 'co1' }, error: null });
      const agents = [{ id: 'ca1', agent_template_id: 'tpl-1', agent_templates: { name: 'Agente Ventas' } }];
      const chainAgents = buildChain({ data: agents, error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainUser)
        .mockReturnValueOnce(chainAgents);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getMyAgents(req, res);

      expect(chainAgents.eq).toHaveBeenNthCalledWith(1, 'company_id', 'co1');
      expect(chainAgents.eq).toHaveBeenNthCalledWith(2, 'is_active', true);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        agents: [{ instanceId: 'ca1', templateId: 'tpl-1', name: 'Agente Ventas' }],
      });
    });
  });

  describe('getTemplates', () => {
    test('retorna los templates', async () => {
      const templates = [{ id: 'tpl-1', name: 'Ventas', motor: 'sales', allowed_tools: [] }];
      const chain = buildChain({ data: templates, error: null });
      supabase.from = jest.fn(() => chain);

      const req = {};
      const res = mockRes();

      await getTemplates(req, res);

      expect(chain.order).toHaveBeenCalledWith('name');
      expect(res.json).toHaveBeenCalledWith({ success: true, templates });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = {};
      const res = mockRes();

      await getTemplates(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('getAgents', () => {
    test('retorna 403 si el rol no es ADMIN ni SUPER_ADMIN', async () => {
      const req = { user: { role: 'USER', company_id: 'co1' } };
      const res = mockRes();

      await getAgents(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos.' });
    });

    test('retorna los agentes de la empresa', async () => {
      const agents = [{ id: 'ca1', agent_template_id: 'tpl-1', custom_instructions: 'x', temperature: 0.3, is_active: true, created_at: '2026-01-01', agent_templates: { name: 'Ventas', motor: 'sales' } }];
      const chain = buildChain({ data: agents, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'ADMIN', company_id: 'co1' } };
      const res = mockRes();

      await getAgents(req, res);

      expect(chain.eq).toHaveBeenCalledWith('company_id', 'co1');
      expect(chain.order).toHaveBeenCalledWith('created_at');
      expect(res.json).toHaveBeenCalledWith({ success: true, agents });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { role: 'SUPER_ADMIN', company_id: 'co1' } };
      const res = mockRes();

      await getAgents(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('updateAgent', () => {
    test('retorna 403 si el rol no es ADMIN ni SUPER_ADMIN', async () => {
      const req = { user: { role: 'USER', company_id: 'co1' }, params: { id: 'ca1' }, body: { temperature: 0.5 } };
      const res = mockRes();

      await updateAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos.' });
    });

    test('retorna 400 si no hay campos para actualizar', async () => {
      const req = { user: { role: 'ADMIN', company_id: 'co1' }, params: { id: 'ca1' }, body: {} };
      const res = mockRes();

      await updateAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No hay campos para actualizar.' });
    });

    test('retorna 404 si el agente no existe o es de otra empresa', async () => {
      const chainExisting = buildChain({ data: { id: 'ca1', company_id: 'co2' }, error: null });
      supabase.from = jest.fn(() => chainExisting);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, params: { id: 'ca1' }, body: { temperature: 0.5 } };
      const res = mockRes();

      await updateAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Agente no encontrado.' });
    });

    test('retorna 500 si falla el update', async () => {
      const chainExisting = buildChain({ data: { id: 'ca1', company_id: 'co1' }, error: null });
      const chainUpdate   = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainExisting)
        .mockReturnValueOnce(chainUpdate);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, params: { id: 'ca1' }, body: { temperature: 0.5 } };
      const res = mockRes();

      await updateAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });

    test('actualiza el agente cuando pertenece a la empresa', async () => {
      const chainExisting = buildChain({ data: { id: 'ca1', company_id: 'co1' }, error: null });
      const actualizado = { id: 'ca1', agent_template_id: 'tpl-1', custom_instructions: 'nuevas', temperature: 0.7, is_active: true };
      const chainUpdate = buildChain({ data: actualizado, error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainExisting)
        .mockReturnValueOnce(chainUpdate);

      const req = { user: { role: 'SUPER_ADMIN', company_id: 'co1' }, params: { id: 'ca1' }, body: { custom_instructions: 'nuevas', temperature: 0.7 } };
      const res = mockRes();

      await updateAgent(req, res);

      expect(chainUpdate.update).toHaveBeenCalledWith({ custom_instructions: 'nuevas', temperature: 0.7 });
      expect(res.json).toHaveBeenCalledWith({ success: true, agent: actualizado });
    });
  });

  describe('deleteAgent', () => {
    test('retorna 403 si el rol no es ADMIN ni SUPER_ADMIN', async () => {
      const req = { user: { role: 'USER', company_id: 'co1' }, params: { id: 'ca1' } };
      const res = mockRes();

      await deleteAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos.' });
    });

    test('retorna 404 si el agente no existe o es de otra empresa', async () => {
      const chainExisting = buildChain({ data: null, error: null });
      supabase.from = jest.fn(() => chainExisting);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, params: { id: 'ca1' } };
      const res = mockRes();

      await deleteAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Agente no encontrado.' });
    });

    test('retorna 500 si falla la desactivación', async () => {
      const chainExisting = buildChain({ data: { id: 'ca1', company_id: 'co1' }, error: null });
      const chainUpdate   = buildChain({ error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainExisting)
        .mockReturnValueOnce(chainUpdate);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, params: { id: 'ca1' } };
      const res = mockRes();

      await deleteAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });

    test('desactiva el agente cuando pertenece a la empresa', async () => {
      const chainExisting = buildChain({ data: { id: 'ca1', company_id: 'co1' }, error: null });
      const chainUpdate   = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainExisting)
        .mockReturnValueOnce(chainUpdate);

      const req = { user: { role: 'SUPER_ADMIN', company_id: 'co1' }, params: { id: 'ca1' } };
      const res = mockRes();

      await deleteAgent(req, res);

      expect(chainUpdate.update).toHaveBeenCalledWith({ is_active: false });
      expect(chainUpdate.eq).toHaveBeenCalledWith('id', 'ca1');
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Agente desactivado.' });
    });
  });

  describe('createAgent', () => {
    test('retorna 403 si el rol no es ADMIN ni SUPER_ADMIN', async () => {
      const req = { user: { role: 'USER', company_id: 'co1' }, body: {} };
      const res = mockRes();

      await createAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos.' });
    });

    test('retorna 400 si faltan campos obligatorios', async () => {
      const req = { user: { role: 'ADMIN', company_id: 'co1' }, body: { agent_template_id: 'tpl-1' } };
      const res = mockRes();

      await createAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'agent_template_id y custom_instructions son obligatorios.' });
    });

    test('retorna 404 si el template no existe', async () => {
      const chainTemplate = buildChain({ data: null, error: null });
      supabase.from = jest.fn(() => chainTemplate);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, body: { agent_template_id: 'tpl-x', custom_instructions: 'inst' } };
      const res = mockRes();

      await createAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Template no encontrado.' });
    });

    test('retorna 409 si la empresa ya tiene un agente activo de ese template', async () => {
      const chainTemplate = buildChain({ data: { id: 'tpl-1', name: 'Ventas' }, error: null });
      const chainExisting = buildChain({ data: { id: 'ca1' }, error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainTemplate)
        .mockReturnValueOnce(chainExisting);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, body: { agent_template_id: 'tpl-1', custom_instructions: 'inst' } };
      const res = mockRes();

      await createAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ error: 'La empresa ya tiene un agente de tipo "tpl-1" activo.' });
    });

    test('retorna 500 si falla el insert', async () => {
      const chainTemplate = buildChain({ data: { id: 'tpl-1', name: 'Ventas' }, error: null });
      const chainExisting = buildChain({ data: null, error: null });
      const chainInsert   = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainTemplate)
        .mockReturnValueOnce(chainExisting)
        .mockReturnValueOnce(chainInsert);

      const req = { user: { role: 'ADMIN', company_id: 'co1' }, body: { agent_template_id: 'tpl-1', custom_instructions: 'inst' } };
      const res = mockRes();

      await createAgent(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });

    test('crea el agente con temperatura por defecto cuando no se especifica', async () => {
      const chainTemplate = buildChain({ data: { id: 'tpl-1', name: 'Ventas' }, error: null });
      const chainExisting = buildChain({ data: null, error: null });
      const creado = { id: 'ca-new', agent_template_id: 'tpl-1', custom_instructions: 'inst', temperature: 0.3, is_active: true };
      const chainInsert = buildChain({ data: creado, error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainTemplate)
        .mockReturnValueOnce(chainExisting)
        .mockReturnValueOnce(chainInsert);

      const req = { user: { role: 'SUPER_ADMIN', company_id: 'co1' }, body: { agent_template_id: 'tpl-1', custom_instructions: 'inst' } };
      const res = mockRes();

      await createAgent(req, res);

      expect(chainInsert.insert).toHaveBeenCalledWith([{
        company_id: 'co1', agent_template_id: 'tpl-1', custom_instructions: 'inst', temperature: 0.3, is_active: true,
      }]);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ success: true, agent: creado });
    });
  });
});