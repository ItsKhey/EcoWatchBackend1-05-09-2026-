const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

const uploadImage = (buffer, folder = 'ecowatch/reports') => {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      reject(new Error('Image data is empty'));
      return;
    }

    const uploadStream = cloudinary.uploader.upload_stream(
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
const extractPublicId = (imageUrl) => {
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

/**
 * Best-effort removal of a previously stored report photo.
 *
 * Always resolves: the calling request has already committed the report row
 * that points at the replacement URL, so a destroy failure can only leave an
 * orphaned asset behind and must never fail the resident's edit.
 */
const destroyImage = (imageUrl) => {
  const publicId = extractPublicId(imageUrl);
  if (!publicId) return Promise.resolve(null);

  return new Promise((resolve) => {
    cloudinary.uploader.destroy(
      publicId,
      { resource_type: 'image', invalidate: true },
      (error, result) => {
        if (error) {
          console.warn(
            `[CLOUDINARY] Unable to destroy ${publicId}: ${error.message}`
          );
          resolve(null);
          return;
        }
        resolve(result);
      }
    );
  });
};

module.exports = {
  uploadImage,
  destroyImage,
  extractPublicId,
};
