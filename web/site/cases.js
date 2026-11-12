// The guide's tables: every case of shared/navidrome.groundtruth.js, put into
// words. The ground truth holds the files and the number of albums Navidrome
// made of them; this holds only how a case is described to a reader, and which
// table it is shown in. The counts are never written here — the table takes
// them from the ground truth, so the page cannot say something the scan did not.
//
// A description is HTML. `note` is what else the scan showed about the case.

export const GROUPS = {
  date: ['T01', 'T16', 'T02', 'T19', 'T04', 'R01', 'T03', 'T05'],
  artist: ['T07', 'T08', 'T06', 'T14', 'T15'],
  name: ['T09', 'T17', 'T10', 'T21', 'T20'],
  mbid: ['T12', 'T13'],
  version: ['T18'],
  folders: ['T11', 'T22'],
  artists: ['R02', 'R03']
};

export const CASES = {
  T01: {
    en: 'M4A: the date (<code>©day</code>) is <code>2020-01-01</code> on one track and <code>2021-02-02</code> on the other',
    zh: 'M4A：日期（<code>©day</code>）一首是 <code>2020-01-01</code>，另一首是 <code>2021-02-02</code>'
  },
  T16: {
    en: 'M4A: the date (<code>©day</code>) is <code>2020</code> on one track and <code>2020-05-01</code> on the other',
    zh: 'M4A：日期（<code>©day</code>）一首只写了 <code>2020</code>，另一首写的是 <code>2020-05-01</code>'
  },
  T02: {
    en: 'M4A: the same date (<code>©day</code>) on both tracks',
    zh: 'M4A：两首的日期（<code>©day</code>）相同'
  },
  T19: {
    en: 'FLAC: <code>RELEASEDATE</code> differs',
    zh: 'FLAC：<code>RELEASEDATE</code> 不同'
  },
  T04: {
    en: 'FLAC: <code>YEAR</code> differs',
    zh: 'FLAC：<code>YEAR</code> 不同'
  },
  R01: {
    en: 'MP3: <code>TDRL</code>, the ID3 release date, differs',
    zh: 'MP3：<code>TDRL</code>（ID3 的发行日期）不同'
  },
  T03: {
    en: 'FLAC: <code>DATE</code> differs',
    zh: 'FLAC：<code>DATE</code> 不同',
    note: { en: 'the album’s date shows blank', zh: '专辑的日期显示为空' }
  },
  T05: {
    en: 'MP3: the date (<code>TDRC</code>) differs',
    zh: 'MP3：日期（<code>TDRC</code>）不同',
    note: { en: 'the album’s date shows blank', zh: '专辑的日期显示为空' }
  },
  T07: {
    en: 'No album artist on either track; the artist is <code>Alpha</code> on one and <code>Beta</code> on the other',
    zh: '两首都没有专辑艺人；艺人一首是 <code>Alpha</code>，另一首是 <code>Beta</code>'
  },
  T08: {
    en: 'The same two tracks, with the compilation flag set on both (<code>COMPILATION=1</code>)',
    zh: '同样的两首歌，都加上合辑标记（<code>COMPILATION=1</code>）',
    note: { en: 'filed under “Various Artists”', zh: '归在“Various Artists”名下' }
  },
  T06: {
    en: 'No album artist on either track; the artist is <code>Solo</code> on one and <code>Solo feat. Guest</code> on the other',
    zh: '两首都没有专辑艺人；艺人一首是 <code>Solo</code>，另一首是 <code>Solo feat. Guest</code>',
    note: { en: 'filed under Solo', zh: '归在 Solo 名下' }
  },
  T14: {
    en: 'Album artist on one track only, the same name as the other track’s artist',
    zh: '只有一首写了专辑艺人，而且和另一首的艺人同名'
  },
  T15: {
    en: 'Album artist on one track only, a different name from the other track’s artist',
    zh: '只有一首写了专辑艺人，而且和另一首的艺人不同名'
  },
  T09: {
    en: 'Album and album artist differ in letter case only',
    zh: '专辑名和专辑艺人只差在字母大小写上'
  },
  T17: {
    en: 'Album name with a straight apostrophe (<code>Don\'t</code>) on one track and a curly one (<code>Don’t</code>) on the other',
    zh: '专辑名里的撇号一首是直的（<code>Don\'t</code>），另一首是弯的（<code>Don’t</code>）'
  },
  T10: {
    en: 'Album name with a space on one track and a non-breaking space on the other',
    zh: '专辑名里一首是普通空格，另一首是不换行空格（NBSP）'
  },
  T21: {
    en: 'Album name with a trailing space on one track',
    zh: '其中一首的专辑名末尾多了一个空格'
  },
  T20: {
    en: 'Album name with an <code>é</code> stored as one character on one track (NFC) and as <code>e</code> plus an accent on the other (NFD)',
    zh: '专辑名里的 <code>é</code>，一首存成一个字符（NFC），另一首存成 <code>e</code> 加重音符（NFD）'
  },
  T12: {
    en: '<code>MUSICBRAINZ_ALBUMID</code> on one track only',
    zh: '只有一首带 <code>MUSICBRAINZ_ALBUMID</code>'
  },
  T13: {
    en: 'Different album names and different album artists, the same <code>MUSICBRAINZ_ALBUMID</code>',
    zh: '专辑名和专辑艺人都不一样，<code>MUSICBRAINZ_ALBUMID</code> 相同'
  },
  T18: {
    en: '<code>ALBUMVERSION</code> on one track only',
    zh: '只有一首带 <code>ALBUMVERSION</code>'
  },
  T11: {
    en: 'Nothing in the tags; the two tracks sit in two different folders',
    zh: '标签完全一样，两首歌放在两个不同的文件夹里'
  },
  T22: {
    en: 'Two unrelated tracks in two folders, neither with an album tag, both by the same artist',
    zh: '两个文件夹里两首不相干的歌，都没有专辑名，艺人相同',
    note: { en: 'both under “[Unknown Album]”', zh: '都进了“[Unknown Album]”' }
  },
  R02: {
    en: 'No album artist; <code>ARTISTS</code> is the single value <code>Nujabes; Shing02</code> on one track and <code>Nujabes</code> on the other',
    zh: '都没有专辑艺人；<code>ARTISTS</code> 一首是单独一个值 <code>Nujabes; Shing02</code>，另一首是 <code>Nujabes</code>'
  },
  R03: {
    en: 'No album artist; <code>ARTISTS</code> is the single value <code>A;B</code> on one track and <code>A</code> on the other',
    zh: '都没有专辑艺人；<code>ARTISTS</code> 一首是单独一个值 <code>A;B</code>，另一首是 <code>A</code>'
  }
};
