const localImageStorage = require('./localImageStorage');
const streamifier = require('streamifier');

/**
 * Image storage with two interchangeable providers.
 *
 *   IMAGE_STORAGE_PROVIDER=local      (default) writes into ./uploads and is
 *                                      served by this Node server
 *   IMAGE_STORAGE_PROVIDER=cloudinary uploads to the Cloudinary CDN
 *
 * Everything above this module keeps the same three functions and the same
 * response shape, so a controller never learns which provider is active.
 *
 * `uploadImage` follows the configured provider, but `destroyImage` and
 * `extractPublicId` dispatch on the shape of the stored URL instead. That is
 * deliberate: a database that was migrated from the hosted setup still holds
 * rows pointing at Cloudinary, and a resident editing one of those reports must
 * be able to delete the old asset instead of silently leaking it.
 */

const PROVIDER = String(process.env.IMAGE_STORAGE_PROVIDER || 'local').toLowerCase();

// Required on demand rather than at module load, so a local run never needs
// Cloudinary credentials in the environment.
let cloudinary = null;
const getCloudinary = () => {
  if (!cloudinary) {
    cloudinary = require('../config/cloudinary');
  }
  return cloudinary;
};

const isCloudinaryProvider = PROVIDER === 'cloudinary';
const isLocalProvider = PROVIDER === 'local';

if (!isCloudinaryProvider && !isLocalProvider) {
  throw new Error(
    `[STORAGE] IMAGE_STORAGE_PROVIDER must be "local" or "cloudinary", got "${PROVIDER}".`
  );
}

const isCloudinaryUrl = (imageUrl) =>
  typeof imageUrl === 'string' && imageUrl.includes('/image/upload/');

const isLocalUrl = (imageUrl) =>
  typeof imageUrl === 'string' &&
  imageUrl.trim().startsWith(localImageStorage.PUBLIC_PREFIX);

const uploadImage = (buffer, folder = 'ecowatch/reports') => {
  if (isLocalProvider) {
    return localImageStorage.uploadImage(buffer, folder);
  }

  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      reject(new Error('Image data is empty'));
      return;
    }

    const uploadStream = getCloudinary().uploader.upload_stream(
      {
        folder: folder,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

const UPLOAD_PATH_MARKER = '/image/upload/';

/**
 * Derives the Cloudinary public ID from a delivery URL so a replaced asset can
 * be removed instead of accumulating as an orphan.
 *
 *   .../image/upload/v1712345678/ecowatch/reports/abc123.jpg
 *     -> ecowatch/reports/abc123
 *
 * Returns null for anything that is not a Cloudinary image delivery URL, which
 * keeps the caller from ever handing a foreign string to the uploader.
 */
const extractCloudinaryPublicId = (imageUrl) => {
  if (typeof imageUrl !== 'string') return null;

  const trimmed = imageUrl.trim();
  if (!trimmed) return null;

  const markerIndex = trimmed.indexOf(UPLOAD_PATH_MARKER);
  if (markerIndex === -1) return null;

  const path = trimmed.slice(markerIndex + UPLOAD_PATH_MARKER.length);
  // Drop the asset version segment Cloudinary appends to delivery URLs.
  const withoutVersion = path.replace(/^v\d+\//, '');
  // Drop only a trailing file extension so dots inside the folder survive.
  const publicId = withoutVersion.replace(/\.[a-z0-9]+$/i, '').replace(/\/+$/, '');

  return publicId || null;
};

const extractPublicId = (imageUrl) => {
  if (isCloudinaryUrl(imageUrl)) {
    return extractCloudinaryPublicId(imageUrl);
  }

  if (isLocalUrl(imageUrl)) {
    return localImageStorage.extractPublicId(imageUrl);
  }

  return null;
};

const destroyCloudinaryImage = (imageUrl) => {
  const publicId = extractCloudinaryPublicId(imageUrl);
  if (!publicId) return Promise.resolve(null);

  return new Promise((resolve) => {
    getCloudinary()
      .uploader.destroy(publicId, { resource_type: 'image', invalidate: true })
      .then(resolve)
      .catch((error) => {
        console.warn(`[CLOUDINARY] Unable to destroy ${publicId}: ${error.message}`);
        resolve(null);
      });
  });
};

/**
 * Best-effort removal of a previously stored report photo.
 *
 * Always resolves: the calling request has already committed the report row
 * that points at the replacement URL, so a destroy failure can only leave an
 * orphaned asset behind and must never fail the resident's edit.
 */
const destroyImage = (imageUrl) => {
  if (isCloudinaryUrl(imageUrl)) {
    return destroyCloudinaryImage(imageUrl);
  }

  return localImageStorage.destroyImage(imageUrl);
};

module.exports = {
  uploadImage,
  destroyImage,
  extractPublicId,
  // Exposed for the local provider's own tests and for tooling that needs to
  // confirm which backend is active.
  provider: PROVIDER
};
