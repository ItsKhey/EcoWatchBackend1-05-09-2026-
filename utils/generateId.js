const crypto = require('crypto');
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

const generateOTP = (length = 4) => {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return crypto.randomInt(min, max + 1).toString().padStart(length, '0');
};

module.exports = { generateResidentId, generateReportId, generateRegistrationId, generateOTP };
