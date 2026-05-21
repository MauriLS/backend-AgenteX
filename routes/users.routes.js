// backend/routes/users.routes.js
const router      = require('express').Router();
const verifyToken = require('../middlewares/auth');
const { getMe, updateMe, getUsers, deleteUser } = require('../controllers/users.controller');

router.get('/',       verifyToken, getUsers);
router.get('/me',     verifyToken, getMe);
router.put('/me',     verifyToken, updateMe);
router.delete('/:id', verifyToken, deleteUser);

module.exports = router;