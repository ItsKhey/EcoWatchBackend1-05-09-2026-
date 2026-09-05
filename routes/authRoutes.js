const express = require('express');
const router = express.Router();
const {
  registerResident,
  verifyOTP,
  forgotPassword,
  verifyResetOTP,
  resetPassword,
  loginResident,
  getResidentProfile,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', registerResident);
router.post('/verify-otp', verifyOTP);
router.post('/forgot-password', forgotPassword);
router.post('/verify-reset-otp', verifyResetOTP);
router.post('/reset-password', resetPassword);
router.post('/login', loginResident);
router.get('/me', protect, getResidentProfile);

module.exports = router;
