const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  registerResident,
  verifyOTP,
  forgotPassword,
  verifyResetOTP,
  resetPassword,
  loginResident,
  getResidentProfile,
  updateProfile,
  updateProfileImage,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/register', registerResident);
router.post('/verify-otp', verifyOTP);
router.post('/forgot-password', forgotPassword);
router.post('/verify-reset-otp', verifyResetOTP);
router.post('/reset-password', resetPassword);
router.post('/login', loginResident);
router.post('/change-password', protect, changePassword);
router.get('/me', protect, getResidentProfile);
router.patch('/profile', protect, updateProfile);
router.patch('/profile/image', protect, upload.single('image'), updateProfileImage);

module.exports = router;
