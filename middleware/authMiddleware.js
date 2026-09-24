const jwt = require('jsonwebtoken');

const {
  findByResidentId,
} = require('../repositories/residentRepository');

const {
  findByAdminId,
} = require('../repositories/adminRepository');

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

module.exports = { protect };
