const otpStore = new Map();

function generateOTP() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function createOTP(identifier) {
    const code = generateOTP();

    otpStore.set(identifier, {
        code: code,
        expiresAt: Date.now() + 5 * 60 * 1000,
        attempts: 0
    });

    return code;
}

function verifyOTP(identifier, code) {
    const storedOTP = otpStore.get(identifier);

    if (!storedOTP) {
        return {
            success: false,
            message: "No verification code found."
        };
    }

    if (Date.now() > storedOTP.expiresAt) {
        otpStore.delete(identifier);

        return {
            success: false,
            message: "Verification code has expired."
        };
    }

    if (storedOTP.attempts >= 5) {
        otpStore.delete(identifier);

        return {
            success: false,
            message: "Too many attempts. Please request a new code."
        };
    }

    if (storedOTP.code !== code) {
        storedOTP.attempts++;

        return {
            success: false,
            message: "Incorrect verification code."
        };
    }

    otpStore.delete(identifier);

    return {
        success: true,
        message: "Verification successful."
    };
}

module.exports = {
    createOTP,
    verifyOTP
};
