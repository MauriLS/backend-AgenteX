// backend/routes/admin.routes.js
const router      = require('express').Router();
const verifyToken = require('../middlewares/auth');
const { getCompanies, updateCompany, deleteCompany } = require('../controllers/admin.controller');

router.get('/',        verifyToken, getCompanies);
router.put('/:id',     verifyToken, updateCompany);
router.delete('/:id',  verifyToken, deleteCompany);

module.exports = router;