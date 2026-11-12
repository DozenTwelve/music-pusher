import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { searchReleases } from './musicbrainz.js';

// Characterization of searchReleases() with the network cut out: `fetch` is
// replaced by a stub that records the request and answers with a response
// MusicBrainz really gave (musicbrainz.recorded.json — the reply to
// release:"In Rainbows" AND artist:"Radiohead", limit 8). Everything the caller
// can observe is pinned: the query string sent, and the whole result object.

const recorded = JSON.parse(
  await fsp.readFile(new URL('./musicbrainz.recorded.json', import.meta.url), 'utf8')
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Answer every request with `respond()` and keep what was asked.
function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return respond();
  };
  return calls;
}

const answer = (body, status = 200) => () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const QUERY_TABLE = [
  [
    { artist: 'Radiohead', album: 'In Rainbows', tracks: 10 },
    'release:"In Rainbows" AND artist:"Radiohead" AND tracks:10'
  ],
  // No artist, or an empty one: the term is left out, not sent blank.
  [{ album: 'In Rainbows', tracks: 10 }, 'release:"In Rainbows" AND tracks:10'],
  [{ artist: '', album: 'In Rainbows', tracks: 10 }, 'release:"In Rainbows" AND tracks:10'],
  [{ artist: null, album: 'In Rainbows' }, 'release:"In Rainbows"'],
  // The track count is only sent when it is a positive integer.
  [{ artist: 'Radiohead', album: 'In Rainbows' }, 'release:"In Rainbows" AND artist:"Radiohead"'],
  [{ artist: 'Radiohead', album: 'In Rainbows', tracks: 0 }, 'release:"In Rainbows" AND artist:"Radiohead"'],
  [{ artist: 'Radiohead', album: 'In Rainbows', tracks: -3 }, 'release:"In Rainbows" AND artist:"Radiohead"'],
  [{ artist: 'Radiohead', album: 'In Rainbows', tracks: 2.5 }, 'release:"In Rainbows" AND artist:"Radiohead"'],
  [{ artist: 'Radiohead', album: 'In Rainbows', tracks: '10' }, 'release:"In Rainbows" AND artist:"Radiohead"'],
  [{ artist: 'Radiohead', album: 'In Rainbows', tracks: null }, 'release:"In Rainbows" AND artist:"Radiohead"'],
  // Lucene metacharacters are escaped inside the quoted phrase.
  [
    { artist: 'AC/DC', album: 'Who Made Who? (Deluxe) [Explicit]: Vol. 1/2' },
    'release:"Who Made Who\\? \\(Deluxe\\) \\[Explicit\\]\\: Vol. 1\\/2" AND artist:"AC\\/DC"'
  ],
  [
    { artist: 'a+b-c&d|e!f', album: '{x}^"y"~*\\' },
    'release:"\\{x\\}\\^\\"y\\"\\~\\*\\\\" AND artist:"a\\+b\\-c\\&d\\|e\\!f"'
  ],
  // Untouched: apostrophes, commas, dots, non-Latin text. No trimming either.
  [
    { artist: 'ゆらゆら帝国', album: "空洞です, It's Vol. 2" },
    'release:"空洞です, It\'s Vol. 2" AND artist:"ゆらゆら帝国"'
  ],
  [{ artist: ' Radiohead ', album: ' In Rainbows ' }, 'release:" In Rainbows " AND artist:" Radiohead "'],
  // Non-string names are stringified.
  [{ artist: 1975, album: 1989, tracks: 13 }, 'release:"1989" AND artist:"1975" AND tracks:13']
];

test('the MusicBrainz query string, for every shape of input', async () => {
  for (const [input, query] of QUERY_TABLE) {
    const calls = stubFetch(answer({ releases: [] }));

    const result = await searchReleases(input);

    assert.equal(calls.length, 1, JSON.stringify(input));
    const { url, options } = calls[0];
    assert.equal(url.origin + url.pathname, 'https://musicbrainz.org/ws/2/release');
    assert.deepEqual(
      [...url.searchParams.entries()],
      [
        ['query', query],
        ['fmt', 'json'],
        ['limit', '8']
      ],
      JSON.stringify(input)
    );
    assert.deepEqual(options.headers, { 'User-Agent': 'music-pusher/0.1 ( https://github.com/ )' });
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options).sort(), ['headers', 'signal']);

    // The query is echoed back exactly as it was passed in.
    assert.deepStrictEqual(result, {
      ok: true,
      query: { artist: input.artist, album: input.album, tracks: input.tracks },
      candidates: []
    });
  }
});

// The recorded releases, summarized, in the order MusicBrainz ranked them.
// `matchesTrackCount` is filled in per test.
const SUMMARIES = [
  {
    id: 'ea92a194-2d60-35c7-9d56-0e1dba20cd45',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2007-12-03',
    country: 'GB',
    trackCount: 28,
    disambiguation: 'discbox',
    format: '12" Vinyl + 12" Vinyl + CD + Enhanced CD',
    label: '_Xurbia_Xendless Limited, _Xurbia_Xendless Limited, _Xurbia_Xendless Limited',
    catalogNumber: '_X_X001, CDS_X_X001, CD_X_X001'
  },
  {
    id: 'cb05d8c5-f86f-4fe5-a7a0-37ac339a492d',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2009-06-09',
    country: 'XW',
    trackCount: 18,
    disambiguation: '',
    format: 'Digital Media + Digital Media',
    label: '',
    catalogNumber: ''
  },
  {
    id: 'cd061329-348f-46f7-b6c1-7460a88e5edb',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2008-01-01',
    country: 'US',
    trackCount: 10,
    disambiguation: 'united pressing',
    format: '12" Vinyl',
    label: 'RED Distribution, LLC, TBD Records',
    catalogNumber: '88088-21623-1, TBD0001'
  },
  {
    id: '3b408cb5-7d51-4188-b07c-fabcf308cda3',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2007-12-26',
    country: 'JP',
    trackCount: 10,
    disambiguation: '',
    format: 'CD',
    label: 'Hostess Entertainment Unlimited',
    catalogNumber: 'CD_X_X001J'
  },
  {
    id: '90cf3f7e-a93a-45e0-8391-8863635ae0d5',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2007',
    country: 'ID',
    trackCount: 10,
    disambiguation: '',
    format: 'Cassette',
    label: 'XL Recordings',
    catalogNumber: 'XLMC 324'
  },
  {
    id: 'a58f4eb2-9829-37d5-b46c-e8163038e0f5',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2007-12-31',
    country: 'GB',
    trackCount: 10,
    disambiguation: '',
    format: '12" Vinyl',
    label: 'XL Recordings',
    catalogNumber: 'XLLP324'
  },
  {
    id: '3e71085d-35ce-4e75-92bf-a5437f80a41f',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2008',
    country: 'US',
    trackCount: 18,
    disambiguation: '',
    format: 'CD-R',
    label: 'TBD Records',
    catalogNumber: '[none]'
  },
  {
    id: '68e18fe3-1c1c-406f-83b0-26ae08642f19',
    title: 'In Rainbows',
    artist: 'Radiohead',
    date: '2010-05-26',
    country: 'JP',
    trackCount: 18,
    disambiguation: '',
    format: 'CD + CD',
    label: 'Hostess Entertainment Unlimited',
    catalogNumber: 'CD_X_X001J'
  }
];

// Positions in SUMMARIES, in the order the result is expected to list them.
const candidatesInOrder = (order, matches) =>
  order.map((index) => ({ ...SUMMARIES[index], matchesTrackCount: matches(SUMMARIES[index]) }));

test('a recorded response, summarized: same track count first, MusicBrainz order within', async () => {
  stubFetch(answer(recorded));
  const query = { artist: 'Radiohead', album: 'In Rainbows', tracks: 10 };

  const result = await searchReleases(query);

  assert.deepStrictEqual(result, {
    ok: true,
    query,
    // The four 10-track editions jump the two that outranked them; neither
    // group is reordered inside itself.
    candidates: candidatesInOrder([2, 3, 4, 5, 0, 1, 6, 7], (c) => c.trackCount === 10)
  });
});

test('a recorded response with a track count nothing matches keeps MusicBrainz order', async () => {
  stubFetch(answer(recorded));
  const query = { artist: 'Radiohead', album: 'In Rainbows', tracks: 11 };

  const result = await searchReleases(query);

  assert.deepStrictEqual(result, {
    ok: true,
    query,
    candidates: candidatesInOrder([0, 1, 2, 3, 4, 5, 6, 7], () => false)
  });
});

test('a recorded response with no usable track count matches everything, in MusicBrainz order', async () => {
  for (const tracks of [undefined, null, 0, -1, 2.5, '10']) {
    stubFetch(answer(recorded));
    const query = { artist: 'Radiohead', album: 'In Rainbows', tracks };

    const result = await searchReleases(query);

    assert.deepStrictEqual(
      result,
      { ok: true, query, candidates: candidatesInOrder([0, 1, 2, 3, 4, 5, 6, 7], () => true) },
      `tracks=${JSON.stringify(tracks)}`
    );
  }
});

test('releases with fields missing are summarized to blanks, not thrown on', async () => {
  // Hand-built, unlike the recorded response: the shapes a sparse MusicBrainz
  // entry takes, which no single real reply happens to cover.
  const sparse = {
    releases: [
      { id: 'bare' },
      {
        id: 'credits',
        title: 'Split EP',
        // A credit's own `name` wins; the nested artist name is the fallback;
        // a credit with neither is dropped.
        'artist-credit': [{ name: 'As Credited', artist: { name: 'Canonical' } }, { artist: { name: 'Only Nested' } }, {}],
        media: [{ format: 'CD', 'track-count': 2 }, { 'track-count': 3 }, { format: 'DVD' }],
        'label-info': [{ label: { name: 'Label A' } }, { 'catalog-number': 'CAT-2' }, { label: null }, {}]
      },
      { id: 'not-arrays', media: 'CD', 'artist-credit': 'Someone', 'label-info': null }
    ]
  };
  stubFetch(answer(sparse));
  const query = { artist: 'x', album: 'y', tracks: 5 };

  const result = await searchReleases(query);

  const blank = {
    title: '',
    artist: '',
    date: '',
    country: '',
    trackCount: 0,
    disambiguation: '',
    format: '',
    label: '',
    catalogNumber: '',
    matchesTrackCount: false
  };
  assert.deepStrictEqual(result, {
    ok: true,
    query,
    candidates: [
      {
        ...blank,
        id: 'credits',
        title: 'Split EP',
        artist: 'As Credited, Only Nested',
        trackCount: 5,
        format: 'CD + DVD',
        label: 'Label A',
        catalogNumber: 'CAT-2',
        matchesTrackCount: true
      },
      { ...blank, id: 'bare' },
      { ...blank, id: 'not-arrays' }
    ]
  });
});

test('a body with no release list is an empty result', async () => {
  for (const body of [{}, { releases: null }, { releases: 'none' }]) {
    stubFetch(answer(body));
    const query = { artist: 'x', album: 'y', tracks: 1 };
    assert.deepStrictEqual(await searchReleases(query), { ok: true, query, candidates: [] });
  }
});

test('no album name is refused before anything is sent', async () => {
  for (const album of [undefined, null, '', '   ', 0]) {
    const calls = stubFetch(answer(recorded));

    const result = await searchReleases({ artist: 'Radiohead', album, tracks: 10 });

    assert.deepStrictEqual(result, {
      ok: false,
      code: 'no_album_name',
      message: 'Nothing to search on: the album has no album tag. Type the album name above.'
    });
    assert.equal(calls.length, 0);
  }
});

test('a failed request and a refused one are reported, each as what it was', async () => {
  globalThis.fetch = async () => {
    throw new Error('connect ETIMEDOUT');
  };
  assert.deepStrictEqual(await searchReleases({ artist: 'x', album: 'y' }), {
    ok: false,
    code: 'unreachable',
    message: 'Could not reach MusicBrainz: connect ETIMEDOUT'
  });

  stubFetch(answer({ error: 'rate limited' }, 503));
  assert.deepStrictEqual(await searchReleases({ artist: 'x', album: 'y' }), {
    ok: false,
    code: 'bad_response',
    message: 'MusicBrainz answered 503.'
  });
});

// A 200 is not a promise of a readable body. MusicBrainz behind its load
// balancer answers an HTML error page with 200 now and then, and the 20s timeout
// can fire after the headers but before the body is in — both used to reject
// out of searchReleases, which /releases did not catch, and an unhandled
// rejection takes the whole server down.
test('a 200 whose body is not JSON, or is cut off, is a bad response, not a throw', async () => {
  stubFetch(() => new Response('<html>Service temporarily unavailable</html>', { status: 200 }));
  const html = await searchReleases({ artist: 'x', album: 'y' });
  assert.equal(html.ok, false);
  assert.equal(html.code, 'bad_response');
  assert.match(html.message, /could not be read/);

  stubFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"releases":[{"id":'));
            controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          }
        }),
        { status: 200 }
      )
  );
  const cut = await searchReleases({ artist: 'x', album: 'y' });
  assert.equal(cut.ok, false);
  assert.equal(cut.code, 'bad_response');

  stubFetch(answer({ releases: [null] }));
  const junk = await searchReleases({ artist: 'x', album: 'y' });
  assert.equal(typeof junk.ok, 'boolean', 'a release list with junk in it is answered, not thrown');
});
