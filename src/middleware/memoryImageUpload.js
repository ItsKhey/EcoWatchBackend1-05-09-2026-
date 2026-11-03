const multer = require('multer');

/**
 * Shared multipart middleware for the single-image uploads that must keep the
 * storage provider (local disk or Cloudinary) a service-layer choice.
 *
 * The bytes are held in memory instead of written to disk by multer, so the
 * controller hands the same buffer to `uploadImage` that a Cloudinary or local
 * upload would receive. Every route using this accepts the part under the
 * `image` field name, matching the report, evidence, and profile photo
 * contracts the Android apps already send.
 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const uploadMemoryImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!allowedImageTypes.has(String(file.mimetype).toLowerCase())) {
      const error = new Error('Only JPEG, PNG, and WebP images are allowed');
      error.code = 'INVALID_FILE_TYPE';
      return cb(error);
    }
    return cb(null, true);
  },
}).single('image');

module.exports = uploadMemoryImage;
