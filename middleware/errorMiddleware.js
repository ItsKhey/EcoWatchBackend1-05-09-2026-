const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = Number.isInteger(err.statusCode)
    ? err.statusCode
    : res.statusCode === 200
      ? 500
      : res.statusCode;
  let message = err.message || 'Request failed.';

  // Translate database constraint failures without exposing SQL details.
  if (err.code === '23505') {
    statusCode = 409;
    message = 'A record with the same unique value already exists.';
  } else if (err.code === '23503') {
    statusCode = 409;
    message = 'A related record does not exist or is still in use.';
  } else if (err.code === '23514') {
    statusCode = 400;
    message = 'The request violates a database validation rule.';
  } else if (err.code === '22P02') {
    statusCode = 400;
    message = 'A request identifier has an invalid format.';
  }

  if (
    message &&
    (message.includes('password authentication failed') ||
      message.includes('ECONNREFUSED'))
  ) {
    statusCode = 503;
    message = 'Database connection error. Please check server database credentials.';
  }

  if (err.name === 'MulterError' || err.code === 'INVALID_FILE_TYPE') {
    statusCode = 400;
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'The uploaded image is too large'
        : message;
  }

  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    statusCode = 404;
    message = 'Resource not found';
  }

  if (statusCode >= 500) {
    console.error(
      `[ERROR] [ID: ${req.requestId}] ${req.method} ${req.path}:`,
      err
    );
  }

  res.status(statusCode).json({
    success: false,
    message,
    requestId: req.requestId,
  });
};

module.exports = { notFound, errorHandler };
