// backend/test/regression/auth.role-check-invertido.regression.test.js
//
// PRUEBA DE REGRESIÓN
//
// Bug real (corregido en controllers/auth.controller.js, función registerB2B):
//
//   El código original tenía la validación de rol INVERTIDA:
//
//       // Solo ADMIN puede aprovisionar empresas
//       if (req.user.role !== 'ADMIN') {
//           return res.status(403).json({ error: 'No tienes autorización...' });
//       }
//
//   Esto causaba dos problemas simultáneos:
//     1. Bloqueaba incorrectamente a SUPER_ADMIN (el único rol que debía
//        poder aprovisionar empresas nuevas) — el caso reportado en producción.
//     2. Dejaba pasar incorrectamente a cualquier usuario con rol ADMIN
//        normal, que NUNCA debería poder crear empresas nuevas.
//
//   El fix invirtió la condición a la correcta:
//
//       // Solo SUPER_ADMIN puede aprovisionar empresas
//       if (req.user.role !== 'SUPER_ADMIN') { ... }
//
// Esta prueba fija ambos comportamientos esperados para que, si la condición
// se invierte de nuevo por error en el futuro, el test falle inmediatamente.

'use strict';

const mockFrom = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: mockFrom })),
}));
jest.mock('bcrypt');

const bcrypt = require('bcrypt');
const { registerB2B } = require('../../controllers/auth.controller');

function buildChain(result) {
  const chain = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq:     jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('REGRESIÓN — registerB2B: validación de rol para aprovisionar empresas', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bcrypt.hash.mockResolvedValue('hashed');
  });

  test('SUPER_ADMIN puede aprovisionar una empresa nueva (caso que el bug bloqueaba)', async () => {
    const chainCompanies = buildChain({ data: { id: 'co-nueva' }, error: null });
    const chainUsers     = buildChain({ error: null });
    const chainAgents    = buildChain({ error: null });
    mockFrom
      .mockReturnValueOnce(chainCompanies)
      .mockReturnValueOnce(chainUsers)
      .mockReturnValueOnce(chainAgents);

    const req = {
      user: { role: 'SUPER_ADMIN' }, // <- rol que el bug rechazaba incorrectamente
      body: {
        company_name: 'Empresa Nueva', email: 'admin@nueva.com', password: 'pass123',
        agents_to_provision: [{ template_id: 'tpl-1', custom_instructions: 'inst' }],
      },
    };
    const res = mockRes();

    await registerB2B(req, res);

    // Con el fix: SUPER_ADMIN nunca debe recibir 403
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('ADMIN normal NO puede aprovisionar empresas (caso que el bug dejaba pasar incorrectamente)', async () => {
    const req = {
      user: { role: 'ADMIN' }, // <- rol que el bug aceptaba incorrectamente
      body: {
        company_name: 'Empresa Intrusa', email: 'hacker@intruso.com', password: 'pass123',
        agents_to_provision: [{ template_id: 'tpl-1', custom_instructions: 'inst' }],
      },
    };
    const res = mockRes();

    await registerB2B(req, res);

    // Con el fix: un ADMIN normal debe ser rechazado con 403
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockFrom).not.toHaveBeenCalled(); // nunca debe llegar a tocar la BD
  });

  test('un usuario sin rol definido (undefined) tampoco puede aprovisionar empresas', async () => {
    const req = {
      user: {}, // sin role
      body: { company_name: 'X', email: 'x@x.com', password: 'pass123', agents_to_provision: [{ template_id: 'tpl-1' }] },
    };
    const res = mockRes();

    await registerB2B(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});