// backend/__tests__/auth.middleware.test.js

'use strict';

const jwt = require('jsonwebtoken');
const verifyToken = require('../../middlewares/auth');

const ORIGINAL_SECRET = 'test_secret_para_pruebas';

// Helpers para mockear req/res/next
function mockReq(authHeader) {
    return { headers: { authorization: authHeader } };
}

function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json   = jest.fn().mockReturnValue(res);
    return res;
}

describe('verifyToken middleware', () => {
    let originalEnvSecret;

    beforeEach(() => {
        originalEnvSecret = process.env.JWT_SECRET;
        process.env.JWT_SECRET = ORIGINAL_SECRET;
    });

    afterEach(() => {
        process.env.JWT_SECRET = originalEnvSecret;
        jest.restoreAllMocks();
    });

    // =========================================================================
    // SIN TOKEN
    // =========================================================================
    test('401 si no hay header authorization', () => {
        const req = mockReq(undefined);
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'Acceso denegado. Se requiere un token B2B.' });
        expect(next).not.toHaveBeenCalled();
    });

    test('401 si el header authorization no tiene token después de "Bearer"', () => {
        const req = mockReq('Bearer');
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('401 si el header authorization es un string vacío', () => {
        const req = mockReq('');
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    // =========================================================================
    // JWT_SECRET NO CONFIGURADO
    // =========================================================================
    test('500 si JWT_SECRET no está definido — aunque el token "exista"', () => {
        delete process.env.JWT_SECRET;

        const req = mockReq('Bearer cualquier-token');
        const res = mockRes();
        const next = jest.fn();

        // Silenciar el console.error esperado
        jest.spyOn(console, 'error').mockImplementation(() => {});

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Error de configuración del servidor.' });
        expect(next).not.toHaveBeenCalled();
    });

    // =========================================================================
    // TOKEN VÁLIDO
    // =========================================================================
    test('token válido → req.user se popula y next() se llama', () => {
        const payload = { id: 1, role: 'SUPER_ADMIN', company_id: 1 };
        const token = jwt.sign(payload, ORIGINAL_SECRET, { expiresIn: '8h' });

        const req = mockReq(`Bearer ${token}`);
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toMatchObject(payload);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('req.user contiene exactamente los campos id, role y company_id del payload', () => {
        const payload = { id: 42, role: 'ADMIN', company_id: 7 };
        const token = jwt.sign(payload, ORIGINAL_SECRET, { expiresIn: '8h' });

        const req = mockReq(`Bearer ${token}`);
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(req.user.id).toBe(42);
        expect(req.user.role).toBe('ADMIN');
        expect(req.user.company_id).toBe(7);
    });

    // =========================================================================
    // TOKEN INVÁLIDO / FIRMA INCORRECTA
    // =========================================================================
    test('403 si el token fue firmado con un secret distinto', () => {
        const token = jwt.sign({ id: 1, role: 'USER' }, 'otro_secret_distinto', { expiresIn: '8h' });

        const req = mockReq(`Bearer ${token}`);
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido o expirado. Inicie sesión nuevamente.' });
        expect(next).not.toHaveBeenCalled();
    });

    test('403 si el token es un string malformado', () => {
        const req = mockReq('Bearer esto.no.es.un.jwt.valido');
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    // =========================================================================
    // TOKEN EXPIRADO
    // =========================================================================
    test('403 si el token está expirado', () => {
        // expiresIn negativo → ya expirado al momento de verificar
        const token = jwt.sign({ id: 1, role: 'USER' }, ORIGINAL_SECRET, { expiresIn: '-10s' });

        const req = mockReq(`Bearer ${token}`);
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido o expirado. Inicie sesión nuevamente.' });
        expect(next).not.toHaveBeenCalled();
    });

    // =========================================================================
    // REGRESIÓN — JWT_SECRET sin fallback hardcodeado
    // =========================================================================
    test('REGRESIÓN: un token firmado con el fallback antiguo "super_secreto_b2b" es rechazado', () => {
        // Bug histórico: jwt.verify(token, process.env.JWT_SECRET || 'super_secreto_b2b')
        // permitía generar tokens válidos con un secret público conocido.
        // Ahora JWT_SECRET siempre está definido (ver beforeEach) y nunca
        // debe coincidir con el fallback hardcodeado eliminado.
        const tokenConFallbackViejo = jwt.sign({ id: 999, role: 'SUPER_ADMIN' }, 'super_secreto_b2b', { expiresIn: '8h' });

        const req = mockReq(`Bearer ${tokenConFallbackViejo}`);
        const res = mockRes();
        const next = jest.fn();

        verifyToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });
});