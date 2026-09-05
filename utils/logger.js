const logger = (req, res, next) => {
  const requestId = Math.random().toString(36).substring(2, 10).toUpperCase();
  req.requestId = requestId;

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[REQUEST] ${req.method} ${req.originalUrl} [ID: ${requestId}] [STATUS: ${res.statusCode}] [TIME: ${duration}ms]`);
  });

  next();
};

const logInfo = (requestId, stage, message) => {
  console.log(`[INFO] [ID: ${requestId}] [${stage}] ${message}`);
};

const logError = (requestId, stage, error) => {
  console.error(`[ERROR] [ID: ${requestId}] [${stage}] ${error}`);
};

module.exports = { logger, logInfo, logError };
