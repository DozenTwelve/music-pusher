// Every sentence the tool shows, in Chinese and English. (What stands around
// the tool — the bar, the footer, the pages' own text — is written into the
// HTML files and site/.) The rules in shared/
// answer in codes; this is where a code becomes words. Each language is written
// on its own terms, not translated from the other.
//
// An entry is a string with {placeholders}, or a function of the values when
// the wording depends on them (English plurals, mostly).

import { LANGUAGES } from './language.js';

// In a headline, [[…]] marks a number with the word it counts ("3 albums",
// "10 首"): the page keeps what is inside on one line.
const count = (n, one, many) => (n === 1 ? one : many.replace('{n}', n));
const tracks = (n) => count(n, '1 track', '{n} tracks');

const en = {
  // In the empty sleeve where the tool does not run: on a phone, without scripts.
  phone: 'Open this page on a computer to fix an album. Firefox or Chrome.',
  noscript: 'The tool needs JavaScript. The rest of the page reads without it.',

  'arrive.title': 'Fix an album that Navidrome shows in pieces.',
  'arrive.in': 'Drop in the album’s folder or zip.',
  'arrive.fix': 'The tags and cover are fixed.',
  'arrive.out': 'It comes back as a zip Navidrome reads as one album.',
  'arrive.private': 'Nothing is uploaded.',
  'arrive.local': 'The files are read and rewritten on this computer.',
  'arrive.drop': 'Drop a folder or a zip here',
  'arrive.release': 'Let go',
  'arrive.folder': 'Choose a folder',
  'arrive.zip': 'Choose a zip',
  'arrive.formats': 'FLAC, MP3, M4A. Up to {album} an album.',

  'reading.title': 'Reading the album',
  'reading.start': 'Loading the tag reader',
  'reading.file': '{name}',
  'cleaning.title': 'Writing the fixes',
  'cleaning.file': '{name}',
  'cleaning.check': 'Checking the zip',
  'progress.label': 'Progress',

  'verdict.split': ({ albums }) => `Navidrome would show this as [[${albums} albums]].`,
  'verdict.causes': 'The tracks disagree on {list}.',
  'verdict.merged.no_album': 'These tracks have no album name. Navidrome would mix them with every other track that has none.',
  'verdict.merged.unknown_artist': 'These tracks have no artist. Navidrome would put them under “Unknown Artist” with everything else that has none.',
  'verdict.no_cover': ({ missing, tracks: total }) =>
    missing === total ? count(total, 'The track has no cover.', 'None of the [[{n} tracks]] has a cover.') : `${missing} of [[${total} tracks]] ${missing === 1 ? 'has' : 'have'} no cover.`,
  'verdict.tidy': ({ fixes }) => `One album already. ${count(fixes, 'One thing', '[[{n} things]]')} to fix.`,
  'verdict.stuck': 'One album, with problems that can’t be fixed here.',
  'verdict.fine': ({ tracks: n }) => `Nothing to fix. Navidrome will show [[1 album]], [[${tracks(n)}]].`,
  'verdict.unreadable': 'None of these files can be read.',

  'after.one': ({ tracks: n }) => `Navidrome will show [[1 album]], [[${tracks(n)}]].`,
  'after.split': ({ albums }) => `Still [[${albums} albums]].`,
  'after.causes': 'The tracks still disagree on {list}.',
  'after.merged.no_album': 'Still no album name. Navidrome would mix these tracks with every other track that has none.',
  'after.merged.unknown_artist': 'Still no artist. Navidrome would put these tracks under “Unknown Artist”.',
  'after.no_cover': ({ missing }) => `${count(missing, '[[1 track]] still has', '[[{n} tracks]] still have')} no cover.`,
  'after.proof': 'Checked by opening the finished zip and reading every track again.',

  'cause.album': 'the album name',
  'cause.album_artist': 'the album artist',
  'cause.release_date': 'the release date',
  'cause.album_version': 'the album version',
  'cause.musicbrainz_albumid': 'the MusicBrainz ID',

  comma: ', ',
  'shelf.before': 'In Navidrome now',
  'shelf.after': 'In Navidrome after the fix',
  'shelf.was': ({ n }) => `Before: ${count(n, '1 album', '{n} albums')}`,
  'shelf.more': ({ n }) => `and ${count(n, '1 more album', '{n} more albums')}`,
  'shelf.unknown_album': '[Unknown Album]',
  'shelf.unknown_artist': '[Unknown Artist]',
  'shelf.tracks': ({ n }) => tracks(n),
  'shelf.no_date': 'no release date',
  'shelf.no_version': 'no version',
  'shelf.unseen': 'spelled differently in a way you can’t see',
  'cover.alt': 'Album cover',
  'cover.none': 'No cover',
  'cover.add': 'Add a cover image',
  'cover.guess': 'Using {name}, the only image in the folder. If that is not the cover, switch this off.',

  'plan.title': 'Fixes',
  'plan.none': 'Everything is switched off.',
  'fix.album': 'One album name on every track',
  'fix.album.field': 'Album name',
  'fix.album.guess': 'No track has an album name. This one comes from the folder name; correct it if it is wrong.',
  'fix.album.empty': 'Type the album name. Without it this stays unfixed.',
  'fix.album.apart': 'If these really are different albums, fix them one at a time.',
  'fix.album_artist': 'One album artist on every track',
  'fix.album_artist.field': 'Album artist',
  'fix.album_artist.empty': 'Type the artist. A compilation is usually “Various Artists”.',
  'fix.found': ({ n }) => `Written ${n} ways:`,
  'fix.spacing': 'They differ only in spaces or characters you can’t see.',
  'fix.release_date': 'One release date on every track',
  'fix.release_date.field': 'Release date',
  'fix.date': 'One date on every track, so the album shows a year',
  'fix.date.field': 'Date',
  'fix.album_version': 'One album version on every track',
  'fix.album_version.field': 'Album version',
  'fix.album_version.none': 'No version',
  'fix.mbid': ({ ids, count: n, total }) =>
    ids === 1
      ? `Copy the MusicBrainz ID to the ${count(total - n, 'one track', '{n} tracks')} without one`
      : `${ids} different MusicBrainz IDs. Use the one on ${n} of ${total} tracks for all`,
  'fix.track_numbers': ({ count: n, example }) => `Write complete track numbers on ${tracks(n)} (as ${example}, counted per disc)`,
  'fix.track_numbers.discs': 'No track says which disc it is on, so each folder is taken as one disc, in folder order ({n} discs). The disc number is written too.',
  'fix.text': ({ count: n }) => `Repair damaged text, and strip stray spaces and invisible characters (${count(n, 'one place', '{n} places')})`,
  'fix.filenames': ({ n }) => `Repair ${count(n, 'one file name', '{n} file names')}`,
  'fix.becomes': '“{from}” becomes “{to}”',
  'fix.cover_embed': ({ missing, total }) => `Put the cover in the tracks without one (${missing} of ${total}). Other pictures stay.`,
  'fix.cover_file': 'Add cover.jpg to the folder. Navidrome looks there first.',

  'cannot.title': 'Can’t be fixed here',
  'cannot.unreadable': ({ n }) =>
    count(n, 'One file can’t be read, probably damaged or cut short. It goes into the zip unchanged.', '{n} files can’t be read, probably damaged or cut short. They go into the zip unchanged.'),
  numbers: ({ list }) => new Intl.ListFormat('en', { type: 'disjunction' }).format(list.map(String)),
  'cannot.gaps': 'Tracks are missing: no track {list}.',
  'cannot.gaps.disc': 'Tracks are missing: disc {disc} has no track {list}.',
  'cannot.duplicate_numbers': 'Several tracks share a number. If this is a multi-disc set, the files don’t say which disc each track is on.',
  'cannot.no_track_number': ({ n }) => `${count(n, 'One track has', '{n} tracks have')} no number, and the file ${n === 1 ? 'name doesn’t' : 'names don’t'} give one.`,
  'cannot.mixed_formats': '{list} files in one album. Navidrome may split it.',
  'cannot.mixed_quality': 'The tracks differ in quality ({list}). Navidrome may split the album.',
  'cannot.no_duration': ({ n }) => `${count(n, 'One FLAC file doesn’t', '{n} FLAC files don’t')} record ${n === 1 ? 'its' : 'their'} length, so players can’t show it.`,
  'cannot.unclear_text': ({ n }) => `${count(n, 'One track has', '{n} tracks have')} damaged text with no safe repair.`,
  'cannot.no_title': ({ n }) => `${count(n, 'One track has', '{n} tracks have')} no title.`,
  'cannot.no_artist': ({ n }) => `${count(n, 'One track has', '{n} tracks have')} no artist.`,
  'cannot.unsupported': ({ n }) =>
    count(n, 'One audio file is in a format that isn’t read here. It goes into the zip unchanged.', '{n} audio files are in a format that isn’t read here. They go into the zip unchanged.'),
  'cannot.names': ({ n }) => `and ${n} more`,
  'encoding.guessed': 'The file names in this zip are in an old encoding, read here as {encoding}. If “{sample}” looks like nonsense, choose another album: the result would have broken names.',
  'encoding.unknown': 'The file names in this zip are in an encoding that can’t be worked out. They may come out wrong.',
  'encoding.tossup': 'The file names in this zip are in an old encoding, and more than one fits. Read as {encoding}, one is “{sample}”. If that looks like nonsense, choose the reading that looks right:',

  'action.clean': 'Fix the album',
  'action.another': 'Choose another album',
  'action.download': 'Download the zip',
  'action.again': 'Fix another album',
  'done.next': 'Replace the old folder with what is in the zip, then rescan in Navidrome.',
  'done.changed': ({ n }) => (n === 0 ? 'No track needed rewriting.' : `${count(n, 'One track', '{n} tracks')} rewritten. Everything else is in the zip untouched.`),
  'done.failed': ({ n }) => `${count(n, 'One track', '{n} tracks')} could not be rewritten and ${n === 1 ? 'is' : 'are'} in the zip unchanged.`,

  'error.no_audio': 'No FLAC, MP3 or M4A files in there.',
  'error.track_too_big': '“{name}” is {size}. The limit is {limit} a track.',
  'error.album_too_big': 'This album is {size}. The limit is {limit}.',
  'error.zip_bad': 'That zip won’t open. It may be damaged, password-protected, or over 4 GB.',
  'error.load_failed': 'The tag reader didn’t load. Check the connection and reload.',
  'error.bad_image': 'That image can’t be read. Try a JPEG or a PNG.',
  'error.unexpected': 'That failed: {message}'
};

const zh = {
  phone: '修专辑要在电脑上打开这个页面，用 Firefox 或 Chrome。',
  noscript: '修专辑要开着 JavaScript，页面上其余的内容不开也能看。',

  'arrive.title': '修好被 Navidrome 拆散的专辑。',
  'arrive.in': '把专辑的文件夹或 zip 拖进来。',
  'arrive.fix': '标签和封面会修好。',
  'arrive.out': '打包成 zip 还给你，Navidrome 会把它认成一张专辑。',
  'arrive.private': '不上传任何文件。',
  'arrive.local': '读取和修改都在这台电脑上完成。',
  'arrive.drop': '把文件夹或 zip 拖到这里',
  'arrive.release': '松手',
  'arrive.folder': '选文件夹',
  'arrive.zip': '选 zip',
  'arrive.formats': 'FLAC、MP3、M4A，每张专辑最大 {album}。',

  'reading.title': '正在读取专辑',
  'reading.start': '正在加载标签工具',
  'reading.file': '{name}',
  'cleaning.title': '正在写入修改',
  'cleaning.file': '{name}',
  'cleaning.check': '正在核对 zip',
  'progress.label': '进度',

  'verdict.split': 'Navidrome 会把它显示成 [[{albums} 张专辑]]。',
  'verdict.causes': '各首歌的{list}不一致。',
  'verdict.merged.no_album': '这些歌没有专辑名，Navidrome 会把它们和别的没有专辑名的歌混在一起。',
  'verdict.merged.unknown_artist': '这些歌没写艺人，Navidrome 会把它们和别的没写艺人的歌一起放到“未知艺人”下面。',
  'verdict.no_cover': ({ missing, tracks: total }) => (missing === total ? `[[${total} 首歌]]都没有封面。` : `[[${total} 首歌]]里有 [[${missing} 首]]没有封面。`),
  'verdict.tidy': '已经是一张专辑，还有 [[{fixes} 处]]可以修。',
  'verdict.stuck': '已经是一张专辑，但有这里修不了的问题。',
  'verdict.fine': '不用修。Navidrome 会显示 [[1 张专辑]]，[[共 {tracks} 首]]。',
  'verdict.unreadable': '这些文件都读不出来。',

  'after.one': 'Navidrome 会显示 [[1 张专辑]]，[[共 {tracks} 首]]。',
  'after.split': '还是 [[{albums} 张专辑]]。',
  'after.causes': '各首歌的{list}仍然不一致。',
  'after.merged.no_album': '还是没有专辑名，Navidrome 仍会把这些歌和别的没有专辑名的歌混在一起。',
  'after.merged.unknown_artist': '还是没写艺人，Navidrome 仍会把这些歌放到“未知艺人”下面。',
  'after.no_cover': '还有 [[{missing} 首歌]]没有封面。',
  'after.proof': '核对过了：重新打开这个 zip，把每首歌又读了一遍。',

  'cause.album': '专辑名',
  'cause.album_artist': '专辑艺人',
  'cause.release_date': '发行日期',
  'cause.album_version': '专辑版本',
  'cause.musicbrainz_albumid': 'MusicBrainz 编号',

  comma: '，',
  'shelf.before': '现在在 Navidrome 里',
  'shelf.after': '修好之后在 Navidrome 里',
  'shelf.was': '修之前：{n} 张专辑',
  'shelf.more': '还有 {n} 张',
  'shelf.unknown_album': '[未知专辑]',
  'shelf.unknown_artist': '[未知艺人]',
  'shelf.tracks': '{n} 首',
  'shelf.no_date': '没有发行日期',
  'shelf.no_version': '没写版本',
  'shelf.unseen': '写法有肉眼看不出的差别',
  'cover.alt': '专辑封面',
  'cover.none': '没有封面',
  'cover.add': '添加封面图片',
  'cover.guess': '用的是文件夹里唯一的图片 {name}。如果它不是封面，就把这一项关掉。',

  'plan.title': '要修的地方',
  'plan.none': '全都关掉了。',
  'fix.album': '所有歌曲用同一个专辑名',
  'fix.album.field': '专辑名',
  'fix.album.guess': '歌曲里都没有专辑名，这个是从文件夹名来的，不对就改一下。',
  'fix.album.empty': '填上专辑名，不填这一项就修不了。',
  'fix.album.apart': '如果这本来就是几张不同的专辑，一张一张分开修。',
  'fix.album_artist': '所有歌曲用同一个专辑艺人',
  'fix.album_artist.field': '专辑艺人',
  'fix.album_artist.empty': '填上艺人。合辑一般写“Various Artists”。',
  'fix.found': '现在有 {n} 种写法：',
  'fix.spacing': '只差在空格或看不见的字符上。',
  'fix.release_date': '所有歌曲用同一个发行日期',
  'fix.release_date.field': '发行日期',
  'fix.date': '所有歌曲用同一个日期，专辑才显示得出年份',
  'fix.date.field': '日期',
  'fix.album_version': '所有歌曲用同一个专辑版本',
  'fix.album_version.field': '专辑版本',
  'fix.album_version.none': '不写版本',
  'fix.mbid': ({ ids, count: n, total }) =>
    ids === 1 ? `给 ${total - n} 首没有 MusicBrainz 编号的歌补上` : `有 ${ids} 个不同的 MusicBrainz 编号，统一用 ${total} 首里 ${n} 首在用的那个`,
  'fix.track_numbers': '把 {count} 首歌的音轨号补完整（写成 {example}，每张碟分开计数）',
  'fix.track_numbers.discs': '歌曲里没写是第几张碟，所以一个文件夹算一张碟，按文件夹顺序排（共 {n} 张），碟号也一起写上。',
  'fix.text': '修好损坏的文字，去掉多余空格和看不见的字符（{count} 处）',
  'fix.filenames': '修好 {n} 个文件名',
  'fix.becomes': '“{from}”改成“{to}”',
  'fix.cover_embed': '把封面写进没有封面的歌（{total} 首里有 {missing} 首），其他图片保留。',
  'fix.cover_file': '在文件夹里放一个 cover.jpg，Navidrome 最先找它。',

  'cannot.title': '这里修不了的',
  'cannot.unreadable': '{n} 个文件读不出来，多半是损坏或没下完，会原样放进 zip。',
  numbers: ({ list }) => list.join('、'),
  'cannot.gaps': '缺歌：没有第 {list} 首。',
  'cannot.gaps.disc': '缺歌：第 {disc} 张碟没有第 {list} 首。',
  'cannot.duplicate_numbers': '有几首歌音轨号相同。如果是多碟专辑，文件里没写每首歌在第几张碟。',
  'cannot.no_track_number': '{n} 首歌没有音轨号，文件名里也看不出来。',
  'cannot.mixed_formats': '一张专辑里有 {list} 几种格式，Navidrome 可能会把它拆开。',
  'cannot.mixed_quality': '各首歌的音质规格不一样（{list}），Navidrome 可能会把专辑拆开。',
  'cannot.no_duration': '{n} 个 FLAC 文件没有记录时长，播放器显示不出来。',
  'cannot.unclear_text': '{n} 首歌里有损坏的文字，没法可靠地修。',
  'cannot.no_title': '{n} 首歌没有标题。',
  'cannot.no_artist': '{n} 首歌没写艺人。',
  'cannot.unsupported': '{n} 个音频文件的格式这里读不了，会原样放进 zip。',
  'cannot.names': '等 {n} 个',
  'encoding.guessed': '这个 zip 的文件名是旧编码，这里按 {encoding} 读。如果“{sample}”是乱码，就换一张专辑：修出来的文件名也会是乱的。',
  'encoding.unknown': '这个 zip 的文件名编码认不出来，修出来的文件名可能是乱的。',
  'encoding.tossup': '这个 zip 的文件名是旧编码，而且不止一种读得通。按 {encoding} 读，其中一个是“{sample}”。如果这是乱码，就选看起来对的那种读法：',

  'action.clean': '修好这张专辑',
  'action.another': '换一张专辑',
  'action.download': '下载 zip',
  'action.again': '再修一张',
  'done.next': '用 zip 里的文件夹替换原来的，再让 Navidrome 重新扫描。',
  'done.changed': ({ n }) => (n === 0 ? '没有需要改写的歌。' : `改写了 ${n} 首歌，其余文件原样放进了 zip。`),
  'done.failed': '{n} 首歌没能改写，原样放进了 zip。',

  'error.no_audio': '里面没有 FLAC、MP3 或 M4A 文件。',
  'error.track_too_big': '“{name}”有 {size}，单个文件上限是 {limit}。',
  'error.album_too_big': '这张专辑有 {size}，上限是 {limit}。',
  'error.zip_bad': '这个 zip 打不开，可能已损坏、加了密码，或超过 4 GB。',
  'error.load_failed': '标签工具没加载出来，检查网络后刷新。',
  'error.bad_image': '这张图片读不出来，换一张 JPEG 或 PNG。',
  'error.unexpected': '失败了：{message}'
};

const STRINGS = { en, zh };

// t(key, values) for one language, plus the helpers that need its conventions.
export function translator(code) {
  const strings = STRINGS[code] || en;
  const { tag } = LANGUAGES.find((language) => language.code === code) || LANGUAGES[0];
  const t = (key, values = {}) => {
    const entry = strings[key] ?? en[key] ?? key;
    return typeof entry === 'function' ? entry(values) : entry.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
  };
  // "A, B and C" / "A、B和C"
  t.list = (items) => new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }).format(items);
  // "1.2 GB", with a space that will not break before the unit.
  t.size = (bytes) => {
    const [value, unit] = bytes >= 1e9 ? [bytes / 1e9, 'GB'] : [bytes / 1e6, 'MB'];
    return `${new Intl.NumberFormat(tag, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${unit}`;
  };
  return t;
}
