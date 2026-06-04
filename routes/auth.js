const express = require('express');
const { 
  register, 
  login, 
  getAllUsers, 
  adminResetPassword, 
  changeOwnPassword 
} = require('../controllers/authController');

// ✅ Auth middleware to verify token
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided',
      });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
};

const router = express.Router();

// Public routes
router.post('/register', register);
router.post('/login', login);

// Protected routes (require authentication)
router.get('/users', authMiddleware, getAllUsers);
router.post('/admin/reset-password', authMiddleware, adminResetPassword);
router.post('/change-password', authMiddleware, changeOwnPassword);

module.exports = router;