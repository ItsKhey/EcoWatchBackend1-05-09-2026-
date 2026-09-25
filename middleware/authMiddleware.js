const jwt = require('jsonwebtoken');

const {
  findByResidentId,
} = require('../repositories/residentRepository');

const {
  findByAdminId,
  touchLastActive,
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

      const isAdminToken = String(decoded.role || '').toUpperCase() === 'ADMIN';

      // An admin token must resolve against admins first. This prevents a
      // compatibility resident lookup from supplying the audit identity.
      let user = isAdminToken
        ? await findByAdminId(decoded.id)
        : await findByResidentId(decoded.id);

      // Preserve support for older non-admin tokens that may resolve through
      // the admin table, while admin routes still require req.admin below.
      if (!user && !isAdminToken) {
        user = await findByAdminId(decoded.id);
      }

      if (!user || (isAdminToken && String(user.role || '').toUpperCase() !== 'ADMIN')) {
        res.status(401);
        throw new Error('Not authorized, user not found');
      }

      // Older admin tokens did not carry a role claim. If the identifier
      // resolves to the admins table, promote that authenticated record to
      // req.admin so the canonical admin routes remain usable during rollout.
      const resolvedAdmin = isAdminToken
        || (user && user.admin_id && String(user.role || '').toUpperCase() === 'ADMIN');

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

      if (resolvedAdmin) {
        req.admin = user;

        // Activity is server-owned. Failure to update telemetry must not make
        // an otherwise valid administrator request fail, especially during a
        // rolling deployment before the new column is migrated.
        try {
          await touchLastActive(user.admin_id);
        } catch (activityError) {
          logError(
            req.requestId,
            'AUTH',
            `Unable to update admin activity: ${activityError.message}`
          );
        }

        req.auth = {
          accountType: 'ADMIN',
          role: 'ADMIN',
        };
      }

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
