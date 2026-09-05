const express = require('express');
const router = express.Router();
const {
  registerResident,
  verifyOTP,
  loginResident,
  getResidentProfile,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', registerResident);
router.post('/verify-otp', verifyOTP);
router.post('/login', loginResident);
router.get('/me', protect, getResidentProfile);

module.exports = router;
