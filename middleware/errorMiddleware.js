const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

const errorHandler = (err, req, res, next) => {
  let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  let message = err.message;

  // Mask raw PostgreSQL connection/auth errors into user-friendly message
  if (err.message && (err.message.includes('password authentication failed') || err.message.includes('ECONNREFUSED'))) {
    message = 'Database connection error. Please check server database credentials.';
  }

  if (err.name === 'MulterError' || err.code === 'INVALID_FILE_TYPE') {
    statusCode = 400;
    message = err.code === 'LIMIT_FILE_SIZE'
      ? 'The uploaded image is too large'
      : message;
  }

  // Handle invalid request identifiers
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    statusCode = 404;
    message = 'Resource not found';
  }

  res.status(statusCode).json({
    success: false,
    message,
    requestId: req.requestId,
  });
};

module.exports = { notFound, errorHandler };
