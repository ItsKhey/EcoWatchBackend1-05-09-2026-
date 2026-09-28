# Firebase email verification + password reset — setup and operations

One-time setup, then a note on what each guarantee actually rests on.

**Login is not part of this feature.** The login screen, `POST /api/auth/login`,
the JWT, and the `password_hash` bcrypt comparison in Supabase are all untouched.
No Firebase ID token, session or provider is consulted by login.

---

## 0. How the architecture works, and the one Firebase session in it

Firebase proves that a person owns an email address. Nothing more.

There is a deliberate, short-lived Firebase session in the **app**, and it exists
for one mechanical reason: **Firebase will not send a verification email unless a
user is signed in.** Since EcoWatch never signs anyone in, the app creates the
Firebase user during registration purely so Firebase can deliver and track that
one email, then signs out as soon as the EcoWatch account exists.

What that session is not:

- **Not an EcoWatch login.** The app never asks Firebase whether a credential is
  valid. Sign-in is username + password against Supabase, and the JWT from this
  backend is the only session EcoWatch has.
- **Not a grant of access.** The account it describes does not exist in Supabase
  until this backend confirms the address was verified.
- **Not long-lived.** `FirebaseEmailSession.signOutQuietly()` runs on success and
  on every abandonment path.

The token is honoured in exactly **one** route, `check-verification`, and it
*creates an account* rather than granting access to one. `tests/firebaseAuth.test.js`
enforces both halves: the service is the only file that may call `verifyIdToken`,
and the login path is asserted free of any Firebase credential.

### The backend sends no email at all

This is the largest change from the previous revision. There is no outbound mail
credential on the server:

- **Registration** — the app creates the Firebase user, then calls
  `sendEmailVerification()`.
- **Password reset** — the app calls `sendPasswordResetEmail()`.

The backend's role in the reset is to *prepare* it: `forgot-password` makes sure a
Firebase identity exists for the address, because Firebase will not send for an
address it has never seen, and an account predating this feature has none. It also
enforces the cooldown.

**Consequence to know:** delivery is subject to Firebase's own mail quotas, which
are much tighter than a dedicated provider's. Fine for a capstone and for test
accounts; check the quota is adequate before onboarding many real residents.

---

## 1. Firebase console (manual, one time)

1. **Enable the provider.** Authentication → Sign-in method → enable
   **Email/Password**.

2. **Register the app's signing certificate.** Project settings → Your apps → Add
   app → **Android**.

   Paste this SHA-256 (read from the machine with
   `keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -storepass android -alias androiddebugkey -keypass android`):

   ```
   6E:6B:C8:98:5F:24:94:50:28:72:3B:19:86:89:E8:32:F8:6B:73:FF:F0:A6:99:A1:10:A5:ED:68:52:C3:88:F0
   ```

   Firebase Hosting serves `/.well-known/assetlinks.json` containing exactly the
   fingerprints registered here. Debug and release builds have different
   fingerprints, so add the release SHA-256 too when you set up release signing.

3. **Optional: customise the email templates.** Authentication → Templates →
   *Email address verification* and *Password reset*. The defaults work but are
   branded "Firebase". The action URL is supplied per-send by the app in
   `ActionCodeSettings`, so leave that field alone.

4. **Confirm the service account is the one you already have.** The same
   `FIREBASE_SERVICE_ACCOUNT_JSON` that powers Cloud Messaging also powers
   verification and reset.

---

## 2. Deploy the continue page

The links continue to `https://ecowatch1-4445f.firebaseapp.com/finishSignUp`. A
ready-to-deploy copy is in the app at `MyEcoWatch1/firebase-hosting/`:

```bash
cd "MyEcoWatch1/firebase-hosting"
firebase use ecowatch1-4445f
firebase deploy --only hosting
```

When the registered SHA-256 matches, Android verifies the link and opens EcoWatch
directly, and **this page is never rendered**. It exists so a failure degrades
into a working hand-off rather than a 404.

---

## 3. Render environment variables

Only the existing Firebase credential is needed. **No mail provider variables are
used by the Resident flow** — `RESEND_API_KEY` and `EMAIL_FROM` are now needed
solely by the Admin app's legacy OTP flow, and can be removed entirely once that
app moves to Firebase.

`GET /api/health` reports `emailVerification: CONFIGURED | NOT_CONFIGURED`.

---

## 4. Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/register` | Validates and stages the signup. Sends nothing. |
| `POST /api/auth/check-verification` | Confirms a verified Firebase session; creates the resident. |
| `POST /api/auth/forgot-password` | Prepares a reset (creates the identity, applies cooldown). Sends nothing. |
| `POST /api/auth/reset-password` | Sets the new password from a reset `oobCode`. |
| `POST /api/auth/sync-firebase-password` | Repair an account that predates Firebase. |

There is deliberately **no** `send-verification` or `resend-verification` route.
Firebase cannot re-send a verification email from the server, so the app does it
through the client SDK and the server's only remaining job is to confirm the
resulting session.

### Two transports, one route

The Admin app still uses the original 4-digit OTP, so `register`,
`forgot-password` and `reset-password` are shared. The branch is chosen by
request shape, never by a client-supplied switch:

```
register         body.verificationMethod === 'EMAIL_LINK'  -> Firebase
forgot-password  body.email present                        -> Firebase
reset-password   body.oobCode present                      -> Firebase
anything else                                               -> legacy OTP
```

`check-verification` is **POST**, not GET, because the ID token must never travel
in a URL where it could be logged or cached.

---

## 5. Flows

### Registration

```
POST /register ──> validate ──> uniqueness across residents+admins+personnel
                          └──> INSERT pending_registrations        (no account yet)

app  ───────────> Firebase createUserWithEmailAndPassword   [session starts]
app  ───────────> Firebase sendEmailVerification()            [email sent]

resident opens the link, returns to the app

app  ───────────> currentUser.reload()                        [emailVerified refreshes]
app  ───────────> getIdToken(true)
POST /check-verification { registrationId, idToken }
              └──> verifyIdToken(idToken, true)   signature + revocation + email_verified
              └──> address must match the registration
              └──> INSERT residents + DELETE pending_registrations
app  ───────────> signOut()                                   [session ends]
resident signs in on the unchanged login screen with username + password
```

The bcrypt hash is written to `pending_registrations`, not to `residents`. An
unverified signup is never a loginable account and never appears in the residents
table. The endpoint is idempotent and safe to retry: a concurrent duplicate hits
the unique index and is answered from the row the winner created.

### Password reset

```
POST /forgot-password { email }
  ──> resolve email ──> one resident OR admin account (never personnel)
  ──> ensure a Firebase identity exists, backfill firebase_uid
  ──> record the cooldown          (never reveals whether the account exists)

app  ───────────> Firebase sendPasswordResetEmail()           [email sent]

resident taps the link ──> app opens ResetPasswordActivity with the oobCode

POST /reset-password { oobCode, password }
  ──> checkActionCode(oobCode)  ──> Firebase names the address
  ──> operation must be PASSWORD_RESET
  ──> bcrypt hash ──> UPDATE password_hash in Supabase   [authoritative]
  ──> sync the Firebase password                        [best effort]
```

Two properties worth stating plainly:

**The client never names the account.** The address comes from Firebase's response
to `checkActionCode`, so a request cannot be edited to reset somebody else's
password. A registration verification link is rejected too, because `operation` is
checked to be `PASSWORD_RESET`.

**Supabase is written first and is the authority.** If the Firebase sync
afterwards fails, the reset still returns success with `firebaseSynced: false` and
a warning. The new password works for login immediately.

---

## 6. Deliberate decisions

**`forgot-password` does not say "email not found".** Returning it would turn the
endpoint into an oracle for discovering which addresses have an EcoWatch account.
The message is identical either way; the real reason goes to the log. The app
receives a `canRequestFirebaseEmail` flag instead, which is not displayed.

**`/sync-firebase-password` requires the current password, not just a JWT.** A
token on a shared device would otherwise be enough to seize the account's email
identity and take over future resets. It also refuses to rotate a password.

**Legacy accounts are bridged, not stranded.** An account with no `firebase_uid`
gets an identity created on its first password reset, with a random placeholder
password — enough for Firebase to deliver, never usable, overwritten with the real
password as soon as the reset completes.

**Personnel are excluded.** They authenticate through `/api/personnel/login` and
are reset by an administrator. Registration already prevents an address being
shared with a resident or admin account.

---

## 7. Verification

```bash
npm test
```

`tests/firebaseAuthFlow.test.js` calls every handler with stubbed dependencies, so
a `ReferenceError` inside a function body cannot hide — the failure mode that
shipped twice during this work. `tests/firebaseAuth.test.js` covers login
unchanged, transport dispatch, and the single-`verifyIdToken` rule.

An end-to-end check needs a real inbox:

1. Register. The account should **not** appear in `residents` yet.
2. Open the link. The app should return to "I have opened the link" and create the
   account.
3. Sign in on the **unchanged** login screen with username + password.
4. Forgot password → send → open the link → set a new password → sign in with the
   same username and the new password.
