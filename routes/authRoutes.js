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

const {
  sendVerification,
  checkVerification,
  syncFirebasePassword,
} = require('../controllers/firebaseAuthController');

const storage = multer.memoryStorage();
const upload = multer({ storage });

/*
 * ---------------------------------------------------------------------------
 * Firebase email verification + password reset
 * ---------------------------------------------------------------------------
 * register, forgot-password and reset-password are mounted to the original
 * handlers, which dispatch internally to the Firebase transport when the request
 * carries an oobCode / verificationMethod, and to the legacy OTP transport
 * otherwise. The Admin app sends neither, so it keeps working untouched.
 *
 * The three routes below are new and exist only in the email-link flow.
 */

// Sends a verification link. Mounted on both names so a client that wants the
// very first send and one that is retrying have an explicit verb each; the
// cooldown is enforced identically.
router.post('/send-verification', sendVerification);
router.post('/resend-verification', sendVerification);

// Reports whether the address behind a registration was verified, and creates the
// resident row on the transition. Safe to call repeatedly.
router.get('/check-verification', checkVerification);

// Re-aligns an account's Firebase identity with its Supabase password. JWT
// protected, and still requires the caller's current password: a token on its own
// must never be enough to take over an account's email identity.
router.post('/sync-firebase-password', protect, syncFirebasePassword);

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
