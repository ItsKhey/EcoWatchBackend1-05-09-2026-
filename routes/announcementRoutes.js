const express = require('express');
const router = express.Router();
const {
  createAnnouncement,
  listAnnouncements,
} = require('../controllers/announcementController');
const {
  protect,
  protectResident,
} = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const { getMyAnnouncements } = require('../controllers/announcementController');

const residentOnly = [protect, protectResident];

// Publishing is administrator-only.
router.post('/', protect, admin, createAnnouncement);
router.get('/', protect, admin, listAnnouncements);

// The resident feed. Scoped to the caller so a resident can only ever read
// announcements addressed to them.
router.get('/my-announcements', ...residentOnly, getMyAnnouncements);

module.exports = router;
