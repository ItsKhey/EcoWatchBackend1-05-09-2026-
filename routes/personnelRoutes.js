const express = require('express');
const router = express.Router();
const {
  loginPersonnel,
  createPersonnel,
  listPersonnel,
  getPersonnelDetails,
  editPersonnel,
  resetPersonnelPassword,
  updatePersonnelStatus,
  disablePersonnel,
  enablePersonnel,
  deletePersonnel,
  restorePersonnel,
} = require('../controllers/personnelController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');

router.post('/login', loginPersonnel);

// Personnel accounts are admin-managed only. There is intentionally no
// registration route in this module.
router.use(protect, admin);

router.post('/', createPersonnel);
router.get('/', listPersonnel);
router.get('/:id', getPersonnelDetails);
router.patch('/:id', editPersonnel);
router.patch('/:id/password', resetPersonnelPassword);
router.post('/:id/reset-password', resetPersonnelPassword);
router.patch('/:id/status', updatePersonnelStatus);
router.patch('/:id/disable', disablePersonnel);
router.patch('/:id/enable', enablePersonnel);
router.delete('/:id', deletePersonnel);
router.patch('/:id/restore', restorePersonnel);

module.exports = router;
