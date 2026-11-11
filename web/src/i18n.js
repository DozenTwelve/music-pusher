// Every sentence the page shows, in Chinese and English. The rules in shared/
// answer in codes; this is where a code becomes words. Each language is written
// on its own terms, not translated from the other.
//
// An entry is a string with {placeholders}, or a function of the values when
// the wording depends on them (English plurals, mostly).

const STORAGE_KEY = 'album-cleaner-language';

export const LANGUAGES = [
  { code: 'zh', tag: 'zh-Hans', label: '中文' },
  { code: 'en', tag: 'en', label: 'English' }
];

// The remembered choice, else the browser's language.
export function pickLanguage() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be switched off; the browser's language still decides.
  }
  if (LANGUAGES.some((language) => language.code === saved)) {
    return saved;
  }
  return (navigator.languages || [navigator.language]).some((tag) => /^zh\b/i.test(tag || '')) ? 'zh' : 'en';
}

export function saveLanguage(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Not remembered, then.
  }
}

const count = (n, one, many) => (n === 1 ? one : many.replace('{n}', n));
const tracks = (n) => count(n, '1 track', '{n} tracks');

const en = {
  app: 'Album Cleaner',
  description: 'Fix a downloaded album’s tags and cover in your browser, so Navidrome shows it as one album. Nothing is uploaded.',
  language: 'Language',
  phone: 'Open this page in a desktop browser. Firefox or Chrome is recommended.',

  'arrive.title': 'Stop Navidrome splitting your album.',
  'arrive.lede': 'Drop a downloaded album here. Its tags and cover get fixed, and you get back a zip that Navidrome files as one album.',
  'arrive.private': 'Your music never leaves this computer. Everything happens in this browser tab, and nothing is uploaded.',
  'arrive.drop': 'Drop an album folder or a zip here',
  'arrive.release': 'Let go to open it',
  'arrive.folder': 'Choose a folder',
  'arrive.zip': 'Choose a zip',
  'arrive.formats': 'FLAC, MP3 and M4A, up to {album} an album.',

  'reading.title': 'Reading the album',
  'reading.start': 'Getting ready',
  'reading.file': 'Reading {name}',
  'cleaning.title': 'Fixing the album',
  'cleaning.file': 'Writing {name}',
  'cleaning.check': 'Checking the finished zip',
  'progress.label': 'Progress',

  'verdict.split': ({ albums }) => `Navidrome would show this as ${albums} albums.`,
  'verdict.causes': 'The tracks disagree on {list}.',
  'verdict.merged.no_album': 'These tracks have no album name. Navidrome would lump them in with every other unnamed track.',
  'verdict.merged.unknown_artist': 'These tracks name no artist. Navidrome would file them under “Unknown Artist” with everything else that has none.',
  'verdict.no_cover': ({ missing, tracks: total }) =>
    missing === total ? count(total, 'The track has no cover.', 'None of the {n} tracks has a cover.') : `${missing} of ${total} tracks ${missing === 1 ? 'has' : 'have'} no cover.`,
  'verdict.tidy': 'One album, with a few things to tidy.',
  'verdict.stuck': 'One album, but with problems this page can’t fix.',
  'verdict.fine': ({ tracks: n }) => `Looks fine. Navidrome will show 1 album, ${tracks(n)}.`,
  'verdict.unreadable': 'None of these files can be read.',

  'after.one': ({ tracks: n }) => `Navidrome will show 1 album, ${tracks(n)}.`,
  'after.split': ({ albums }) => `Still ${albums} albums.`,
  'after.causes': 'The tracks still disagree on {list}.',
  'after.merged.no_album': 'Still no album name, so Navidrome would lump these tracks in with other unnamed ones.',
  'after.merged.unknown_artist': 'Still no artist, so Navidrome would file these tracks under “Unknown Artist”.',
  'after.no_cover': ({ missing }) => `${count(missing, '1 track still has', '{n} tracks still have')} no cover.`,
  'after.proof': 'This is what the finished zip says. It was opened and checked again after writing.',

  'cause.album': 'the album name',
  'cause.album_artist': 'the album artist',
  'cause.release_date': 'the release date',
  'cause.album_version': 'the album version',
  'cause.musicbrainz_albumid': 'the MusicBrainz album ID',

  'shelf.before': 'What Navidrome sees now',
  'shelf.after': 'What Navidrome will see',
  'shelf.unknown_album': '[Unknown Album]',
  'shelf.unknown_artist': '[Unknown Artist]',
  'shelf.tracks': ({ n }) => tracks(n),
  'shelf.no_date': 'no release date',
  'shelf.no_version': 'no version',
  'shelf.unseen': 'spelled differently in a way you can’t see',
  'cover.alt': 'Album cover',
  'cover.none': 'No cover',
  'cover.add': 'Add a cover image',
  'cover.guess': 'Using {name}, the only image in the folder. Check that it is the cover.',

  'plan.title': 'What will be changed',
  'plan.none': 'Everything is switched off, so there is nothing to do.',
  'fix.album': 'Give every track the same album name',
  'fix.album.field': 'Album name',
  'fix.album.guess': 'The files carry no album name. This one is guessed from the folder name, so check it.',
  'fix.album.empty': 'Type the album’s name. Without one, this can’t be fixed.',
  'fix.album.apart': 'If these are different albums, clean them one at a time instead.',
  'fix.album_artist': 'Give every track the same album artist',
  'fix.album_artist.field': 'Album artist',
  'fix.album_artist.empty': 'Type the artist. For a compilation, “Various Artists” is the usual choice.',
  'fix.found': ({ n }) => `Written ${n} ways now:`,
  'fix.spacing': 'The names differ only by spaces or characters you can’t see.',
  'fix.release_date': 'Give every track the same release date',
  'fix.release_date.field': 'Release date',
  'fix.date': 'Give every track the same date, so the album shows its year',
  'fix.date.field': 'Date',
  'fix.album_version': 'Give every track the same album version',
  'fix.album_version.field': 'Album version',
  'fix.album_version.none': 'No version',
  'fix.mbid': ({ ids, count: n, total }) =>
    ids === 1
      ? `Copy the MusicBrainz album ID to the ${count(total - n, 'one track', '{n} tracks')} without it`
      : `Tracks carry ${ids} different MusicBrainz album IDs. Use the most common one, found on ${n} of ${total} tracks, for all`,
  'fix.track_numbers': ({ count: n }) => `Renumber ${tracks(n)} in the form 3/12, counted per disc`,
  'fix.text': ({ count: n }) => `Repair damaged text and remove invisible characters and stray spaces, in ${count(n, 'one place', '{n} places')}`,
  'fix.filenames': ({ n }) => `Repair ${count(n, 'one file name', '{n} file names')}`,
  'fix.becomes': '“{from}” becomes “{to}”',
  'fix.cover_embed': ({ missing, total }) => `Put the cover into every track (${missing} of ${total} ${missing === 1 ? 'has' : 'have'} none)`,
  'fix.cover_file': 'Add cover.jpg to the album folder, the first place Navidrome looks',

  'cannot.title': 'What this page can’t fix',
  'cannot.unreadable': ({ n }) =>
    count(n, 'One file can’t be read. It may be damaged or incomplete, and goes into the zip as it is.', '{n} files can’t be read. They may be damaged or incomplete, and go into the zip as they are.'),
  numbers: ({ list }) => new Intl.ListFormat('en', { type: 'disjunction' }).format(list.map(String)),
  'cannot.gaps': 'Tracks seem to be missing: there is no track {list}.',
  'cannot.gaps.disc': 'Tracks seem to be missing: disc {disc} has no track {list}.',
  'cannot.duplicate_numbers': 'Several tracks share a track number. If this is more than one disc, the files don’t say which disc each track is on.',
  'cannot.no_track_number': ({ n }) => `${count(n, 'One track has', '{n} tracks have')} no track number, and the file ${n === 1 ? 'name doesn’t' : 'names don’t'} give one.`,
  'cannot.mixed_formats': 'The album mixes {list} files. Navidrome may split it.',
  'cannot.mixed_quality': 'The tracks differ in audio quality ({list}). Navidrome may split the album.',
  'cannot.no_duration': ({ n }) => `${count(n, 'One FLAC file doesn’t', '{n} FLAC files don’t')} record how long ${n === 1 ? 'it is' : 'they are'}, so players can’t show it.`,
  'cannot.unclear_text': ({ n }) => `${count(n, 'One track has', '{n} tracks have')} damaged text that can’t be repaired with confidence.`,
  'cannot.no_title': ({ n }) => `${count(n, 'One track has', '{n} tracks have')} no title.`,
  'cannot.no_artist': ({ n }) => `${count(n, 'One track names', '{n} tracks name')} no artist.`,
  'cannot.no_cover': 'There is no cover anywhere in this album. Add an image to give it one.',
  'cannot.unsupported': ({ n }) =>
    count(n, 'One audio file is in a format this page doesn’t read. It goes into the zip as it is.', '{n} audio files are in a format this page doesn’t read. They go into the zip as they are.'),
  'cannot.names': ({ n }) => `and ${n} more`,
  'encoding.guessed': 'This zip’s file names are in an older encoding, read here as {encoding}. If “{sample}” looks wrong, stop here.',
  'encoding.unknown': 'This zip’s file names are in an encoding this page can’t work out, so they may look wrong.',

  'action.clean': 'Fix the album',
  'action.another': 'Choose another album',
  'action.download': 'Download the zip',
  'action.again': 'Clean another album',
  'done.changed': ({ n }) => (n === 0 ? 'No track needed rewriting.' : `${count(n, 'One track was', '{n} tracks were')} rewritten. Everything else is in the zip untouched.`),
  'done.failed': ({ n }) => `${count(n, 'One track', '{n} tracks')} could not be rewritten and ${n === 1 ? 'is' : 'are'} in the zip as ${n === 1 ? 'it' : 'they'} came.`,

  'error.no_audio': 'No FLAC, MP3 or M4A files in there.',
  'error.track_too_big': '“{name}” is {size}. This page handles tracks up to {limit}.',
  'error.album_too_big': 'This album is {size}. This page handles albums up to {limit}.',
  'error.zip_bad': 'That zip can’t be opened. It may be damaged, password-protected, or larger than 4 GB.',
  'error.load_failed': 'The page didn’t finish loading. Check the connection and reload.',
  'error.bad_image': 'That image can’t be read. Try a JPEG or a PNG.',
  'error.unexpected': 'Something went wrong: {message}',

  'footer.taglib': 'Tags are read and written by TagLib, used under the LGPL.',
  'footer.notice': 'TagLib notice',
  'footer.lgpl': 'LGPL 2.1',
  'footer.all': 'All licences'
};

const zh = {
  app: '专辑整理',
  description: '在浏览器里修好下载专辑的标签和封面，让 Navidrome 把它显示成完整的一张。不上传任何文件。',
  language: '语言',
  phone: '请在电脑浏览器中打开，建议使用 Firefox 或 Chrome。',

  'arrive.title': '别再让 Navidrome 把专辑拆开',
  'arrive.lede': '把下载好的专辑拖进来，修好标签和封面，再打包成 zip。放进 Navidrome，就是完整的一张。',
  'arrive.private': '音乐不会离开你的电脑。所有处理都在这个页面里完成，不上传任何文件。',
  'arrive.drop': '把专辑文件夹或 zip 拖到这里',
  'arrive.release': '松开就开始读取',
  'arrive.folder': '选择文件夹',
  'arrive.zip': '选择 zip',
  'arrive.formats': '支持 FLAC、MP3、M4A，每张专辑最大 {album}。',

  'reading.title': '正在读取专辑',
  'reading.start': '正在准备',
  'reading.file': '正在读取 {name}',
  'cleaning.title': '正在修复专辑',
  'cleaning.file': '正在写入 {name}',
  'cleaning.check': '正在检查打包好的 zip',
  'progress.label': '进度',

  'verdict.split': 'Navidrome 会把它显示成 {albums} 张专辑。',
  'verdict.causes': '各首歌的{list}不一致。',
  'verdict.merged.no_album': '这些歌没有专辑名，Navidrome 会把它们和其他没有专辑名的歌混在一起。',
  'verdict.merged.unknown_artist': '这些歌没有写艺人，Navidrome 会把它们和其他没写艺人的歌一起归到“未知艺人”。',
  'verdict.no_cover': ({ missing, tracks: total }) => (missing === total ? `${total} 首歌都没有封面。` : `${total} 首歌里有 ${missing} 首没有封面。`),
  'verdict.tidy': '是完整的一张专辑，还有几处可以顺手修好。',
  'verdict.stuck': '是完整的一张专辑，但有这个页面修不了的问题。',
  'verdict.fine': '没有问题。Navidrome 会显示为 1 张专辑，共 {tracks} 首。',
  'verdict.unreadable': '这些文件都读不出来。',

  'after.one': 'Navidrome 会显示为 1 张专辑，共 {tracks} 首。',
  'after.split': '仍然会被拆成 {albums} 张专辑。',
  'after.causes': '各首歌的{list}还是不一致。',
  'after.merged.no_album': '还是没有专辑名，Navidrome 仍会把这些歌和其他没有专辑名的歌混在一起。',
  'after.merged.unknown_artist': '还是没有写艺人，Navidrome 仍会把这些歌归到“未知艺人”。',
  'after.no_cover': '还有 {missing} 首歌没有封面。',
  'after.proof': '这是重新打开打包好的 zip、再检查一遍得到的结果。',

  'cause.album': '专辑名',
  'cause.album_artist': '专辑艺人',
  'cause.release_date': '发行日期',
  'cause.album_version': '专辑版本',
  'cause.musicbrainz_albumid': 'MusicBrainz 专辑编号',

  'shelf.before': 'Navidrome 现在看到的',
  'shelf.after': '修好后 Navidrome 看到的',
  'shelf.unknown_album': '[未知专辑]',
  'shelf.unknown_artist': '[未知艺人]',
  'shelf.tracks': '{n} 首',
  'shelf.no_date': '没有发行日期',
  'shelf.no_version': '没写版本',
  'shelf.unseen': '写法有肉眼看不出的差别',
  'cover.alt': '专辑封面',
  'cover.none': '没有封面',
  'cover.add': '添加封面图片',
  'cover.guess': '用的是文件夹里唯一的图片 {name}，请确认它就是封面。',

  'plan.title': '将要修改的内容',
  'plan.none': '所有项目都关掉了，没有可做的事。',
  'fix.album': '把所有歌曲的专辑名统一',
  'fix.album.field': '专辑名',
  'fix.album.guess': '文件里没有专辑名，这是按文件夹名猜的，请核对。',
  'fix.album.empty': '请填写专辑名，不填就修不了。',
  'fix.album.apart': '如果它们其实是不同的专辑，请一张一张分开处理。',
  'fix.album_artist': '把所有歌曲的专辑艺人统一',
  'fix.album_artist.field': '专辑艺人',
  'fix.album_artist.empty': '请填写艺人。合辑一般写“Various Artists”。',
  'fix.found': '现在有 {n} 种写法：',
  'fix.spacing': '这些名字只差在空格或看不见的字符上。',
  'fix.release_date': '把所有歌曲的发行日期统一',
  'fix.release_date.field': '发行日期',
  'fix.date': '把所有歌曲的日期统一，专辑才能显示年份',
  'fix.date.field': '日期',
  'fix.album_version': '把所有歌曲的专辑版本统一',
  'fix.album_version.field': '专辑版本',
  'fix.album_version.none': '不写版本',
  'fix.mbid': ({ ids, count: n, total }) =>
    ids === 1
      ? `给 ${total - n} 首缺少 MusicBrainz 专辑编号的歌补上编号`
      : `各首歌带着 ${ids} 个不同的 MusicBrainz 专辑编号，统一成最常见的那个（${total} 首里有 ${n} 首在用）`,
  'fix.track_numbers': '把 {count} 首歌的音轨号写成 3/12 这样，每张碟单独计数',
  'fix.text': '修复损坏的文字，去掉看不见的字符和多余空格，共 {count} 处',
  'fix.filenames': '修复 {n} 个文件名',
  'fix.becomes': '“{from}”会改成“{to}”',
  'fix.cover_embed': '把封面写进每一首歌（{total} 首里有 {missing} 首没有）',
  'fix.cover_file': '在专辑文件夹里放一个 cover.jpg，Navidrome 会先找它',

  'cannot.title': '这个页面修不了的',
  'cannot.unreadable': '{n} 个文件读不出来，可能已损坏或没下载完整，会原样放进 zip。',
  numbers: ({ list }) => list.join('、'),
  'cannot.gaps': '可能缺歌：没有第 {list} 首。',
  'cannot.gaps.disc': '可能缺歌：第 {disc} 张碟没有第 {list} 首。',
  'cannot.duplicate_numbers': '有几首歌的音轨号重复。如果这是多张碟，说明文件里没有标明每首歌在哪张碟上。',
  'cannot.no_track_number': '{n} 首歌没有音轨号，从文件名里也看不出来。',
  'cannot.mixed_formats': '专辑里混着 {list} 几种格式，Navidrome 可能会把它拆开。',
  'cannot.mixed_quality': '各首歌的音质规格不一样（{list}），Navidrome 可能会把专辑拆开。',
  'cannot.no_duration': '{n} 个 FLAC 文件没有记录时长，播放器显示不出来。',
  'cannot.unclear_text': '{n} 首歌里有损坏的文字，没办法可靠地修复。',
  'cannot.no_title': '{n} 首歌没有标题。',
  'cannot.no_artist': '{n} 首歌没有写艺人。',
  'cannot.no_cover': '这张专辑里找不到封面。可以添加一张图片作为封面。',
  'cannot.unsupported': '{n} 个音频文件的格式这个页面不支持，会原样放进 zip。',
  'cannot.names': '等 {n} 个',
  'encoding.guessed': '这个 zip 里的文件名用的是旧编码，这里按 {encoding} 读取。如果“{sample}”是乱码，请不要继续。',
  'encoding.unknown': '这个 zip 里的文件名编码认不出来，名字可能显示成乱码。',

  'action.clean': '修复专辑',
  'action.another': '换一张专辑',
  'action.download': '下载 zip',
  'action.again': '再整理一张',
  'done.changed': ({ n }) => (n === 0 ? '没有需要改写的歌。' : `改写了 ${n} 首歌，其余文件原样放进了 zip。`),
  'done.failed': '{n} 首歌没能改写，原样放进了 zip。',

  'error.no_audio': '里面没有找到 FLAC、MP3 或 M4A 文件。',
  'error.track_too_big': '“{name}”有 {size}，这个页面最多能处理 {limit} 的单个文件。',
  'error.album_too_big': '这张专辑有 {size}，这个页面最多能处理 {limit}。',
  'error.zip_bad': '这个 zip 打不开，可能已损坏、加了密码，或者超过了 4 GB。',
  'error.load_failed': '页面没有加载完整，请检查网络后刷新。',
  'error.bad_image': '这张图片读不出来，换一张 JPEG 或 PNG 试试。',
  'error.unexpected': '出错了：{message}',

  'footer.taglib': '标签由 TagLib 读写，按 LGPL 许可使用。',
  'footer.notice': 'TagLib 声明',
  'footer.lgpl': 'LGPL 2.1',
  'footer.all': '全部许可'
};

const STRINGS = { en, zh };

// t(key, values) for one language, plus the helpers that need its conventions.
export function translator(code) {
  const strings = STRINGS[code] || en;
  const { tag } = LANGUAGES.find((language) => language.code === code) || LANGUAGES[1];
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
