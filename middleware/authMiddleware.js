const jwt = require('jsonwebtoken');

const {
  findByResidentId,
} = require('../repositories/residentRepository');

const {
  findByAdminId,
} = require('../repositories/adminRepository');

const {
  findByPersonnelId,
} = require('../repositories/personnelRepository');

const { logError, logProfileRequest } = require('../utils/logger');

const protect = async (req, res, next) => {
  let token;

  logProfileRequest(
    req,
    `method=${req.method} route=${req.originalUrl}`
  );

  logProfileRequest(
    req,
    `authorizationPresent=${Boolean(req.headers.authorization)} bearerTokenPresent=${Boolean(
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer ')
    )}`
  );

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET
      );

      if (!decoded.id) {
        res.status(401);
        throw new Error('Token does not contain user identifier');
      }

      // Resident lookup
      let user = await findByResidentId(decoded.id);

      // Admin lookup
      if (!user) {
        user = await findByAdminId(decoded.id);
      }

      if (!user) {
        res.status(401);
        throw new Error('Not authorized, user not found');
      }

      /*
       * Keep req.resident for compatibility with the
       * existing controllers/routes.
       */
      req.resident = {
        ...user,
        residentId: user.resident_id || user.admin_id || user.residentId,
        resident_id: user.resident_id || user.admin_id || user.residentId,
        admin_id: user.admin_id || user.resident_id || user.adminId
      };

      logProfileRequest(
        req,
        `authenticationResult=success authenticatedUserId=${decoded.id}`
      );

      return next();
    } catch (error) {
      logError(
        req.requestId,
        'AUTH',
        `Token verification failed: ${error.message}`
      );

      logProfileRequest(
        req,
        `authenticationResult=failure error=${
          error.name || 'AuthenticationError'
        }`
      );

      res.status(401);

      return next(
        new Error('Not authorized, token failed')
      );
    }
  }

  if (!token) {
    res.status(401);

    return next(
      new Error('Not authorized, no token')
    );
  }
};

const protectPersonnel = async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith('Bearer ')) {
    const error = new Error('Not authorized, no personnel token');
    error.statusCode = 401;
    return next(error);
  }

  const token = authorization.slice('Bearer '.length).trim();

  if (!token) {
    const error = new Error('Not authorized, no personnel token');
    error.statusCode = 401;
    return next(error);
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    const authenticationError = new Error('Not authorized, personnel token failed');
    authenticationError.statusCode = 401;
    logError(
      req.requestId,
      'PERSONNEL_AUTH',
      `Personnel token verification failed: ${error.message}`
    );
    return next(authenticationError);
  }

  if (!decoded.id || !/^PERS-[0-9]{4}$/i.test(decoded.id)) {
    const error = new Error('Not authorized as personnel');
    error.statusCode = 401;
    return next(error);
  }

  let personnel;

  try {
    personnel = await findByPersonnelId(decoded.id.toUpperCase());
  } catch (error) {
    logError(
      req.requestId,
      'PERSONNEL_AUTH',
      `Personnel account lookup failed: ${error.message}`
    );
    return next(error);
  }

  if (!personnel) {
    const error = new Error('Not authorized, personnel account not found');
    error.statusCode = 401;
    return next(error);
  }

  if (!personnel.enabled || personnel.deleted_at) {
    const error = new Error('Personnel account is disabled or deleted');
    error.statusCode = 401;
    return next(error);
  }

  if (String(personnel.role || '').toUpperCase() !== 'PERSONNEL') {
    const error = new Error('Not authorized as personnel');
    error.statusCode = 403;
    return next(error);
  }

  req.personnel = personnel;
  req.auth = {
    accountType: 'PERSONNEL',
    role: 'PERSONNEL',
  };

  return next();
};

module.exports = { protect, protectPersonnel };
