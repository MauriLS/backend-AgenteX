// backend/routes/sessions.routes.js
const router      = require('express').Router();
const verifyToken = require('../middlewares/auth');
const { getSessions, getSessionMessages, deleteSession, getStats } = require('../controllers/sessions.controller');

router.get('/stats',              verifyToken, getStats);
router.get('/',                   verifyToken, getSessions);
router.get('/:id/messages',       verifyToken, getSessionMessages);
router.delete('/:id',             verifyToken, deleteSession);

module.exports = router;