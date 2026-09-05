const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  const emailService = process.env.EMAIL_SERVICE;

  const transporter = nodemailer.createTransport({
    host: emailService === 'gmail' ? 'smtp.gmail.com' : emailService,
    port: 587,
    secure: false,
    requireTLS: true,
    family: 4,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: `EcoWatch <${process.env.EMAIL_FROM}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: options.html,
  };

  await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;
