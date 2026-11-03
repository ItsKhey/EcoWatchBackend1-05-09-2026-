const { pool } = require('../../config/db');

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
    const photo = await createPhoto(reportId, imageUrls[i], i, queryable);
    photos.push(photo);
  }
  return photos;
}

/**
 * Builds the photo list for a single report.
 *
 * <p>The cover image is the canonical first photo, so it always leads the list.
 * That keeps a single-photo report rendering identically and stops a re-uploaded
 * cover from appearing twice.
 */
function buildPhotoList(coverUrl, photoUrls) {
  const photos = [];
  const seen = new Set();

  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    photos.push(trimmed);
  };

  add(coverUrl);
  for (const url of photoUrls || []) add(url);

  return photos;
}

/**
 * Retrieves photos for many reports in one round trip, grouped by report id
 * and ordered by upload order within each report.
 *
 * <p>Used to build report listings without issuing one query per report.
 */
async function findPhotosByReportIds(reportIds, queryable = pool) {
  const ids = [...new Set((reportIds || []).filter(Boolean))];
  if (ids.length === 0) return [];

  const result = await queryable.query(
    `
    SELECT report_id, image_url, order_index
    FROM report_photos
    WHERE report_id = ANY($1::text[])
    ORDER BY report_id ASC, order_index ASC
    `,
    [ids]
  );

  return result.rows;
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
  findPhotosByReportIds,
  findPreviewPhotoByReportId,
  buildPhotoList,
};
