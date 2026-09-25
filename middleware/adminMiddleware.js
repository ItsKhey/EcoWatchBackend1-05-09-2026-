const admin = (req, res, next) => {
  const role = String(req.resident?.role || '').toUpperCase();

  if (role !== 'ADMIN') {
    const error = new Error('Not authorized as an admin');
    error.statusCode = 403;
    return next(error);
  }

  return next();
};

module.exports = { admin };
