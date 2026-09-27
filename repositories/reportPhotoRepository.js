const { pool } = require('../config/db');

/**
 * Creates a photo record for a report.
 */
async function createPhoto(reportId, imageUrl, orderIndex, queryable = pool) {
  const result = await queryable.query(
    `
    INSERT INTO report_photos (report_id, image_url, order_index)
    VALUES ($1, $2, $3)
    RETURNING *
    `,
    [reportId, imageUrl, orderIndex]
  );

  return result.rows[0];
}

/**
 * Creates multiple photos for a report in order.
 */
async function createPhotos(reportId, imageUrls, queryable = pool) {
  const photos = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const photo = await createPhoto(reportId, imageUrl[i], i, queryable);
    photos.push(photo);
  }
  return photos;
}

/**
 * Retrieves all photos for a report, ordered by upload order.
 */
async function findPhotosByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT photo_id, report_id, image_url, order_index, uploaded_at
    FROM report_photos
    WHERE report_id = $1
    ORDER BY order_index ASC
    `,
    [reportId]
  );

  return result.rows;
}

/**
 * Retrieves the first (preview) photo for a report.
 */
async function findPreviewPhotoByReportId(reportId, queryable = pool) {
  const result = await queryable.query(
    `
    SELECT image_url
    FROM report_photos
    WHERE report_id = $1
    ORDER BY order_index ASC
    LIMIT 1
    `,
    [reportId]
  );

  return result.rows[0]?.image_url || null;
}

module.exports = {
  createPhoto,
  createPhotos,
  findPhotosByReportId,
  findPreviewPhotoByReportId,
};
