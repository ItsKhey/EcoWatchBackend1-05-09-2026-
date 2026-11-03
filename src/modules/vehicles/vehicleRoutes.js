const express = require('express');
const router = express.Router();
const {
  listVehicles,
  getVehicleCounts,
  getVehicle,
  getVehicleTaskCounts,
  getVehicleTaskHistory,
  addVehicle,
  editVehicle,
  recordVehicleService,
  removeVehicle,
} = require('./vehicleController');
const { protect } = require('../../middleware/authMiddleware');
const { admin } = require('../../middleware/adminMiddleware');

// The fleet is an operational picture of the same kind as the personnel roster
// beside it on the Admin screen, so every route is administrator-only. protect
// resolves the account and admin refuses anything that is not an administrator,
// which is why neither is repeated per route.
router.use(protect, admin);

// Registered before '/:vehicleId' so the literal segment always wins. Without
// this ordering, GET /status-counts would be read as a vehicle id and fail the
// VEH-0001 check with a confusing 400.
router.get('/status-counts', getVehicleCounts);

router.get('/', listVehicles);
router.post('/', addVehicle);

router.get('/:vehicleId/task-counts', getVehicleTaskCounts);
router.get('/:vehicleId/task-history', getVehicleTaskHistory);
router.get('/:vehicleId', getVehicle);
router.patch('/:vehicleId', editVehicle);
router.patch('/:vehicleId/service', recordVehicleService);
router.delete('/:vehicleId', removeVehicle);

module.exports = router;
