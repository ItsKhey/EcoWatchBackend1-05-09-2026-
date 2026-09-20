const admin = (req, res, next) => {
  if (req.resident && req.resident.role === 'ADMIN') {
    next();
  } else {
    res.status(403);
    throw new Error('Not authorized as an admin');
  }
};

module.exports = { admin };
