const logger = (req, res, next) => {
  const requestId = Math.random().toString(36).substring(2, 10).toUpperCase();
  req.requestId = requestId;

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    // req.path omits query parameters such as reporter search terms and IDs.
    console.log(`[REQUEST] ${req.method} ${req.path} [ID: ${requestId}] [STATUS: ${res.statusCode}] [TIME: ${duration}ms]`);

    if (req.path.startsWith('/api/auth/profile')) {
      console.log(`[PROFILE_DEBUG] requestId=${requestId} responseStatus=${res.statusCode}`);
    }
  });

  next();
};

const logProfileRequest = (req, message) => {
  if (req.path.startsWith('/api/auth/profile')) {
    logInfo(req.requestId, 'PROFILE_DEBUG', message);
  }
};

const logInfo = (requestId, stage, message) => {
  console.log(`[INFO] [ID: ${requestId}] [${stage}] ${message}`);
};

const logError = (requestId, stage, error) => {
  console.error(`[ERROR] [ID: ${requestId}] [${stage}] ${error}`);
};

module.exports = { logger, logInfo, logError, logProfileRequest };
