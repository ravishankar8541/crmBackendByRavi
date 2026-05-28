const express = require('express');
const router = express.Router();
const {
    createBill,
    getBills,
    getBillById,
    addPayment,
    updateBill,
    deleteBill,
    forceDeleteBill,
    getClientBillingSummary,
    getPaymentHistory,
    downloadBill,
    editBill
} = require('../controllers/billController');

// IMPORTANT: Add this auth middleware
const authMiddleware = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            req.user = { username: 'System', _id: 'system' };
            return next();
        }

        // If you have JWT verification
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_secret_key');
        req.user = decoded;
        next();
    } catch (error) {
        // If token invalid, set default user
        req.user = { username: 'System', _id: 'system' };
        next();
    }
};

// Apply middleware to all routes
router.use(authMiddleware);

// Routes - MAKE SURE ALL FUNCTIONS ARE IMPORTED CORRECTLY
router.post('/create', createBill);
router.get('/all', getBills);
router.get('/:id', getBillById);
router.post('/:id/payment', addPayment);
router.delete('/:id/force', forceDeleteBill);
router.put('/:id', updateBill);
router.put('/:id/edit', editBill);
router.delete('/:id', deleteBill);
router.get('/client/:clientId/summary', getClientBillingSummary);
router.get('/:id/payments', getPaymentHistory);
router.get('/:id/download', downloadBill);

// Test route to check if router is working
router.get('/health/check', (req, res) => {
    res.status(200).json({ success: true, message: 'Bill routes are working!' });
});

module.exports = router;