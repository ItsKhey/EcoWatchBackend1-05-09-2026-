const jwt = require('jsonwebtoken');

const generateToken = (userId, claims = {}) => {
  return jwt.sign(
    { id: userId, ...claims },
    process.env.JWT_SECRET,
    {
      expiresIn: '30d',
    }
  );
};

module.exports = generateToken;
