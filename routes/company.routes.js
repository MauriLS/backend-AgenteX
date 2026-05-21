// backend/routes/company.routes.js
const router      = require('express').Router();
const verifyToken = require('../middlewares/auth');
const { getCompany, updateCompany } = require('../controllers/company.controller');

router.get('/',  verifyToken, getCompany);
router.put('/',  verifyToken, updateCompany);

module.exports = router;