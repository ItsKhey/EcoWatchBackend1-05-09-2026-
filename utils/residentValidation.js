const { createHttpError } = require('./personnelValidation');

const RESIDENT_ID_PATTERN = /^RES-[A-Z0-9]{4,32}$/;
const RESIDENT_STATUS_FILTERS = new Set(['ALL', 'ACTIVE', 'DISABLED']);
const MAX_PAGE_SIZE = 100;

const validateResidentId = (value, fieldName = 'Resident ID') => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `${fieldName} must be a string.`);
  }

  const residentId = value.trim().toUpperCase();
  if (!RESIDENT_ID_PATTERN.test(residentId)) {
    throw createHttpError(400, `${fieldName} must use the RES-XXXXXXXX format.`);
  }

  return residentId;
};

const parseReportPageQuery = (query = {}) => {
  const rawLimit = query.limit === undefined || query.limit === null || query.limit === ''
    ? 50
    : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw createHttpError(400, 'limit must be an integer between 1 and 100.');
  }

  const rawPage = query.page === undefined || query.page === null || query.page === ''
    ? 1
    : Number(query.page);
  if (!Number.isInteger(rawPage) || rawPage < 1 || rawPage > 1000000) {
    throw createHttpError(400, 'page must be a positive integer.');
  }

  const offset = query.offset === undefined || query.offset === null || query.offset === ''
    ? (rawPage - 1) * rawLimit
    : Number(query.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000000) {
    throw createHttpError(400, 'offset must be a non-negative integer.');
  }

  return { page: rawPage, limit: rawLimit, offset };
};

const parseResidentListQuery = (query = {}) => {
  const rawStatus = query.status === undefined || query.status === null || query.status === ''
    ? 'ALL'
    : String(query.status).trim().toUpperCase();

  if (!RESIDENT_STATUS_FILTERS.has(rawStatus)) {
    throw createHttpError(400, 'status must be ALL, ACTIVE, or DISABLED.');
  }

  const search = query.search === undefined || query.search === null
    ? ''
    : String(query.search).trim();
  if (search.length > 100) {
    throw createHttpError(400, 'search must be at most 100 characters.');
  }
  if (/[\u0000-\u001f\u007f]/.test(search)) {
    throw createHttpError(400, 'search contains invalid characters.');
  }

  const rawLimit = query.limit === undefined || query.limit === null || query.limit === ''
    ? 50
    : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_SIZE) {
    throw createHttpError(400, `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }

  const rawPage = query.page === undefined || query.page === null || query.page === ''
    ? 1
    : Number(query.page);
  if (!Number.isInteger(rawPage) || rawPage < 1 || rawPage > 1000000) {
    throw createHttpError(400, 'page must be a positive integer.');
  }

  const offset = query.offset === undefined || query.offset === null || query.offset === ''
    ? (rawPage - 1) * rawLimit
    : Number(query.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000000) {
    throw createHttpError(400, 'offset must be a non-negative integer.');
  }

  return {
    search,
    status: rawStatus,
    page: rawPage,
    limit: rawLimit,
    offset,
  };
};

module.exports = {
  RESIDENT_ID_PATTERN,
  MAX_PAGE_SIZE,
  validateResidentId,
  parseReportPageQuery,
  parseResidentListQuery,
};
