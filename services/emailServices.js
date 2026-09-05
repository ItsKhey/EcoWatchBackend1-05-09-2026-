const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const getSender = () => {
    return process.env.EMAIL_FROM || "EcoWatch <onboarding@resend.dev>";
};

async function sendVerificationEmail(email, code) {
    const { data, error } = await resend.emails.send({
        from: getSender(),
        to: [email],
        subject: "EcoWatch Verification Code",
        text: `Your EcoWatch verification code is ${code}.

This code will expire in 5 minutes.

If you did not request this code, please ignore this email.`
    });

    if (error) {
        console.error("Resend email error:", error);
        throw new Error(error.message || "Failed to send verification email");
    }

    console.log("Verification email sent:", data);
    return data;
}

async function sendPasswordResetEmail(email, code) {
    const { data, error } = await resend.emails.send({
        from: getSender(),
        to: [email],
        subject: "EcoWatch Password Reset Code",
        text: `Your EcoWatch password reset code is ${code}.

This code will expire in 5 minutes.

If you did not request this reset, please ignore this email.`
    });

    if (error) {
        console.error("Resend email error:", error);
        throw new Error(error.message || "Failed to send password reset email");
    }

    console.log("Password reset email sent:", data);
    return data;
}

module.exports = {
    sendVerificationEmail,
    sendPasswordResetEmail
};
