const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const getSender = () => {
    return process.env.EMAIL_FROM || "EcoWatch <onboarding@resend.dev>";
};

/*
 * ---------------------------------------------------------------------------
 * Delivery failure diagnosis
 * ---------------------------------------------------------------------------
 * Resend's onboarding@resend.dev is a testing sender. It can only deliver to the
 * address registered to the Resend account, so it silently becomes a
 * single-recipient mailbox the moment a real resident signs up. When that
 * happens every send fails with a validation_error that says so clearly, but the
 * resident only ever sees "we could not send the verification email".
 *
 * These helpers keep the operator-facing detail in the server log where it
 * belongs, and give the client a message that is actionable without disclosing
 * anything about the mail provider.
 */

/** The sender is the testing address and this recipient is not the account owner. */
const isTestingSenderRestriction = (message) =>
    /testing emails to your own email address/i.test(String(message || ""));

const classifyDeliveryFailure = (error) => {
    const providerMessage = String(error?.message || "");

    if (isTestingSenderRestriction(providerMessage)) {
        return {
            code: "EMAIL_SENDER_NOT_PERMITTED",
            // Shown to the client. Names the problem without naming the provider.
            clientMessage: "We could not send the email. Email delivery is not "
                + "configured for this address yet. Please contact your administrator.",
            // Written to the server log only. This is the part that fixes it.
            operatorHint: "EMAIL_FROM is the Resend testing sender, which may only "
                + "deliver to the address registered to the Resend account "
                + `(${providerMessage}). Verify a sending domain in the Resend `
                + "dashboard, add its DNS records, then set EMAIL_FROM to an "
                + "address on that domain."
        };
    }

    return {
        code: "EMAIL_DELIVERY_FAILED",
        clientMessage: "We could not send the email. Please try again in a moment.",
        operatorHint: providerMessage || "Resend reported an error with no message."
    };
};

const createDeliveryError = (clientMessage, code, operatorHint) => {
    const error = new Error(clientMessage);
    error.statusCode = 502;
    error.code = code;
    error.operatorHint = operatorHint;
    return error;
};

/**
 * Single delivery path for every EcoWatch email.
 *
 * <p>Centralised so a provider failure is always turned into the same tagged
 * error, whichever journey triggered it. Callers decide what the resident is
 * told; the diagnosis is preserved on the error for the log.
 */
async function sendEmail({ to, subject, text }) {
    const { data, error } = await resend.emails.send({
        from: getSender(),
        to: [to],
        subject,
        text
    });

    if (error) {
        console.error("Resend delivery error:", error);
        const classified = classifyDeliveryFailure(error);
        throw createDeliveryError(
            classified.clientMessage,
            classified.code,
            classified.operatorHint
        );
    }

    return data;
}

async function sendVerificationEmail(email, code) {
    const data = await sendEmail({
        to: email,
        subject: "EcoWatch Verification Code",
        text: `Your EcoWatch verification code is ${code}.

This code will expire in 5 minutes.

If you did not request this code, please ignore this email.`
    });

    console.log("Verification email sent:", data);
    return data;
}

async function sendPasswordResetEmail(email, code) {
    const data = await sendEmail({
        to: email,
        subject: "EcoWatch Password Reset Code",
        text: `Your EcoWatch password reset code is ${code}.

This code will expire in 5 minutes.

If you did not request this reset, please ignore this email.`
    });

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

    const data = await sendEmail({
        to: email,
        subject: "Verify your EcoWatch email address",
        text: `${greeting}

Confirm this email address to finish creating your EcoWatch resident account.

${link}

This link expires in 24 hours. If you did not create an EcoWatch account, you
can safely ignore this email.`
    });

    console.log("Firebase verification link sent:", data);
    return data;
}

async function sendFirebasePasswordResetLink(email, link, username) {
    const greeting = username ? `Hi ${username},` : 'Hi,';

    const data = await sendEmail({
        to: email,
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

    console.log("Firebase password reset link sent:", data);
    return data;
}

module.exports = {
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendFirebaseVerificationLink,
    sendFirebasePasswordResetLink,
    classifyDeliveryFailure,
    isTestingSenderRestriction
};
