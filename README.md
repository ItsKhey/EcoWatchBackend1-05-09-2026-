# MyEcoWatchBackend1

The production-ready backend for the EcoWatch ecosystem.

## Features
- JWT Authentication
- Multi-resident email OTP verification
- Permanent Resident IDs (`RES-XXXXXXXX`)
- Cloudinary Image Upload
- Report Management
- MongoDB Atlas integration
- Request Correlation Logging

## Setup
1. Copy `.env.example` to `.env` (or use existing `.env`)
2. Fill in the required environment variables:
   - `MONGODB_URI`
   - `JWT_SECRET`
   - `EMAIL_PASS` (Gmail App Password)
   - `CLOUDINARY_*` credentials
3. Run `npm install`
4. Run `npm run dev` to start in development mode.

## API Endpoints
### Auth
- `POST /api/auth/register` - Step 1: Register and receive `registrationId`
- `POST /api/auth/verify-otp` - Step 2: Verify OTP and create resident account
- `POST /api/auth/login` - Login with `username` and `password`
- `GET /api/auth/me` - Get current resident profile (Protected)

### Reports
- `POST /api/reports` - Submit report with image (Multipart) (Protected)
- `GET /api/reports/my-reports` - Get reports for the current resident (Protected)
