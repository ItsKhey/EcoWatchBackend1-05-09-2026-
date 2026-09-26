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
  changePassword,
  resetLoggedInPassword,
  disableOwnAccount,
  deleteOwnAccount,
} = require('../controllers/authController');
const { protect, protectResident } = require('../middleware/authMiddleware');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/register', registerResident);
router.post('/verify-otp', verifyOTP);
router.post('/forgot-password', forgotPassword);
router.post('/verify-reset-otp', verifyResetOTP);
router.post('/reset-password', resetPassword);
router.post('/login', loginResident);
router.post('/change-password', protect, changePassword);
router.patch('/reset-logged-in', protect, resetLoggedInPassword);
router.get('/me', protect, getResidentProfile);
router.patch('/profile', protect, updateProfile);
router.patch('/profile/image', protect, upload.single('image'), updateProfileImage);

// Resident account lifecycle. Both routes are resident-only so an
// administrator token can never pause or delete an account through them.
router.post('/disable-account', protect, protectResident, disableOwnAccount);
router.delete('/account', protect, protectResident, deleteOwnAccount);

module.exports = router;
