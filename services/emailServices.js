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

/*
 * ---------------------------------------------------------------------------
 * Firebase email-link delivery
 * ---------------------------------------------------------------------------
 * Firebase generates the verification and password-reset links; it does not send
 * them. Resend delivers them, so the resident receives a normal email from the
 * EcoWatch sender and the Firebase project only ever acts as the authority on
 * whether the link is genuine.
 *
 * The links are rendered as plain text on purpose. A raw anchor is what makes
 * the link clickable on desktop mail clients and inside the Android app's
 * deep-link handler, which is how the oobCode reaches the Create New Password
 * screen.
 */

async function sendFirebaseVerificationLink(email, link, username) {
    const greeting = username ? `Hi ${username},` : 'Hi,';

    const { data, error } = await resend.emails.send({
        from: getSender(),
        to: [email],
        subject: "Verify your EcoWatch email address",
        text: `${greeting}

Confirm this email address to finish creating your EcoWatch resident account.

${link}

This link expires in 24 hours. If you did not create an EcoWatch account, you
can safely ignore this email.`
    });

    if (error) {
        console.error("Resend verification link error:", error);
        throw new Error(error.message || "Failed to send verification link");
    }

    console.log("Firebase verification link sent:", data?.id);
    return data;
}

async function sendFirebasePasswordResetLink(email, link, username) {
    const greeting = username ? `Hi ${username},` : 'Hi,';

    const { data, error } = await resend.emails.send({
        from: getSender(),
        to: [email],
        subject: "Reset your EcoWatch password",
        text: `${greeting}

Use the link below to choose a new EcoWatch password. It opens the EcoWatch app
on your device, where you will set the new password.

${link}

This link expires in 1 hour. After you reset your password you will still sign
in with your username, not your email address.

If you did not request a password reset, you can safely ignore this email and
your current password will keep working.`
    });

    if (error) {
        console.error("Resend password reset link error:", error);
        throw new Error(error.message || "Failed to send password reset link");
    }

    console.log("Firebase password reset link sent:", data?.id);
    return data;
}

module.exports = {
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendFirebaseVerificationLink,
    sendFirebasePasswordResetLink
};
