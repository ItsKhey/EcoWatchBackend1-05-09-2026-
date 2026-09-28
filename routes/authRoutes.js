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
 * There is deliberately no send-verification or resend-verification route. The
 * app asks Firebase to send the verification email itself through the client
 * SDK, because Firebase refuses to send one without a signed-in session and this
 * server never signs in. The server's only remaining job is to confirm the
 * resulting session, which check-verification does.
 */

// Confirms a verified Firebase session and creates the account. POST rather than
// GET because the body carries an ID token, which must never travel in a URL.
router.post('/check-verification', checkVerification);

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
