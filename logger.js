// backend/logger.js

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',

    // En desarrollo: pretty print con colores
    // En producción: JSON puro — Render lo indexa correctamente
    transport: isDev
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,

    // Campos base que aparecen en todos los logs
    base: {
        service: 'agentex-backend',
        env:     process.env.NODE_ENV || 'development',
    },

    // Serializar errores correctamente
    serializers: {
        err: pino.stdSerializers.err,
    },
});

module.exports = logger;