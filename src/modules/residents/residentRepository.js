const { pool } = require('../../config/db');
const reportRepository = require('../reports/reportRepository');

/*
 * Public resident projections intentionally omit password_hash.  Activity
 * column detection keeps the read compatible with databases that have not run
 * the optional activity migration yet; after the migration it prefers the
 * dedicated server-owned column and falls back to existing profile timestamps.
 */
const RESIDENT_PUBLIC_BASE_FIELDS = `
  r.resident_id,
  r.first_name,
  r.last_name,
  r.username,
  r.email,
  r.address,
  r.profile_image,
  r.is_verified,
  r.role,
  r.status,
  r.phone_number,
  r.messenger_link,
  r.created_at,
  r.updated_at,
  r.disabled_by_resident,
  r.disabled_at
`;

let residentActivityColumn;
let residentActivityColumnPromise;

async function getResidentActivityColumn(queryable = pool) {
  if (residentActivityColumn) return residentActivityColumn;
  if (residentActivityColumnPromise) return residentActivityColumnPromise;

  residentActivityColumnPromise = queryable.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'residents'
        AND column_name = 'last_active'
    ) AS available
    `
  )
    .then((result) => {
      residentActivityColumn = result.rows[0]?.available === true
        ? 'r.last_active'
        : 'r.updated_at';
      return residentActivityColumn;
    })
    .catch((error) => {
      residentActivityColumnPromise = null;
      throw error;
    });

  return residentActivityColumnPromise;
}

let residentDisableAttributionColumn;
let residentDisableAttributionPromise;

/*
 * Migration 026 adds residents.disabled_by_admin_id so an administrator disable
 * is distinguishable from a self-service pause. It is probed the same way
 * last_active is, so a database that has not run that migration yet still
 * serves reporter details and admin disables: the column is simply absent, and
 * the attribution reads as unknown rather than the whole feature failing on a
 * missing-column error.
 */
async function getResidentDisableAttributionColumn(queryable = pool) {
  if (residentDisableAttributionColumn) return residentDisableAttributionColumn;
  if (residentDisableAttributionPromise) return residentDisableAttributionPromise;

  residentDisableAttributionPromise = queryable.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'residents'
        AND column_name = 'disabled_by_admin_id'
    ) AS available
    `
  )
    .then((result) => {
      residentDisableAttributionColumn =
        result.rows[0]?.available === true ? 'r.disabled_by_admin_id' : null;
      return residentDisableAttributionColumn;
    })
    .catch((error) => {
      residentDisableAttributionPromise = null;
      throw error;
    });

  return residentDisableAttributionPromise;
}

function residentPublicFields(activityColumn) {
  return `
    ${RESIDENT_PUBLIC_BASE_FIELDS},
    COALESCE(${activityColumn}, r.updated_at, r.created_at) AS last_active
  `;
}

async function findPublicByResidentId(residentId, queryable = pool) {
  const activityColumn = await getResidentActivityColumn(queryable);
  const result = await queryable.query(
    `
    SELECT
      ${residentPublicFields(activityColumn)},
      (
        SELECT COUNT(*)::int
        FROM (
          SELECT report_count.report_id
          FROM reports report_count
          WHERE report_count.resident_id = r.resident_id
          UNION
          SELECT archived_count.report_id
          FROM archived_reports archived_count
          WHERE archived_count.resident_id = r.resident_id
        ) report_count
      ) AS total_reports
    FROM residents r
    WHERE r.resident_id = $1
      AND lower(trim(COALESCE(r.role, 'RESIDENT'))) = 'resident'
    LIMIT 1
    `,
    [residentId]
  );

  return result.rows[0] || null;
}

function buildAdminResidentConditions(options = {}, values = []) {
  const conditions = ["lower(trim(COALESCE(r.role, 'RESIDENT'))) = 'resident'"];

  if (options.status === 'ACTIVE') {
    conditions.push(`lower(trim(COALESCE(r.status, 'AVAILABLE'))) NOT IN (
      'disabled', 'inactive', 'blocked', 'suspended', 'deleted'
    )`);
  } else if (options.status === 'DISABLED') {
    conditions.push(`lower(trim(COALESCE(r.status, ''))) IN (
      'disabled', 'inactive', 'blocked', 'suspended', 'deleted'
    )`);
  }

  if (options.search) {
    values.push(`%${options.search}%`);
    const searchParameter = `$${values.length}`;
    conditions.push(`(
      r.resident_id ILIKE ${searchParameter}
      OR r.first_name ILIKE ${searchParameter}
      OR r.last_name ILIKE ${searchParameter}
      OR concat_ws(' ', r.first_name, r.last_name) ILIKE ${searchParameter}
      OR r.username ILIKE ${searchParameter}
      OR r.email ILIKE ${searchParameter}
    )`);
  }

  return conditions;
}

async function countAllForAdmin(options = {}, queryable = pool) {
  const values = [];
  const conditions = buildAdminResidentConditions(options, values);
  const result = await queryable.query(
    `
    SELECT COUNT(*)::int AS total
    FROM residents r
    WHERE ${conditions.join(' AND ')}
    `,
    values
  );
  return Number(result.rows[0]?.total || 0);
}

async function findAllForAdmin(options = {}, queryable = pool) {
  const activityColumn = await getResidentActivityColumn(queryable);
  const values = [];
  const conditions = buildAdminResidentConditions(options, values);

  values.push(options.limit);
  const limitParameter = `$${values.length}`;
  values.push(options.offset);
  const offsetParameter = `$${values.length}`;

  const result = await queryable.query(
    `
    SELECT
      ${residentPublicFields(activityColumn)},
      (
        SELECT COUNT(*)::int
        FROM (
          SELECT report_count.report_id
          FROM reports report_count
          WHERE report_count.resident_id = r.resident_id
          UNION
          SELECT archived_count.report_id
          FROM archived_reports archived_count
          WHERE archived_count.resident_id = r.resident_id
        ) report_count
      ) AS total_reports,
      COUNT(*) OVER() AS total_count
    FROM residents r
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      lower(COALESCE(r.last_name, '')),
      lower(COALESCE(r.first_name, '')),
      r.resident_id
    LIMIT ${limitParameter} OFFSET ${offsetParameter}
    `,
    values
  );

  return result.rows;
}

/**
 * Records resident activity without exposing or returning credentials.  The
 * fallback keeps older installations functional until the idempotent
 * last_active migration has been applied.
 */
async function touchLastActive(residentId) {
  const activityColumn = await getResidentActivityColumn();
  if (activityColumn === 'r.last_active') {
    const result = await pool.query(
      `
      UPDATE residents
      SET last_active = NOW()
      WHERE resident_id = $1
      RETURNING last_active
      `,
      [residentId]
    );
    return result.rows[0]?.last_active || null;
  }

  const fallback = await pool.query(
    `
    UPDATE residents
    SET updated_at = NOW()
    WHERE resident_id = $1
    RETURNING updated_at
    `,
    [residentId]
  );
  return fallback.rows[0]?.updated_at || null;
}

async function findByIdentifier(identifier) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE username = $1
       OR email = $1
       OR resident_id = $1
    LIMIT 1
    `,
    [identifier]
  );

  return result.rows[0] || null;
}

async function findByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE resident_id = $1
    LIMIT 1
    `,
    [residentId]
  );

  return result.rows[0] || null;
}

async function findFcmTokenByResidentId(residentId) {
  const result = await pool.query(
    `
    SELECT fcm_token
    FROM residents
    WHERE resident_id = $1
      AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
    LIMIT 1
    `,
    [residentId]
  );
  return result.rows[0]?.fcm_token || null;
}

async function findByUsername(username) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE username = $1
    LIMIT 1
    `,
    [username]
  );

  return result.rows[0] || null;
}

async function findByEmail(email) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE email = $1
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

// Compatibility lookup for Phase 1 personnel that was stored in residents.
// These rows remain report-assignment compatible but are never copied into
// personnel_accounts or used to authenticate through /api/personnel/login.
async function findLegacyPersonnelByIds(
  residentIds,
  { queryable = pool, lock = false } = {}
) {
  if (!residentIds.length) {
    return [];
  }

  const result = await queryable.query(
    `
    SELECT *
    FROM residents
    WHERE resident_id = ANY($1::varchar[])
      AND lower(role) = lower('Environmental Services Personnel')
      AND lower(trim(COALESCE(status, 'AVAILABLE'))) NOT IN (
        'disabled', 'inactive', 'blocked', 'suspended', 'deleted'
      )
    ORDER BY resident_id
    ${lock ? 'FOR UPDATE' : ''}
    `,
    [residentIds]
  );

  return result.rows;
}

async function findByRole(role) {
  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE role = $1
    ORDER BY created_at DESC
    `,
    [role]
  );

  return result.rows;
}

async function createResident({
  residentId,
  firstName,
  lastName,
  username,
  email,
  passwordHash,
  address = '',
  profileImage = '',
  isVerified = true,
  role = 'RESIDENT',
  status = 'AVAILABLE',
  phoneNumber = '',
  messengerLink = null,
  createdById = 'SYSTEM',
  firebaseUid = null,
  emailVerified = isVerified,
  verifiedAt = null,
}) {
  /*
   * verified_at is stamped server-side whenever the address was actually proven.
   * Legacy OTP registrations pass isVerified: true, and the code they entered
   * was itself the proof, so they are stamped too. Rows that predate this
   * migration keep a NULL verified_at, which is why nothing gates login on it.
   */
  const result = await pool.query(
    `
    INSERT INTO residents (
      resident_id,
      first_name,
      last_name,
      username,
      email,
      password_hash,
      address,
      profile_image,
      is_verified,
      role,
      status,
      phone_number,
      messenger_link,
      created_by_id,
      firebase_uid,
      email_verified,
      verified_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14,
      $15, $16, COALESCE($17, NOW())
    )
    RETURNING *
    `,
    [
      residentId,
      firstName,
      lastName,
      username,
      email,
      passwordHash,
      address,
      profileImage,
      isVerified,
      role,
      status,
      phoneNumber,
      messengerLink,
      createdById,
      firebaseUid,
      emailVerified,
      verifiedAt,
    ]
  );

  return result.rows[0];
}

/**
 * Columns a profile update may write.
 *
 * <p>Hoisted out of updateResident so it can be asserted directly: this map is
 * the only thing standing between a request body and an arbitrary column write,
 * and "messenger_link is reachable" is a contract the admin app depends on.
 */
const RESIDENT_UPDATABLE_FIELDS = {
  firstName: 'first_name',
  lastName: 'last_name',
  username: 'username',
  email: 'email',
  address: 'address',
  profileImage: 'profile_image',
  isVerified: 'is_verified',
  role: 'role',
  status: 'status',
  phoneNumber: 'phone_number',
  messengerLink: 'messenger_link',
  createdById: 'created_by_id',
};

async function updateResident(residentId, updates) {
  const allowedFields = RESIDENT_UPDATABLE_FIELDS;

  const setParts = [];
  const values = [];
  let parameterIndex = 1;

  for (const [field, value] of Object.entries(updates)) {
    const column = allowedFields[field];

    if (!column) continue;

    setParts.push(`${column} = $${parameterIndex}`);
    values.push(value);
    parameterIndex++;
  }

  if (setParts.length === 0) {
    return findByResidentId(residentId);
  }

  setParts.push(`updated_at = NOW()`);

  values.push(residentId);

  const result = await pool.query(
    `
    UPDATE residents
    SET ${setParts.join(', ')}
    WHERE resident_id = $${parameterIndex}
    RETURNING *
    `,
    values
  );

  return result.rows[0] || null;
}

/**
 * Claims a device token for exactly one resident. A token can move between
 * accounts after logout/login, so any previous owner is cleared before the
 * authenticated resident is updated. The advisory lock prevents two rapid
 * account switches from claiming the same token in different transactions.
 */
async function claimFcmToken(residentId, token) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2c:fcm-token:v1'))"
    );
    await client.query(
      `
      UPDATE residents
      SET fcm_token = NULL
      WHERE fcm_token = $1
        AND resident_id <> $2
      `,
      [token, residentId]
    );
    const result = await client.query(
      `
      UPDATE residents
      SET fcm_token = $2
      WHERE resident_id = $1
        AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
      RETURNING resident_id
      `,
      [residentId, token]
    );
    await client.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(`[FCM_TOKEN] Rollback failed: ${rollbackError.message}`);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function clearFcmToken(residentId, expectedToken = null) {
  const values = expectedToken ? [residentId, expectedToken] : [residentId];
  const predicate = expectedToken ? 'AND fcm_token = $2' : '';
  const result = await pool.query(
    `
    UPDATE residents
    SET fcm_token = NULL
    WHERE resident_id = $1
      ${predicate}
    RETURNING resident_id
    `,
    values
  );
  return result.rowCount > 0;
}

async function updatePassword(residentId, passwordHash) {
  const result = await pool.query(
    `
    UPDATE residents
    SET password_hash = $1,
        updated_at = NOW()
    WHERE resident_id = $2
    RETURNING *
    `,
    [passwordHash, residentId]
  );

  return result.rows[0] || null;
}

/*
 * ---------------------------------------------------------------------------
 * Firebase email-verification columns
 * ---------------------------------------------------------------------------
 * These four helpers are the only writers of firebase_uid / email_verified /
 * verification_sent_at / verified_at. They are intentionally narrow: nothing
 * outside this block can mark an address as verified, so "verified" has exactly
 * one meaning in this codebase.
 */

/**
 * Backfills the Firebase identity for an account created before this feature.
 * Never overwrites an existing uid, so re-running a sync cannot orphan an
 * identity that password-reset emails are already being generated for.
 */
async function setFirebaseUid(residentId, firebaseUid) {
  if (!firebaseUid) {
    return findByResidentId(residentId);
  }

  const result = await pool.query(
    `
    UPDATE residents
    SET firebase_uid = $2
    WHERE resident_id = $1
      AND firebase_uid IS NULL
    RETURNING *
    `,
    [residentId, firebaseUid]
  );

  return result.rows[0] || findByResidentId(residentId);
}

/**
 * Records that the address behind this account was proven. verification_sent_at
 * is only refreshed when the account has never been verified, so a later
 * resend cannot rewrite the original verification timestamp.
 */
async function markEmailVerified(residentId, { verificationSentAt = null } = {}) {
  const result = await pool.query(
    `
    UPDATE residents
    SET email_verified = true,
        is_verified = true,
        verified_at = COALESCE(verified_at, NOW()),
        verification_sent_at = COALESCE(
          verification_sent_at,
          $2,
          NOW()
        ),
        updated_at = NOW()
    WHERE resident_id = $1
    RETURNING *
    `,
    [residentId, verificationSentAt]
  );

  return result.rows[0] || null;
}

/** Resolves a resident through their Firebase identity. */
async function findByFirebaseUid(firebaseUid) {
  if (!firebaseUid) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT *
    FROM residents
    WHERE firebase_uid = $1
    LIMIT 1
    `,
    [firebaseUid]
  );

  return result.rows[0] || null;
}

/**
 * Pauses one resident account on that resident's own request. This is a pause,
 * not a deletion: the account row, its reports, history and settings are all
 * left untouched so the resident returns to the exact same account later. The
 * device token is released because the account must not receive pushes while
 * it is paused.
 *
 * `disabled_by_resident` is what keeps this reversible. Authentication already
 * refuses every status in DISABLED_RESIDENT_STATUSES, and the login path only
 * restores accounts carrying this marker, so an account disabled by an
 * administrator can never be reactivated by its owner.
 */
async function pauseResidentAccount(residentId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE residents
    SET status = 'DISABLED',
        disabled_by_resident = true,
        disabled_at = NOW(),
        fcm_token = NULL,
        updated_at = NOW()
    WHERE resident_id = $1
      AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
    RETURNING *
    `,
    [residentId]
  );

  return result.rows[0] || null;
}

/**
 * Restores a self-paused resident account to its normal active status. The
 * marker is the guard: an account disabled for any other reason matches no row
 * and therefore stays disabled.
 */
async function restorePausedResidentAccount(residentId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE residents
    SET status = 'AVAILABLE',
        disabled_by_resident = false,
        disabled_at = NULL,
        updated_at = NOW()
    WHERE resident_id = $1
      AND disabled_by_resident = true
      AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
    RETURNING *
    `,
    [residentId]
  );

  return result.rows[0] || null;
}

/**
 * Permanently removes a resident account together with every row it owns.
 *
 * The deletes run in one transaction and in dependency order so no foreign key
 * or unique constraint can leave a partial account behind. Trashed
 * notifications go first because they reference the live notification, and the
 * three report collections are all removed because a resident's own reports
 * live independently in the active, archive and trash tables.
 */
async function deleteResidentAccount(residentId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // Serialize concurrent lifecycle requests for one deployment so two
    // in-flight requests cannot both read the same account as deletable.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('myecowatch:phase-2d:resident-account-lifecycle:v1'))"
    );

    await client.query(
      'DELETE FROM trash_notifications WHERE resident_id = $1',
      [residentId]
    );
    await client.query(
      'DELETE FROM notifications WHERE resident_id = $1',
      [residentId]
    );
    await client.query(
      'DELETE FROM report_histories WHERE resident_id = $1',
      [residentId]
    );
    // Account deletion permanently removes every report the resident owns, so
    // it releases those Cloudinary assets through the same shared cleanup used
    // by the report delete paths instead of orphaning every photo. Trash is
    // only a marker table, so the ids collected here cover both the active and
    // the archived copies.
    const ownedReports = await client.query(
      `
      SELECT report_id
      FROM reports
      WHERE resident_id = $1
      UNION
      SELECT report_id
      FROM archived_reports
      WHERE resident_id = $1
      `,
      [residentId]
    );
    for (const owned of ownedReports.rows) {
      await reportRepository.releaseReportImage(owned.report_id, client);
    }
    await client.query(
      'DELETE FROM reports WHERE resident_id = $1',
      [residentId]
    );
    await client.query(
      'DELETE FROM archived_reports WHERE resident_id = $1',
      [residentId]
    );
    await client.query(
      'DELETE FROM trash_reports WHERE resident_id = $1',
      [residentId]
    );
    await client.query(
      'DELETE FROM password_reset_otps WHERE user_id = $1',
      [residentId]
    );

    const deleted = await client.query(
      `
      DELETE FROM residents
      WHERE resident_id = $1
        AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
      RETURNING resident_id
      `,
      [residentId]
    );

    if (deleted.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('COMMIT');
    return deleted.rows[0].resident_id;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(`[RESIDENT_DELETE] Rollback failed: ${rollbackError.message}`);
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Disables one resident account on an administrator's request.
 *
 * This is deliberately NOT pauseResidentAccount, and the difference is the whole
 * point of this function: `disabled_by_resident` is left FALSE. The login path
 * restores an account only when that marker is true, so an administrator
 * disable can never be undone by the resident signing in again with the right
 * password. Everything else matches a self-service pause — the row, its reports,
 * history and settings are untouched, and the device token is released so the
 * account stops receiving pushes.
 *
 * The status guard makes a second disable match no row rather than rewriting
 * disabled_at, so the caller can tell "already disabled" from "disabled now".
 *
 * @param {string} residentId  The reporter being disabled.
 * @param {string} adminId     Administrator taking the action, for attribution.
 * @returns {Promise<object|null>} The updated row, or null if already disabled.
 */
async function disableResidentAccount(residentId, adminId, queryable = pool) {
  // Written without the attribution column on a database that has not run
  // migration 026. The disable itself is unaffected: it is the status and the
  // absence of the self-service marker that block the account.
  //
  // The values array is built alongside the clause rather than always passing an
  // administrator: a placeholder that the statement never references is an
  // "N parameters, but prepared statement requires M" error, so the two have to
  // agree on how many bind parameters exist.
  const attributionColumn = await getResidentDisableAttributionColumn(queryable);
  const attributionAssignment = attributionColumn
    ? 'disabled_by_admin_id = $2,'
    : '';
  const values = attributionColumn ? [residentId, adminId || null] : [residentId];

  const result = await queryable.query(
    `
    UPDATE residents
    SET status = 'DISABLED',
        disabled_by_resident = false,
        ${attributionAssignment}
        disabled_at = NOW(),
        fcm_token = NULL,
        updated_at = NOW()
    WHERE resident_id = $1
      AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
      AND lower(trim(COALESCE(status, 'AVAILABLE'))) NOT IN (
        'disabled', 'inactive', 'blocked', 'suspended', 'deleted'
      )
    RETURNING *
    `,
    values
  );

  return result.rows[0] || null;
}

/**
 * Restores an administrator-disabled resident account.
 *
 * The mirror of disableResidentAccount, and it clears `disabled_at` and
 * `disabled_by_admin_id` along with the status: leaving the attribution behind
 * would report a disabled account as active while still crediting the
 * administrator who blocked it. Restoring the normal AVAILABLE status is what
 * the resident's own pause restore does, so both paths land on the same state.
 *
 * Returns null unless the account is currently disabled, so the caller can tell
 * "restored" from "was not disabled" instead of silently succeeding.
 */
async function enableResidentAccount(residentId, queryable = pool) {
  const result = await queryable.query(
    `
    UPDATE residents
    SET status = 'AVAILABLE',
        disabled_by_resident = false,
        disabled_by_admin_id = NULL,
        disabled_at = NULL,
        updated_at = NOW()
    WHERE resident_id = $1
      AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
      AND lower(trim(COALESCE(status, 'AVAILABLE'))) IN (
        'disabled', 'inactive', 'blocked', 'suspended'
      )
    RETURNING *
    `,
    [residentId]
  );

  return result.rows[0] || null;
}

/**
 * Lists the accounts the retention job must purge.
 *
 * `disabled_by_resident = false` is the whole filter, and it is not
 * interchangeable with "status is DISABLED". A resident who paused their own
 * account also carries a DISABLED status, but that pause is explicitly
 * reversible: they can come back at any time. Purging those would delete an
 * account the resident is still entitled to, so only an administrator's disable
 * is eligible for expiry.
 *
 * `disabled_at` is the reference point rather than `updated_at`, because any
 * later profile edit would otherwise restart the 30-day clock and keep an
 * abandoned account alive indefinitely.
 */
async function findExpiredDisabledResidents(cutoff, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT resident_id, disabled_at, disabled_by_admin_id
    FROM residents
    WHERE disabled_by_resident = false
      AND disabled_at IS NOT NULL
      AND disabled_at < $1
      AND lower(trim(COALESCE(role, 'RESIDENT'))) = 'resident'
      AND lower(trim(COALESCE(status, 'AVAILABLE'))) IN (
        'disabled', 'inactive', 'blocked', 'suspended'
      )
    ORDER BY disabled_at ASC
    `,
    [cutoff]
  );

  return result.rows;
}

module.exports = {
  findPublicByResidentId,
  findAllForAdmin,
  RESIDENT_UPDATABLE_FIELDS,
  countAllForAdmin,
  touchLastActive,
  findByIdentifier,
  findByResidentId,
  findFcmTokenByResidentId,
  findByUsername,
  findByEmail,
  findLegacyPersonnelByIds,
  findByRole,
  createResident,
  updateResident,
  claimFcmToken,
  clearFcmToken,
  updatePassword,
  setFirebaseUid,
  markEmailVerified,
  findByFirebaseUid,
  pauseResidentAccount,
  restorePausedResidentAccount,
  disableResidentAccount,
  enableResidentAccount,
  findExpiredDisabledResidents,
  deleteResidentAccount,
};
