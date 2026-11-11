// Test data: what a real Navidrome did with these albums. A throwaway Navidrome
// 0.63.2 (default configuration) scanned every case in GROUND_TRUTH; `albums` is
// how many albums it made of the case's tracks. The reader tests build the same
// files with ffmpeg — each entry is a path inside the case's folder and the
// `-metadata` pairs it was written with — and hold the diagnosis to that count.
// shared/identity.test.js states the same cases as plain track records.
//
// Each case uses its own album name, as the scan did, so that no two cases
// could merge with each other.

const NBSP = ' ';
const CURLY_APOSTROPHE = '’';
const E_ACUTE_NFC = 'Café';
const E_ACUTE_NFD = 'Café';

// Two tracks in one container. `common` goes on both; `first` and `second` are
// what each adds. m4a and mp3 take ffmpeg's generic keys, FLAC the Vorbis names.
function pair(ext, common, first = {}, second = {}) {
  const vorbis = ext === 'flac';
  const numbered = (n, title) =>
    vorbis ? { TITLE: title, TRACKNUMBER: String(n) } : { title, track: String(n) };
  return [
    [`1.${ext}`, { ...common, ...numbered(1, 'one'), ...first }],
    [`2.${ext}`, { ...common, ...numbered(2, 'two'), ...second }]
  ];
}
const generic = (album) => ({ album, album_artist: 'AA', artist: 'AA' });
const vorbis = (ALBUM) => ({ ALBUM, ALBUMARTIST: 'AA', ARTIST: 'AA' });

export const GROUND_TRUTH = [
  {
    id: 'T01',
    differs: 'm4a ©day 2020-01-01 vs 2021-02-02',
    albums: 2,
    files: pair('m4a', generic('T01 m4a day differs'), { date: '2020-01-01' }, { date: '2021-02-02' })
  },
  {
    id: 'T02',
    differs: 'm4a, same ©day',
    albums: 1,
    files: pair('m4a', { ...generic('T02 m4a day same'), date: '2020-01-01' })
  },
  {
    id: 'T03',
    differs: 'FLAC DATE (album date shows blank)',
    albums: 1,
    files: pair('flac', vorbis('T03 flac DATE differs'), { DATE: '2020-01-01' }, { DATE: '2021-02-02' })
  },
  {
    id: 'T04',
    differs: 'FLAC YEAR',
    albums: 2,
    files: pair('flac', vorbis('T04 flac YEAR differs'), { YEAR: '2020' }, { YEAR: '2021' })
  },
  {
    id: 'T05',
    differs: 'MP3 date (album date shows blank)',
    albums: 1,
    files: pair('mp3', generic('T05 mp3 date differs'), { date: '2020-01-01' }, { date: '2021-02-02' })
  },
  {
    id: 'T06',
    differs: 'no album artist; artist Solo06 vs Solo06 feat. Guest06',
    albums: 1,
    albumArtist: 'Solo06',
    files: pair('flac', { ALBUM: 'T06 no albumartist feat' }, { ARTIST: 'Solo06' }, { ARTIST: 'Solo06 feat. Guest06' })
  },
  {
    id: 'T07',
    differs: 'no album artist; artist Alpha07 vs Beta07',
    albums: 2,
    files: pair('flac', { ALBUM: 'T07 no albumartist two artists' }, { ARTIST: 'Alpha07' }, { ARTIST: 'Beta07' })
  },
  {
    id: 'T08',
    differs: 'as T07, plus COMPILATION=1',
    albums: 1,
    albumArtist: 'Various Artists',
    files: pair('flac', { ALBUM: 'T08 compilation flag', COMPILATION: '1' }, { ARTIST: 'Alpha08' }, { ARTIST: 'Beta08' })
  },
  {
    id: 'T09',
    differs: 'album and album artist in letter case only',
    albums: 1,
    files: pair(
      'flac',
      { ARTIST: 'AA' },
      { ALBUM: 'T09 Case Differs', ALBUMARTIST: 'AA' },
      { ALBUM: 't09 case differs', ALBUMARTIST: 'aa' }
    )
  },
  {
    id: 'T10',
    differs: 'album has a space vs an NBSP',
    albums: 2,
    files: pair('flac', vorbis(''), { ALBUM: 'T10 nbsp' }, { ALBUM: `T10${NBSP}nbsp` })
  },
  {
    id: 'T11',
    differs: 'nothing; identical tags in two folders',
    albums: 1,
    files: [
      ['folderA/1.flac', { ...vorbis('T11 two folders'), TITLE: 'one', TRACKNUMBER: '1' }],
      ['folderB/1.flac', { ...vorbis('T11 two folders'), TITLE: 'other', TRACKNUMBER: '1' }]
    ]
  },
  {
    id: 'T12',
    differs: 'MUSICBRAINZ_ALBUMID on one track only',
    albums: 2,
    files: pair('flac', vorbis('T12 mbid on one track'), {
      MUSICBRAINZ_ALBUMID: '11111111-2222-4333-8444-555555555555'
    })
  },
  {
    id: 'T13',
    differs: 'album and album artist, under one MUSICBRAINZ_ALBUMID',
    albums: 1,
    files: pair(
      'flac',
      { MUSICBRAINZ_ALBUMID: 'aaaaaaaa-2222-4333-8444-555555555555' },
      { ALBUM: 'T13 same mbid', ALBUMARTIST: 'AA', ARTIST: 'AA' },
      { ALBUM: 'T13 other name entirely', ALBUMARTIST: 'ZZ', ARTIST: 'ZZ' }
    )
  },
  {
    id: 'T14',
    differs: "album artist on one track only, equal to the other track's artist",
    albums: 1,
    files: pair('flac', { ALBUM: 'T14 albumartist on one, same name', ARTIST: 'Solo14' }, { ALBUMARTIST: 'Solo14' })
  },
  {
    id: 'T15',
    differs: "album artist on one track only, different from the other track's artist",
    albums: 2,
    files: pair('flac', { ALBUM: 'T15 albumartist on one, other name', ARTIST: 'Singer15' }, { ALBUMARTIST: 'Band15' })
  },
  {
    id: 'T16',
    differs: 'm4a ©day 2020 vs 2020-05-01',
    albums: 2,
    files: pair('m4a', generic('T16 m4a year vs full date'), { date: '2020' }, { date: '2020-05-01' })
  },
  {
    id: 'T17',
    differs: "album Don't vs Don’t (curly apostrophe)",
    albums: 1,
    files: pair('flac', vorbis(''), { ALBUM: "T17 Don't" }, { ALBUM: `T17 Don${CURLY_APOSTROPHE}t` })
  },
  {
    id: 'T18',
    differs: 'ALBUMVERSION on one track only',
    albums: 2,
    files: pair('flac', vorbis('T18 albumversion differs'), { ALBUMVERSION: 'Deluxe' })
  },
  {
    id: 'T19',
    differs: 'FLAC RELEASEDATE',
    albums: 2,
    files: pair(
      'flac',
      vorbis('T19 flac RELEASEDATE differs'),
      { RELEASEDATE: '2020-01-01' },
      { RELEASEDATE: '2021-02-02' }
    )
  },
  {
    id: 'T20',
    differs: 'album in NFC vs NFD',
    albums: 2,
    files: pair('flac', vorbis(''), { ALBUM: `T20 ${E_ACUTE_NFC}` }, { ALBUM: `T20 ${E_ACUTE_NFD}` })
  },
  {
    id: 'T21',
    differs: 'album with vs without a trailing space',
    albums: 2,
    files: pair('flac', vorbis(''), { ALBUM: 'T21 trailing space' }, { ALBUM: 'T21 trailing space ' })
  },
  {
    id: 'T22',
    differs: 'nothing; no album tag, two folders, same artist ("[Unknown Album]")',
    albums: 1,
    files: [
      ['1.flac', { ALBUMARTIST: 'AA', ARTIST: 'AA', TITLE: 'one', TRACKNUMBER: '1' }],
      ['other/1.flac', { ALBUMARTIST: 'AA', ARTIST: 'AA', TITLE: 'unrelated', TRACKNUMBER: '1' }]
    ]
  }
];

// Cases no Navidrome scanned: what the rule says, for the places where a reader
// is known to struggle. `knownGaps` names a reader that cannot get the case
// right, the count it reports instead, and why — so the gap is pinned rather
// than silently tolerated, and closing it fails the test that marks it.
export const BY_RULE = [
  {
    id: 'R01',
    differs: 'MP3 TDRL (the ID3 release date)',
    albums: 2,
    files: pair('mp3', generic('R01 mp3 TDRL differs'), { TDRL: '2020-01-01' }, { TDRL: '2021-02-02' }),
    knownGaps: {
      server: {
        groupCount: 1,
        why: 'ffprobe reports TDRL and TDRC under the one key `date`, so the server reads an ID3 release date as a recording date'
      }
    }
  },
  {
    id: 'R02',
    differs: 'no album artist; one ARTISTS comment "Nujabes; Shing02" vs ARTISTS=Nujabes',
    albums: 2,
    files: pair(
      'flac',
      { ALBUM: 'R02 typed semicolon in ARTISTS', ARTIST: 'Nujabes' },
      { ARTISTS: 'Nujabes; Shing02' },
      { ARTISTS: 'Nujabes' }
    )
  },
  {
    id: 'R03',
    differs: 'no album artist; one ARTISTS comment "A;B" vs ARTISTS=A',
    albums: 2,
    files: pair('flac', { ALBUM: 'R03 bare semicolon in ARTISTS', ARTIST: 'A' }, { ARTISTS: 'A;B' }, { ARTISTS: 'A' }),
    knownGaps: {
      server: {
        groupCount: 1,
        why: 'ffprobe joins repeated comments with ";", so the server cannot tell one value "A;B" from the two values A and B and reads the first artist as A'
      }
    }
  }
];
