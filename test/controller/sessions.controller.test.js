// backend/test/controllers/sessions.controller.test.js
'use strict';

jest.mock('../../config/supabase');
const supabase = require('../../config/supabase');
const { getSessions, getSessionMessages, deleteSession, getStats } = require('../../controllers/sessions.controller');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
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

describe('sessions.controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSessions', () => {
    test('retorna las sesiones del usuario', async () => {
      const sessions = [{ id: 's1', created_at: '2026-06-01', alerted: false, seen: true, company_agents: {} }];
      const chain = buildChain({ data: sessions, error: null });
      supabase.from = jest.fn(() => chain);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getSessions(req, res);

      expect(chain.eq).toHaveBeenCalledWith('users_id', 'u1');
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.limit).toHaveBeenCalledWith(50);
      expect(res.json).toHaveBeenCalledWith({ success: true, sessions });
    });

    test('retorna 500 si supabase devuelve error', async () => {
      const chain = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chain);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getSessions(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('getSessionMessages', () => {
    test('retorna 404 si la sesión no existe', async () => {
      const chainSession = buildChain({ data: null, error: null });
      supabase.from = jest.fn(() => chainSession);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await getSessionMessages(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sesión no encontrada.' });
    });

    test('retorna 404 si la sesión pertenece a otro usuario', async () => {
      const chainSession = buildChain({ data: { id: 's1', users_id: 'otro' }, error: null });
      supabase.from = jest.fn(() => chainSession);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await getSessionMessages(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sesión no encontrada.' });
    });

    test('retorna los mensajes de la sesión', async () => {
      const chainSession  = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
      const messages = [{ id: 'm1', content: 'hola', sender_type: 'USER', prompt_tokens: 1, completion_tokens: 2, created_at: '2026-06-01' }];
      const chainMessages = buildChain({ data: messages, error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainSession)
        .mockReturnValueOnce(chainMessages);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await getSessionMessages(req, res);

      expect(chainMessages.eq).toHaveBeenCalledWith('session_chat_id', 's1');
      expect(chainMessages.order).toHaveBeenCalledWith('created_at', { ascending: true });
      expect(res.json).toHaveBeenCalledWith({ success: true, messages });
    });

    test('retorna 500 si falla la consulta de mensajes', async () => {
      const chainSession  = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
      const chainMessages = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainSession)
        .mockReturnValueOnce(chainMessages);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await getSessionMessages(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('deleteSession', () => {
    test('retorna 404 si la sesión no existe', async () => {
      const chainSession = buildChain({ data: null, error: null });
      supabase.from = jest.fn(() => chainSession);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await deleteSession(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sesión no encontrada.' });
    });

    test('retorna 404 si la sesión pertenece a otro usuario', async () => {
      const chainSession = buildChain({ data: { id: 's1', users_id: 'otro' }, error: null });
      supabase.from = jest.fn(() => chainSession);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await deleteSession(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Sesión no encontrada.' });
    });

    test('elimina la sesión cuando el usuario es el dueño', async () => {
      const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
      const chainDelete  = buildChain({ error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainSession)
        .mockReturnValueOnce(chainDelete);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await deleteSession(req, res);

      expect(chainDelete.delete).toHaveBeenCalled();
      expect(chainDelete.eq).toHaveBeenCalledWith('id', 's1');
      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Sesión eliminada.' });
    });

    test('retorna 500 si falla el delete', async () => {
      const chainSession = buildChain({ data: { id: 's1', users_id: 'u1' }, error: null });
      const chainDelete  = buildChain({ error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainSession)
        .mockReturnValueOnce(chainDelete);

      const req = { user: { id: 'u1' }, params: { id: 's1' } };
      const res = mockRes();

      await deleteSession(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });
  });

  describe('getStats', () => {
    test('retorna 500 si falla la consulta de sesiones', async () => {
      const chainSessions = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn(() => chainSessions);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getStats(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });

    test('retorna stats vacío si el usuario no tiene sesiones', async () => {
      const chainSessions = buildChain({ data: [], error: null });
      supabase.from = jest.fn(() => chainSessions);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getStats(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, stats: [] });
    });

    test('retorna 500 si falla la consulta de mensajes', async () => {
      const sessions = [{ id: 's1', company_agents: { agent_template_id: 'agent-A', agent_templates: { name: 'Agente A' } } }];
      const chainSessions = buildChain({ data: sessions, error: null });
      const chainMessages = buildChain({ data: null, error: { message: 'db error' } });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainSessions)
        .mockReturnValueOnce(chainMessages);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getStats(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'db error' });
    });

    test('agrega métricas por agente, incluyendo sesión sin company_agents', async () => {
      const sessions = [
        { id: 's1', company_agents: { agent_template_id: 'agent-A', agent_templates: { name: 'Agente A' } } },
        { id: 's2', company_agents: { agent_template_id: 'agent-A', agent_templates: { name: 'Agente A' } } },
        { id: 's3', company_agents: { agent_template_id: 'agent-B', agent_templates: { name: 'Agente B' } } },
      ];
      const messages = [
        { session_chat_id: 's1', sender_type: 'USER',      prompt_tokens: 10, completion_tokens: 20 },
        { session_chat_id: 's1', sender_type: 'ASSISTANT', prompt_tokens: 5,  completion_tokens: 15 },
        { session_chat_id: 's2', sender_type: 'USER',      prompt_tokens: 7,  completion_tokens: 14 },
        { session_chat_id: 's3', sender_type: 'USER',      prompt_tokens: 3,  completion_tokens: 6 },
        { session_chat_id: 's-desconocida', sender_type: 'USER', prompt_tokens: 99, completion_tokens: 99 },
      ];
      const chainSessions = buildChain({ data: sessions, error: null });
      const chainMessages = buildChain({ data: messages, error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainSessions)
        .mockReturnValueOnce(chainMessages);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getStats(req, res);

      const { stats } = res.json.mock.calls[0][0];
      const agentA = stats.find(a => a.agent_id === 'agent-A');
      const agentB = stats.find(a => a.agent_id === 'agent-B');

      expect(agentA).toEqual({
        agent_id: 'agent-A', agent_name: 'Agente A',
        total_sesiones: 2, total_preguntas: 2,
        prompt_tokens: 22, completion_tokens: 49, total_tokens: 71,
      });
      expect(agentB).toEqual({
        agent_id: 'agent-B', agent_name: 'Agente B',
        total_sesiones: 1, total_preguntas: 1,
        prompt_tokens: 3, completion_tokens: 6, total_tokens: 9,
      });
    });

    test('usa valores por defecto cuando company_agents es null', async () => {
      const sessions = [{ id: 's1', company_agents: null }];
      const messages = [{ session_chat_id: 's1', sender_type: 'USER', prompt_tokens: 1, completion_tokens: 1 }];
      const chainSessions = buildChain({ data: sessions, error: null });
      const chainMessages = buildChain({ data: messages, error: null });
      supabase.from = jest.fn()
        .mockReturnValueOnce(chainSessions)
        .mockReturnValueOnce(chainMessages);

      const req = { user: { id: 'u1' } };
      const res = mockRes();

      await getStats(req, res);

      const { stats } = res.json.mock.calls[0][0];
      expect(stats[0]).toMatchObject({ agent_id: 'desconocido', agent_name: 'Agente' });
    });
  });
});