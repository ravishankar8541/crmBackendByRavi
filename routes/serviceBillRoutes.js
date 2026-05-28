// routes/serviceBillRoutes.js
const express = require('express');
const router = express.Router();
const {
    getClientServiceBilling,
    addServicePayment
} = require('../controllers/serviceBillController');

// Auth middleware
const authMiddleware = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            req.user = { username: 'System', _id: 'system' };
            return next();
        }
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_secret_key');
        req.user = decoded;
        next();
    } catch (error) {
        req.user = { username: 'System', _id: 'system' };
        next();
    }
};

router.use(authMiddleware);

router.get('/client/:clientId', getClientServiceBilling);
router.post('/:serviceBillId/payment', addServicePayment);

module.exports = router;