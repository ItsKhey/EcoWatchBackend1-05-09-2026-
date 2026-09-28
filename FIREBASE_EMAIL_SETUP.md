# Firebase email verification + password reset — setup and operations

One-time setup, then a note on what each guarantee actually rests on.

**Login is not part of this feature.** The login screen, `POST /api/auth/login`,
the JWT, and the `password_hash` bcrypt comparison in Supabase are all untouched.
Firebase is used for exactly two things: proving an email address during
registration, and proving it again during a password reset. No Firebase ID token
is accepted by any route, there is no Firebase sign-in, and no Firebase session
is a login credential.

---

## 1. Firebase console (manual, one time)

1. **Enable the provider.** Authentication → Sign-in method → enable
   **Email/Password**. It only needs to exist; nobody will ever sign in through it.

2. **Register the app's signing certificate.** Project settings → Your apps →
   *Add app* → **Android**. This is the step that makes the App Link work.

   Paste this SHA-256 (your debug keystore, read from the machine with
   `keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -storepass android -alias androiddebugkey -keypass android`):

   ```
   6E:6B:C8:98:5F:24:94:50:28:72:3B:19:86:89:E8:32:F8:6B:73:FF:F0:A6:99:A1:10:A5:ED:68:52:C3:88:F0
   ```

   Firebase Hosting serves `/.well-known/assetlinks.json` for the project
   containing exactly the fingerprints registered here, and Android compares the
   running app's certificate against it. **Debug and release builds have different
   fingerprints**, so when you set up release signing you must add that SHA-256 too
   or reset links will only open the app on debug builds.

   Without it `autoVerify` cannot succeed. The flow still works — Android just
   shows a chooser instead of opening EcoWatch directly — so this is a
   degradation, not an outage.

3. **Add the authorized domain.** Authentication → Settings → Authorized domains.
   `ecowatch1-4445f.firebaseapp.com` is already covered by the project itself, so
   nothing is needed for the App Link path. If you switch to the custom-scheme
   fallback below, add the scheme (`ecowatch`) instead — Firebase refuses to
   generate a link for a continue URL whose scheme it does not recognise.

4. **Optional: customise the email templates.** Authentication → Templates →
   *Email address verification* and *Password reset*. The defaults work but are
   branded "Firebase". Leave the action URL field alone; the backend supplies the
   continue URL per link.

5. **Confirm the service account is the one you already have.** The same
   `FIREBASE_SERVICE_ACCOUNT_JSON` that powers Cloud Messaging also powers
   verification and reset. Nothing new to create.

---

## 2. Deploy the continue page

The links continue to `https://ecowatch1-4445f.firebaseapp.com/finishSignUp`, and
that page does not exist yet. A ready-to-deploy copy is in the app at
`MyEcoWatch1/firebase-hosting/`:

```bash
cd "MyEcoWatch1/firebase-hosting"
firebase use ecowatch1-4445f
firebase deploy --only hosting
```

What it is for, precisely: when the registered SHA-256 matches, Android verifies
the link and opens EcoWatch directly, and **this page is never rendered**. It only
loads when verification has not been set up, and it hands the action code to the
app so the resident is not staring at a Firebase 404. It is a safety net.

It can be skipped if you prefer the custom-scheme fallback in section 3.

---

## 3. Render environment variables

The existing Firebase credential is reused. Add only:

```
FIREBASE_CONTINUE_URL=https://ecowatch1-4445f.firebaseapp.com/finishSignUp
FIREBASE_VERIFICATION_CONTINUE_URL=https://ecowatch1-4445f.firebaseapp.com/finishSignUp
# FIREBASE_ANDROID_PACKAGE_NAME=com.example.myecowatch1
```

Both links use the same URL on purpose. Firebase appends `mode=verifyEmail` or
`mode=resetPassword`, and the app's `EmailActionActivity` routes on that, which
keeps one URL to deploy and one to keep correct.

`GET /api/health` reports `emailVerification: CONFIGURED | NOT_CONFIGURED`, the
fastest way to confirm the credential reached the server.

### Fallback: no hosting, no registered SHA

The app also declares `ecowatch://password-reset` and
`ecowatch://email-verified`. Setting

```
FIREBASE_CONTINUE_URL=ecowatch://password-reset
```

and adding `ecowatch` to the authorized domains makes the whole feature work
with no hosting site and no certificate registration. The trade-off is that
Android shows a chooser dialog instead of opening EcoWatch silently. Useful for
getting the feature live before the release keystore exists.

---

## 3. Apply the migration

```bash
npm run migrate:firebase-email-verification
```

Additive and idempotent. It adds four columns each to `residents` and `admins`
(`firebase_uid`, `email_verified`, `verification_sent_at`, `verified_at`), widens
`pending_registrations` for the email-link flow, and widens
`password_reset_otps.otp_hash` so it can hold a rate-limit marker.

Two things it deliberately does **not** do:

- **No existing account is invalidated.** `email_verified` is backfilled from the
  pre-existing `is_verified` column, and `verified_at` from `created_at`. Nobody
  is asked to re-verify an address they already proved.
- **No existing account is re-verified on login.** `email_verified` is audit data.
  Nothing in the login path reads it, which is what keeps login unchanged.

---

## 4. Endpoints

All seven from the specification, plus the legacy routes left in place.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/register` | Register. Firebase flow when `verificationMethod: "EMAIL_LINK"`. |
| `POST /api/auth/send-verification` | Issue a verification link (also the first send). |
| `POST /api/auth/resend-verification` | Re-send, subject to a 60 s cooldown. |
| `GET /api/auth/check-verification` | Was the address proven? Creates the account on the transition. |
| `POST /api/auth/forgot-password` | Email a reset link when the body carries `email`. |
| `POST /api/auth/reset-password` | Set the new password when the body carries `oobCode`. |
| `POST /api/auth/sync-firebase-password` | Repair an account that predates Firebase. |

### Why `/register`, `/forgot-password` and `/reset-password` serve two flows

The Admin app actively calls all three, and it still uses the original 4-digit
OTP. Replacing these routes outright would have broken a shipped app. Instead the
branch is chosen by request shape, never by a client-supplied switch:

```
register         body.verificationMethod === 'EMAIL_LINK'  -> Firebase
forgot-password  body.email present                        -> Firebase
reset-password   body.oobCode present                      -> Firebase
anything else                                               -> legacy OTP
```

The Resident app sends the Firebase markers; the Admin app sends none, so it
keeps working untouched. `tests/firebaseAuth.test.js` pins both sets of request
bodies so this cannot silently change.

### The legacy routes, for the record

`verify-otp`, `verify-reset-otp` and the OTP branch of the three shared routes
are unchanged and still in use by the Admin app. Migrate the Admin app later and
those can be deleted; nothing else depends on them.

---

## 5. Flows

### Registration

```
POST /register ──> validate ──> uniqueness across residents+admins+personnel
                          └──> Firebase createUser (emailVerified: false)
                          └──> send verification link via Resend
                          └──> INSERT pending_registrations   (no account yet)

resident opens the link ──> Firebase records emailVerified: true

" I have opened the link " ──> GET /check-verification
                          └──> asks Firebase, and only Firebase, whether it is verified
                          └──> INSERT residents + DELETE pending_registrations
```

The bcrypt hash is written to `pending_registrations`, not to `residents`. An
unverified signup is therefore never a loginable account and never appears in the
residents table for an administrator to see. `check-verification` is idempotent
and safe to call after a rotation or a dropped response; once the account exists
the pending row is gone and the answer comes from `residents` instead.

### Password reset

```
POST /forgot-password { email }
  ──> resolve email ──> one resident OR admin account (never personnel)
  ──> ensure a Firebase identity exists (created on demand for legacy accounts)
  ──> generatePasswordResetLink ──> deliver via Resend

resident taps the link ──> app opens ResetPasswordActivity with the oobCode

POST /reset-password { oobCode, password }
  ──> checkActionCode(oobCode)  ──> Firebase names the address
  ──> operation must be PASSWORD_RESET
  ──> bcrypt hash ──> UPDATE password_hash in Supabase   [authoritative]
  ──> sync the Firebase password                        [best effort]
```

Two properties are worth stating plainly:

**The client never names the account.** The address comes from Firebase's
response to `checkActionCode`, so a request cannot be edited to reset somebody
else's password. A registration verification link is also rejected here, because
`operation` is checked to be `PASSWORD_RESET`.

**Supabase is written first and is the authority.** If the Firebase sync
afterwards fails, the reset still returns success with `firebaseSynced: false`
and a warning. The resident's new password already works for login immediately,
and the drift is repairable through `/sync-firebase-password`.

---

## 6. Deliberate decisions worth knowing about

**`forgot-password` does not say "email not found".** The specification asked for
that error, and it is not implemented, because it turns the endpoint into a free
oracle for discovering which addresses have an EcoWatch account. The response is
byte-identical whether or not the account exists; the real reason goes to the
server log. This matches what the legacy route already did. The resident is told
to check their inbox either way, which is also the correct UX for a forgotten
password.

**`/sync-firebase-password` requires the current password, not just a JWT.** A
token on a shared or stolen device would otherwise be enough to seize the
account's email identity and take over all future password resets. It also
refuses to rotate a password — `newPassword` must equal the current one, and
`/change-password` is the only route that can actually change a credential.

**`check-verification` creates the account.** The specification describes checking
status and separately waiting for verification. Once the answer is yes there is
nothing left to decide, so the resident row is created on that transition rather
than behind a second button. It can only ever run once: the pending row is
deleted as part of the insert, and a concurrent duplicate is caught on the unique
index and answered from the row the winner created.

**Legacy accounts are bridged, not stranded.** An account with no `firebase_uid`
is not excluded from password reset. A Firebase identity is created on demand
with a random placeholder password — enough for Firebase to issue a link, never
usable for anything — and overwritten with the real new password the moment the
reset completes.

**Personnel are excluded.** `personnel_accounts` authenticate through
`/api/personnel/login` and are reset by an administrator through `/api/personnel`.
Registration already prevents an address being shared with a resident or admin
account, so excluding them here cannot lock anyone out of their own reset.

---

## 7. Verification

```bash
npm test
```

`tests/firebaseAuth.test.js` covers the load-bearing claims: that the login path
still takes `username` + `password` and references no Firebase credential, that
the Admin app's exact request bodies still route to the OTP transport, that the
Resident app's route to the Firebase transport, and the password policy including
bcrypt's 72-**byte** ceiling (a 40-emoji password is 160 bytes and would
otherwise be silently truncated).

An end-to-end check needs a real inbox:

1. Register with an address you control. The account should not appear in
   `residents` yet.
2. Open the link. "I have opened the link" should create the account and offer
   the username.
3. Sign in on the **unchanged** login screen with username + password.
4. Forgot password → send link → open it → set a new password → sign in again
   with the same username and the new password.
