const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const morgan = require('morgan');
const { logger } = require('./utils/logger');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { startHistoryCleanupJob } = require('./services/historyCleanupService');
const { startReportCleanupJob } = require('./services/reportCleanupService');

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not configured.');
  process.exit(1);
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use(logger);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'UP',
    database: 'CONNECTED',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/history', require('./routes/historyRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));

app.use(notFound);
app.use(errorHandler);

startHistoryCleanupJob();
startReportCleanupJob();
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`[SERVER] Running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});
