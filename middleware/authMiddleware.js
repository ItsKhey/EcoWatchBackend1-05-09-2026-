const jwt = require('jsonwebtoken');
const Resident = require('../models/Resident');
const Admin = require('../models/Admin');
const { logError, logProfileRequest } = require('../utils/logger');

const protect = async (req, res, next) => {
  let token;

  logProfileRequest(req, `method=${req.method} route=${req.originalUrl}`);
  logProfileRequest(req, `authorizationPresent=${Boolean(req.headers.authorization)} bearerTokenPresent=${Boolean(req.headers.authorization && req.headers.authorization.startsWith('Bearer '))}`);

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Check Resident first
      let user = await Resident.findById(decoded.id).select('-password');

      // If not found, check Admin
      if (!user) {
        user = await Admin.findById(decoded.id).select('-password');
      }

      if (!user) {
        res.status(401);
        throw new Error('Not authorized, user not found');
      }

      req.resident = user; // Keeping property name as req.resident to minimize changes
      logProfileRequest(req, `authenticationResult=success authenticatedUserId=${user._id}`);
      return next();
    } catch (error) {
      logError(req.requestId, 'AUTH', `Token verification failed: ${error.message}`);
      logProfileRequest(req, `authenticationResult=failure error=${error.name || 'AuthenticationError'}`);
      res.status(401);
      return next(new Error('Not authorized, token failed'));
    }
  }

  if (!token) {
    res.status(401);
    return next(new Error('Not authorized, no token'));
  }
};

module.exports = { protect };
