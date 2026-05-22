// backend/swagger.js
const swaggerUi   = require('swagger-ui-express');
const YAML        = require('yamljs');
const path        = require('path');

const swaggerDoc  = YAML.load(path.join(__dirname, 'swagger.yaml'));

module.exports = { swaggerUi, swaggerDoc };