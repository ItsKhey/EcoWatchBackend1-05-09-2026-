const assert = require('assert');
const {
  validateReportAssignmentPayload,
} = require('../utils/reportAssignmentValidation');

const parsed = validateReportAssignmentPayload({
  personnelId: 'pers-0007',
  adminResponse: 'Please clean this area.',
  priority: 'High',
});

assert.deepStrictEqual(parsed.assignedPersonnelIds, ['PERS-0007']);
assert.strictEqual(parsed.canonicalPersonnelId, 'PERS-0007');
assert.strictEqual(parsed.adminResponse, 'Please clean this area.');

const multiline = validateReportAssignmentPayload({
  personnelId: 'PERS-0007',
  adminResponse: 'Please clean this area.\nUse the west gate.',
});
assert.strictEqual(multiline.adminResponse, 'Please clean this area.\nUse the west gate.');

assert.throws(
  () => validateReportAssignmentPayload({
    personnelId: 'PERS-0007',
    assignedByAdminId: 'ADM-FORGED',
  }),
  /server-owned/
);

assert.throws(
  () => validateReportAssignmentPayload({
    assignedPersonnelIds: [],
  }),
  /At least one personnel ID is required/
);

console.log('Report assignment contract checks passed.');
