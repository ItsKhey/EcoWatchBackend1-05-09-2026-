# Backend source layout

The runtime code lives under `src/`. `server.js` stays at the project root and
is the only entry point; it wires the HTTP middleware and mounts each module's
router.

```
src/
├── config/        Database pool, Cloudinary, and Firebase Admin setup
├── middleware/    Express middleware (auth guards, uploads, error handling)
├── shared/        Cross-cutting helpers and validation shared by modules
└── modules/       One folder per business domain
```

## Modules

| Module | Responsibility |
| --- | --- |
| `auth` | Resident/admin/personnel login, registration, OTP, Firebase email verification, password reset |
| `admin` | Administrator directory, admin routes, admin audit trail |
| `announcements` | Announcement publishing, listing, expiry cleanup |
| `history` | Report/account history reads and history retention cleanup |
| `notifications` | Resident/admin notification center, preferences, FCM push delivery |
| `personnel` | Personnel accounts, cleaning teams, task assignments, personnel notifications |
| `reports` | Report submission, lifecycle, assignments, clusters, duplicate review, photos |
| `residents` | Reporter (resident) accounts, admin-side resident management, account purge |
| `vehicles` | Collection fleet management |

Each module keeps its own `*Routes.js`, `*Controller.js`, `*Service.js`,
`*Repository.js`, and `*Validation.js` files together, so a feature can be read
or changed without jumping across top-level layer folders.

## Dependency direction

* `modules/*` may import from `config/`, `middleware/`, and `shared/`.
* `shared/` must not import from `modules/`.
* A module may import another module when the domain genuinely spans both
  (for example, `admin` mounts personnel and resident management routes).
  Prefer moving truly reusable logic into `shared/` instead of duplicating it.

## Other folders

* `database/migrations/` — JavaScript migration runners and their `sql/` files.
* `scripts/` — operational and verification scripts. Ad-hoc schema checks live
  in `scripts/checks/`.
* `tests/` — automated tests. Manual database smoke tests live in
  `tests/manual/`.
* `uploads/` — local image storage served by `server.js` at `/uploads`.
