const reportPhotoRepository = require('../repositories/reportPhotoRepository');
const { logError } = require('../utils/logger');

/**
 * Loads the photo lists for a set of reports in one batched query.
 *
 * <p>Returns a Map of reportId -> ordered image URLs. Reading the per-photo rows
 * is best-effort: a failure degrades to an empty map so the caller falls back to
 * the cover image instead of failing the whole report listing.
 */
async function fetchPhotoMap(reportIds) {
  try {
    const rows = await reportPhotoRepository.findPhotosByReportIds(reportIds);
    return rows.reduce((grouped, row) => {
      if (!row || !row.report_id || !row.image_url) return grouped;
      const existing = grouped.get(row.report_id) || [];
      existing.push(row.image_url);
      grouped.set(row.report_id, existing);
      return grouped;
    }, new Map());
  } catch (error) {
    logError(null, 'REPORT_PHOTO', `Could not load report photos: ${error.message}`);
    return new Map();
  }
}

/**
 * Attaches a `photos` array to reports that expose `reportId` and `imageUrl`.
 *
 * <p>Mutates and returns the supplied reports so it can be chained onto an
 * existing mapping step.
 */
async function attachPhotoLists(reports) {
  const list = Array.isArray(reports) ? reports : [reports];
  const photosByReportId = await fetchPhotoMap(list.map((report) => report?.reportId));

  for (const report of list) {
    if (!report) continue;
    report.photos = reportPhotoRepository.buildPhotoList(
      report.imageUrl,
      photosByReportId.get(report.reportId)
    );
  }

  return Array.isArray(reports) ? reports : reports;
}

/**
 * Attaches `photos` to raw database rows, which are snake_case and unnormalised.
 *
 * <p>The admin report endpoints return raw rows rather than the resident-facing
 * normalized shape, so the column names differ.
 */
async function attachPhotosToRows(rows, options = {}) {
  const {
    idKey = 'report_id',
    coverKey = 'image_url',
  } = options;

  const list = Array.isArray(rows) ? rows : [rows];
  const photosByReportId = await fetchPhotoMap(list.map((row) => row?.[idKey]));

  for (const row of list) {
    if (!row) continue;
    row.photos = reportPhotoRepository.buildPhotoList(
      row[coverKey],
      photosByReportId.get(row[idKey])
    );
  }

  return Array.isArray(rows) ? rows : rows;
}

module.exports = {
  fetchPhotoMap,
  attachPhotoLists,
  attachPhotosToRows,
};
