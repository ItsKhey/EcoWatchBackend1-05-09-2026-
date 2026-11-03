const test = require('node:test');
const assert = require('node:assert/strict');

const photoRepository = require('../src/modules/reports/reportPhotoRepository');
const { attachPhotoLists } = require('../src/modules/reports/reportController');

const url = (name) => `https://res.cloudinary.com/demo/image/upload/${name}.jpg`;

/**
 * Stubs the batched photo lookup so these cases assert the response-shaping
 * rules (cover-first ordering, legacy fallbacks, error tolerance) without
 * requiring a database or Cloudinary.
 */
const withStubbedPhotos = async (rowsOrError, run) => {
  const original = photoRepository.findPhotosByReportIds;
  photoRepository.findPhotosByReportIds = async () => {
    if (rowsOrError instanceof Error) throw rowsOrError;
    return rowsOrError;
  };
  try {
    await run();
  } finally {
    photoRepository.findPhotosByReportIds = original;
  }
};

const report = (reportId, imageUrl) => ({ reportId, imageUrl });

test('exposes every uploaded photo in upload order', async () => {
  const rows = [
    { report_id: 'REP-A', image_url: url('a1') },
    { report_id: 'REP-A', image_url: url('a2') },
    { report_id: 'REP-A', image_url: url('a3') },
  ];

  await withStubbedPhotos(rows, async () => {
    const [result] = await attachPhotoLists([report('REP-A', url('a1'))]);
    assert.deepEqual(result.photos, [url('a1'), url('a2'), url('a3')]);
  });
});

test('leads with the cover image and never duplicates it', async () => {
  const rows = [
    { report_id: 'REP-B', image_url: url('cover') },
    { report_id: 'REP-B', image_url: url('second') },
  ];

  await withStubbedPhotos(rows, async () => {
    const [result] = await attachPhotoLists([report('REP-B', url('cover'))]);
    assert.deepEqual(result.photos, [url('cover'), url('second')]);
  });
});

test('falls back to the cover image when no photo rows exist', async () => {
  // Reports created before per-photo records existed have only image_url.
  await withStubbedPhotos([], async () => {
    const [result] = await attachPhotoLists([report('REP-C', url('only-cover'))]);
    assert.deepEqual(result.photos, [url('only-cover')]);
  });
});

test('returns an empty list for a report with no image at all', async () => {
  await withStubbedPhotos([], async () => {
    const [result] = await attachPhotoLists([report('REP-D', null)]);
    assert.deepEqual(result.photos, []);
  });
});

test('groups photos per report across a mixed batch', async () => {
  const rows = [
    { report_id: 'REP-E', image_url: url('e1') },
    { report_id: 'REP-F', image_url: url('f1') },
    { report_id: 'REP-F', image_url: url('f2') },
  ];

  await withStubbedPhotos(rows, async () => {
    const results = await attachPhotoLists([
      report('REP-E', url('e1')),
      report('REP-F', url('f1')),
      report('REP-G', null),
    ]);
    assert.deepEqual(results.map((r) => r.photos), [
      [url('e1')],
      [url('f1'), url('f2')],
      [],
    ]);
  });
});

test('degrades to the cover image when the photo lookup fails', async () => {
  await withStubbedPhotos(new Error('connection terminated'), async () => {
    const [result] = await attachPhotoLists([report('REP-H', url('cover'))]);
    assert.deepEqual(result.photos, [url('cover')]);
  });
});

test('tolerates rows with a missing url', async () => {
  const rows = [
    { report_id: 'REP-I', image_url: null },
    { report_id: 'REP-I', image_url: url('i1') },
  ];

  await withStubbedPhotos(rows, async () => {
    const [result] = await attachPhotoLists([report('REP-I', url('i1'))]);
    assert.deepEqual(result.photos, [url('i1')]);
  });
});

test('batched lookup is skipped entirely for an empty report list', async () => {
  await withStubbedPhotos(new Error('should not be called'), async () => {
    assert.deepEqual(await attachPhotoLists([]), []);
  });
});
