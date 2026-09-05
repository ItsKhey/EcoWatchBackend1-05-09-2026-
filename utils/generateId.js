const { customAlphabet } = require('nanoid');

const generateResidentId = () => {
  const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 8);
  return `RES-${nanoid()}`;
};

const generateReportId = () => {
  const nanoid = customAlphabet('0123456789', 10);
  return `REP-${nanoid()}`;
};

const generateRegistrationId = () => {
  const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
  return `REG-${nanoid()}`;
};

const generateOTP = () => {
  const nanoid = customAlphabet('0123456789', 4);
  return nanoid();
};

module.exports = { generateResidentId, generateReportId, generateRegistrationId, generateOTP };
