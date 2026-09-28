const test = require('node:test');
const assert = require('node:assert/strict');

const reportPhotoRepository = require('../repositories/reportPhotoRepository');
const { buildPhotoList } = reportPhotoRepository;

const url = (name) => `https://res.cloudinary.com/demo/image/upload/${name}.jpg`;

/**
 * createPhotos is called from inside the report creation transaction with a
 * single-photo submit as the only allowed input size, so a reference slip in the
 * loop body only surfaces as a 500 ("imageUrl is not defined") to the resident
 * after their photos have already been uploaded. These cases drive the
 * repository directly with a stub queryable so the insert shape is pinned
 * without needing the database.
 */
const createStubQueryable = () => {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [{ report_id: params[0], image_url: params[1], order_index: params[2] }] };
    },
  };
};

test('createPhotos inserts one row per url, in the order supplied', async () => {
  const queryable = createStubQueryable();
  const urls = [
    'https://res.cloudinary.com/demo/image/upload/one.jpg',
    'https://res.cloudinary.com/demo/image/upload/two.jpg',
    'https://res.cloudinary.com/demo/image/upload/three.jpg',
  ];

  const photos = await reportPhotoRepository.createPhotos('REP-PHOTOS-1', urls, queryable);

  assert.equal(queryable.calls.length, 3);
  assert.deepEqual(
    queryable.calls.map((call) => call.params),
    [
      ['REP-PHOTOS-1', urls[0], 0],
      ['REP-PHOTOS-1', urls[1], 1],
      ['REP-PHOTOS-1', urls[2], 2],
    ]
  );
  assert.deepEqual(
    photos.map((photo) => photo.image_url),
    urls
  );
});

test('createPhotos preserves order_index for a single photo', async () => {
  const queryable = createStubQueryable();
  const url = 'https://res.cloudinary.com/demo/image/upload/solo.jpg';

  const photos = await reportPhotoRepository.createPhotos('REP-PHOTOS-2', [url], queryable);

  assert.equal(queryable.calls.length, 1);
  assert.deepEqual(queryable.calls[0].params, ['REP-PHOTOS-2', url, 0]);
  assert.deepEqual(photos, [{ report_id: 'REP-PHOTOS-2', image_url: url, order_index: 0 }]);
});

test('createPhotos writes no rows for an empty url list', async () => {
  const queryable = createStubQueryable();

  const photos = await reportPhotoRepository.createPhotos('REP-PHOTOS-3', [], queryable);

  assert.deepEqual(photos, []);
  assert.equal(queryable.calls.length, 0);
});

/**
 * buildPhotoList backs both the resident and the admin photo arrays, so the
 * cover-first ordering and the de-duplication rules have to hold for the admin
 * list too. The admin endpoints pass the raw image_url column as the cover.
 */
test('buildPhotoList leads with the cover image', () => {
  assert.deepEqual(
    buildPhotoList(url('cover'), [url('cover'), url('second'), url('third')]),
    [url('cover'), url('second'), url('third')]
  );
});

test('buildPhotoList keeps a cover that is missing from the photo rows', () => {
  // Reports uploaded before the per-photo rows existed only have a cover.
  assert.deepEqual(buildPhotoList(url('only-cover'), []), [url('only-cover')]);
  assert.deepEqual(buildPhotoList(url('only-cover'), null), [url('only-cover')]);
});

test('buildPhotoList is empty for a report with no image', () => {
  assert.deepEqual(buildPhotoList(null, []), []);
  assert.deepEqual(buildPhotoList(undefined, undefined), []);
  assert.deepEqual(buildPhotoList('', null), []);
});

test('buildPhotoList drops blanks, non-strings and repeats', () => {
  assert.deepEqual(
    buildPhotoList(url('a'), [url('a'), '', '   ', null, 42, url('b'), url('b')]),
    [url('a'), url('b')]
  );
});

test('buildPhotoList trims surrounding whitespace', () => {
  assert.deepEqual(buildPhotoList(`  ${url('a')}  `, [`\t${url('b')}\n`]), [
    url('a'),
    url('b'),
  ]);
});
