// backend/test/controllers/auth.controller.gaps.test.js
'use strict';

const mockFrom = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: mockFrom })),
}));
jest.mock('bcrypt');
jest.mock('jsonwebtoken');

const bcrypt = require('bcrypt');
const { registerB2B } = require('../../controllers/auth.controller');

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
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('auth.controller.registerB2B — rama ternaria mappingConUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sin erp_url pero con erp_mapping: usa erp_mapping tal cual (sin productos_url agregado)', async () => {
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
      body: {
        company_name: 'ACME', email: 'admin@acme.com', password: 'pass123',
        agents_to_provision: [{ template_id: 'tpl-1', custom_instructions: 'inst' }],
        erp_mapping: { id: 'sku', nombre: 'articulo' }, // sin erp_url
      },
    };
    const res = mockRes();

    await registerB2B(req, res);

    expect(chainCompanies.insert).toHaveBeenCalledWith([{
      name: 'ACME',
      erp_mapping: { id: 'sku', nombre: 'articulo' }, // tal cual, sin productos_url
      business_context: null,
    }]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('sin erp_url ni erp_mapping: erp_mapping queda null', async () => {
    bcrypt.hash.mockResolvedValue('hashed');
    const chainCompanies = buildChain({ data: { id: 'co-new-2' }, error: null });
    const chainUsers     = buildChain({ error: null });
    const chainAgents    = buildChain({ error: null });
    mockFrom
      .mockReturnValueOnce(chainCompanies)
      .mockReturnValueOnce(chainUsers)
      .mockReturnValueOnce(chainAgents);

    const req = {
      user: { role: 'SUPER_ADMIN' },
      body: {
        company_name: 'ACME 2', email: 'admin2@acme.com', password: 'pass123',
        agents_to_provision: [{ template_id: 'tpl-1', custom_instructions: 'inst' }],
        // sin erp_url, sin erp_mapping
      },
    };
    const res = mockRes();

    await registerB2B(req, res);

    expect(chainCompanies.insert).toHaveBeenCalledWith([{
      name: 'ACME 2',
      erp_mapping: null,
      business_context: null,
    }]);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});