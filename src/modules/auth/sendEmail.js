const { sendVerificationEmail, sendPasswordResetEmail } = require('./emailServices');

const sendEmail = async (options) => {
  if (options.type === 'password-reset') {
    return sendPasswordResetEmail(options.email, options.otp, options.requestId);
  }

  return sendVerificationEmail(options.email, options.otp, options.requestId);
};

module.exports = sendEmail;
