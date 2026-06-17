// backend/server.js
const app    = require('./app');
const logger = require('./logger');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, `Servidor activo en http://localhost:${PORT}`);
});