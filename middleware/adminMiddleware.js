const admin = (req, res, next) => {
  const role = String(req.admin?.role || '').toUpperCase();

  if (role !== 'ADMIN' || !req.admin?.admin_id) {
    const error = new Error('Not authorized as an admin');
    error.statusCode = 403;
    return next(error);
  }

  return next();
};

module.exports = { admin };
