const nodemailer = require('nodemailer');
const dns = require('node:dns').promises;
const { logInfo, logError } = require('./logger');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;
const DNS_TIMEOUT = 5000;
const CONNECTION_TIMEOUT = 10000;
const GREETING_TIMEOUT = 10000;
const SOCKET_TIMEOUT = 15000;

const logSmtpStage = (requestId, stage) => {
  logInfo(requestId, 'EMAIL', `[SMTP] host=${SMTP_HOST} port=${SMTP_PORT} requireTLS=true stage=${stage}`);
};

const logSmtpError = (requestId, stage, error) => {
  logError(
    requestId,
    'EMAIL',
    `[SMTP] host=${SMTP_HOST} port=${SMTP_PORT} requireTLS=true stage=${stage} code=${error.code || 'UNKNOWN'} message=${error.message}`
  );
};

const sendEmail = async (options) => {
  const requestId = options.requestId || 'UNKNOWN';
  let dnsTimer;
  let smtpStage = 'configuration';

  try {
    if (process.env.EMAIL_SERVICE !== 'gmail') {
      const error = new Error('EMAIL_SERVICE must be set to gmail');
      error.code = 'ECONFIG';
      throw error;
    }

    smtpStage = 'dns-resolve';
    logSmtpStage(requestId, 'dns-resolve-start');
    const address = await Promise.race([
      dns.lookup(SMTP_HOST, { family: 4 }),
      new Promise((_, reject) => {
        dnsTimer = setTimeout(() => {
          const error = new Error('SMTP DNS resolution timeout');
          error.code = 'ETIMEOUT';
          reject(error);
        }, DNS_TIMEOUT);
      }),
    ]);
    clearTimeout(dnsTimer);

    if (!address || !address.address) {
      const error = new Error('No IPv4 address returned for SMTP host');
      error.code = 'ENODATA';
      throw error;
    }

    const smtpAddress = address.address;
    logSmtpStage(requestId, 'dns-resolve-complete');

    const transporter = nodemailer.createTransport({
      host: smtpAddress,
      port: SMTP_PORT,
      secure: false,
      requireTLS: true,
      connectionTimeout: CONNECTION_TIMEOUT,
      greetingTimeout: GREETING_TIMEOUT,
      socketTimeout: SOCKET_TIMEOUT,
      tls: {
        servername: SMTP_HOST,
      },
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    smtpStage = 'connect';
    logSmtpStage(requestId, 'connect-start');
    const mailOptions = {
      from: `EcoWatch <${process.env.EMAIL_FROM}>`,
      to: options.email,
      subject: options.subject,
      text: options.message,
      html: options.html,
    };

    await transporter.sendMail(mailOptions);
    smtpStage = 'delivery';
    logSmtpStage(requestId, 'delivery-complete');
  } catch (error) {
    logSmtpError(requestId, `${smtpStage}-failed`, error);
    throw error;
  } finally {
    clearTimeout(dnsTimer);
  }
};

module.exports = sendEmail;
