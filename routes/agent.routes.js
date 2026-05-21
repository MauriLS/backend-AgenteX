// backend/routes/agent.routes.js
const router      = require('express').Router();
const verifyToken = require('../middlewares/auth');
const {
    getMyAgents,
    getTemplates,
    getAgents,
    updateAgent,
    deleteAgent,
} = require('../controllers/agent.controller');

router.get('/my-agents',   verifyToken, getMyAgents);
router.get('/templates',   verifyToken, getTemplates);
router.get('/',            verifyToken, getAgents);
router.put('/:id',         verifyToken, updateAgent);
router.delete('/:id',      verifyToken, deleteAgent);

module.exports = router;