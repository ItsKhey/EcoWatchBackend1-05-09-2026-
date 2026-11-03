const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Local disk implementation of the image storage contract.
 *
 * This is the provider that lets the whole project run against a local
 * PostgreSQL server and a local Node server with no third party CDN in the
 * request path. It deliberately mirrors the shape of the Cloudinary response so
 * `cloudinaryService` can hand either one back to its callers untouched:
 *
 *   { secure_url, public_id }
 *
 * Stored URLs are site relative (`/uploads/ecowatch/reports/<name>.jpg`), which
 * is what the apps already expect. They expand a relative path against whichever
 * server they are pointed at, so the same database works locally and against a
 * hosted deployment without a rewrite.
 */

const UPLOADS_ROOT = path.resolve(__dirname, '..', 'uploads');
const PUBLIC_PREFIX = '/uploads/';

// Multer writes report and profile photos to the same folder, so the folder
// always exists by the time a request is served. Creating it on boot keeps a
// fresh clone from 404ing on every image.
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

/**
 * Identifies the format from the bytes instead of trusting the declared mime
 * type or the client supplied filename, because a multipart part carries
 * whatever the app chose to claim.
 */
const detectExtension = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '.jpg';

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return '.jpg';
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return '.png';
  }

  if (buffer.toString('ascii', 0, 4) === 'GIF8') return '.gif';

  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return '.webp';
  }

  return '.jpg';
};

/**
 * Resolves a caller supplied folder to an absolute path inside the uploads root
 * and returns null when it tries to escape. The folder reaches this function
 * from a module constant today, but the traversal guard is what makes a stored
 * path trustworthy later on, in toLocalPath, when the value comes from a
 * database row instead of from code.
 */
const resolveInsideRoot = (...segments) => {
  const resolved = path.resolve(UPLOADS_ROOT, ...segments);
  const rootWithSeparator = UPLOADS_ROOT.endsWith(path.sep)
    ? UPLOADS_ROOT
    : `${UPLOADS_ROOT}${path.sep}`;

  if (resolved !== UPLOADS_ROOT && !resolved.startsWith(rootWithSeparator)) {
    return null;
  }

  return resolved;
};

/** Trims a folder to a clean `a/b` shape and rejects anything with a traversal. */
const normalizeFolder = (folder) => {
  const segments = String(folder || 'ecowatch/reports')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..' && !segment.startsWith('.')
    );

  return segments.length > 0 ? segments.join('/') : 'ecowatch/reports';
};

/**
 * Turns a stored URL into an absolute path on disk, or null when the value is
 * not one of ours. A `..` segment, a percent encoded separator, or a Windows
 * drive letter all fail the containment check and resolve to null rather than
 * to a file outside the uploads directory.
 */
const toLocalPath = (imageUrl) => {
  if (typeof imageUrl !== 'string') return null;

  const trimmed = imageUrl.trim();
  if (!trimmed.startsWith(PUBLIC_PREFIX)) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch (error) {
    // Malformed escape sequence. Treated as untrusted and ignored.
    return null;
  }

  if (decoded.includes('\0')) return null;

  const relative = decoded.slice(PUBLIC_PREFIX.length);
  if (!relative) return null;

  return resolveInsideRoot(...relative.split('/').filter(Boolean));
};

const uploadImage = async (buffer, folder = 'ecowatch/reports') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Image data is empty');
  }

  const relativeFolder = normalizeFolder(folder);
  const targetDirectory = resolveInsideRoot(...relativeFolder.split('/'));

  if (!targetDirectory) {
    throw new Error('Refusing to write outside the uploads directory');
  }

  await fsp.mkdir(targetDirectory, { recursive: true });

  // Random name so two uploads of the same original photo never collide, and
  // so a user supplied filename never reaches the filesystem.
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${detectExtension(buffer)}`;
  const targetPath = path.join(targetDirectory, filename);

  await fsp.writeFile(targetPath, buffer);

  return {
    secure_url: `${PUBLIC_PREFIX}${relativeFolder}/${filename}`,
    public_id: `${relativeFolder}/${filename}`,
    provider: 'local'
  };
};

/**
 * The stored-path equivalent of a Cloudinary public id: the uploads relative
 * path, with no leading slash, which is what identifies the asset for deletion.
 */
const extractPublicId = (imageUrl) => {
  if (typeof imageUrl !== 'string') return null;

  const trimmed = imageUrl.trim();
  if (!trimmed.startsWith(PUBLIC_PREFIX)) return null;

  const relative = trimmed.slice(PUBLIC_PREFIX.length);
  if (!relative) return null;

  return resolveInsideRoot(...relative.split('/').filter(Boolean)) ? relative : null;
};

/**
 * Best effort removal, matching the Cloudinary contract: it always resolves,
 * because the request that replaces a photo has already committed the row
 * pointing at the new URL and a failed unlink can only leave an orphan behind.
 */
const destroyImage = async (imageUrl) => {
  const targetPath = toLocalPath(imageUrl);

  if (!targetPath) return null;

  try {
    await fsp.unlink(targetPath);
    return { result: 'ok' };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[LOCAL_STORAGE] Unable to delete ${targetPath}: ${error.message}`);
    }
    return null;
  }
};

module.exports = {
  uploadImage,
  destroyImage,
  extractPublicId,
  toLocalPath,
  UPLOADS_ROOT,
  PUBLIC_PREFIX
};
