import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chooseNameEncoding, decodeName, rawName } from './zipnames.js';

// Real bytes, written by Python's codecs (`'…'.encode('cp437').hex(' ')`).
const hex = (text) => Uint8Array.from(text.split(' '), (byte) => parseInt(byte, 16));
const FIXTURES = {
  // macOS Archive Utility: UTF-8 without the flag.
  'utf-8': ['空洞です/01 曲.flac', 'e7 a9 ba e6 b4 9e e3 81 a7 e3 81 99 2f 30 31 20 e6 9b b2 2e 66 6c 61 63'],
  // Windows Explorer, US and western Europe.
  cp437: ['Björk - Homogenic/01 Jóga.flac', '42 6a 94 72 6b 20 2d 20 48 6f 6d 6f 67 65 6e 69 63 2f 30 31 20 4a a2 67 61 2e 66 6c 61 63'],
  cp850: ['João Gilberto/Chega de Saudade.flac', '4a 6f c6 6f 20 47 69 6c 62 65 72 74 6f 2f 43 68 65 67 61 20 64 65 20 53 61 75 64 61 64 65 2e 66 6c 61 63'],
  // Windows Explorer, Chinese (mainland, Taiwan) and Japanese.
  gbk: ['周杰伦 - 叶惠美/03 晴天.flac', 'd6 dc bd dc c2 d7 20 2d 20 d2 b6 bb dd c3 c0 2f 30 33 20 c7 e7 cc ec 2e 66 6c 61 63'],
  big5: ['五月天 - 後青春期的詩/突然好想你.m4a', 'a4 ad a4 eb a4 d1 20 2d 20 ab e1 ab 43 ac 4b b4 c1 aa ba b8 d6 2f ac f0 b5 4d a6 6e b7 51 a7 41 2e 6d 34 61'],
  shift_jis: ['ゆらゆら帝国 - 空洞です/07 空洞です.flac', '82 e4 82 e7 82 e4 82 e7 92 e9 8d 91 20 2d 20 8b f3 93 b4 82 c5 82 b7 2f 30 37 20 8b f3 93 b4 82 c5 82 b7 2e 66 6c 61 63']
};

test('zip names: each code page read from its real bytes, the only reading that fits', () => {
  for (const [encoding, [name, bytes]] of Object.entries(FIXTURES)) {
    const choice = chooseNameEncoding([hex(bytes)]);
    assert.equal(choice.encoding, encoding, name);
    assert.deepEqual(choice.alternatives, [], name);
    assert.equal(decodeName(encoding, hex(bytes)), name);
  }
});

test('zip names: the western names a CJK guess used to take', () => {
  // Each was read as Shift_JIS or GBK ('Bj攔k', 'Ja'), or kept as Latin-1 with
  // a C1 control in it ('Beyonc\x82').
  const western = [
    ['Mötley Crüe/01 Kickstart.mp3', '4d 94 74 6c 65 79 20 43 72 81 65 2f 30 31 20 4b 69 63 6b 73 74 61 72 74 2e 6d 70 33'],
    ['Beyoncé/01 Halo.mp3', '42 65 79 6f 6e 63 82 2f 30 31 20 48 61 6c 6f 2e 6d 70 33'],
    FIXTURES.cp437
  ];
  for (const [name, bytes] of western) {
    const choice = chooseNameEncoding([hex(bytes)]);
    assert.equal(decodeName(choice.encoding, hex(bytes)), name);
    assert.deepEqual(choice.alternatives, []);
  }
  // CP850 reads them the same; where the two differ, the letters win.
  assert.equal(decodeName('cp850', hex(FIXTURES.cp437[1])), FIXTURES.cp437[0]);
  assert.equal(decodeName('cp437', hex(FIXTURES.cp850[1])), 'Jo╞o Gilberto/Chega de Saudade.flac');
});

// TextEncoder only writes UTF-8, so the corpora's legacy bytes come from
// iconv, in the code pages Windows itself uses.
const encoded = (text, codepage) => new Uint8Array(execFileSync('iconv', ['-f', 'UTF-8', '-t', codepage], { input: text }));

const CORPORA = {
  gbk: ['CP936', [
    '周杰伦 - 叶惠美/01 以父之名.flac', '周杰伦 - 叶惠美/02 懦夫.flac', '王菲/红豆.mp3', '陈奕迅 - 十年.mp3',
    '邓丽君/月亮代表我的心.flac', '五月天 - 后青春期的诗/突然好想你.m4a', '张学友 - 吻别.flac', '孙燕姿/遇见.flac',
    '万能青年旅店/杀死那个石家庄人.flac', '草东没有派对 - 丑奴儿/山海.flac', '窦唯 - 黑梦/高级动物.flac', '封面.jpg',
    '崔健 - 新长征路上的摇滚/一无所有.flac', '告五人/爱人错过.m4a', '歌词/专辑介绍.txt', 'Beyond - 海阔天空.flac',
    '王菲 - Faye Wong/01 梦中人.flac', '【Live】周深 - 大鱼.flac', '01. 夜曲（Live）.flac', '刺猬/火车.mp3'
  ]],
  big5: ['CP950', [
    '周杰倫 - 葉惠美/01 以父之名.flac', '五月天 - 後青春期的詩/突然好想你.m4a', '蔡依林/日不落.mp3', '張惠妹 - 聽海.flac',
    '陳綺貞/旅行的意義.flac', '告五人/愛人錯過.m4a', '草東沒有派對 - 醜奴兒/山海.flac', '盧廣仲/魚仔.mp3',
    '落日飛車/我是一隻魚.flac', '伍佰 - 挪威的森林.flac', '張懸/寶貝.mp3', '鄧麗君/月亮代表我的心.flac',
    '羅大佑/童年.flac', '封面.jpg', '歌詞/專輯介紹.txt', '王菲 - Faye Wong/01 夢中人.flac', '張國榮/風繼續吹.flac',
    '任賢齊/心太軟.mp3', '莫文蔚 - 陰天.flac', '【Live】蕭敬騰 - 王妃.flac'
  ]],
  shift_jis: ['CP932', [
    'ゆらゆら帝国 - 空洞です/01 おはようまだやろう.flac', '椎名林檎/無罪モラトリアム/丸の内サディスティック.flac',
    '宇多田ヒカル - First Love.mp3', 'フィッシュマンズ/空中キャンプ/ナイトクルージング.flac', '山下達郎 - RIDE ON TIME.m4a',
    '坂本龍一/千のナイフ.flac', 'はっぴいえんど - 風をあつめて.mp3', 'ジャケット.jpg', '歌詞カード.txt',
    '相対性理論 - シフォン主義/LOVEずっきゅん.flac', 'Mr.Children - 名もなき詩.mp3', '米津玄師/Lemon.flac',
    'King Gnu - 白日.flac', 'RADWIMPS/前前前世.mp3', '中森明菜 - 少女A.flac', '【初回盤】ＢＥＳＴ.flac'
  ]],
  cp437: ['CP437', [
    'Björk - Homogenic/02 Hunter.flac', 'Sigur Rós/01 Glósóli.mp3', 'Café Tacvba/01 Eres.mp3', 'Motörhead - Ace of Spades.flac',
    'Ñu - Fuego.mp3', 'Hüsker Dü - Zen Arcade/01 Something I Learned Today.flac', 'Françoise Hardy/Tous les garçons.flac',
    'Édith Piaf - La vie en rose.flac', 'Die Ärzte/Schrei nach Liebe.mp3', 'Molotov - ¿Dónde Jugarán las Niñas?/Gimme.flac',
    'Amon Düül II/Yeti.flac', 'Jürgen Drews/Ein Bett im Kornfeld.mp3', 'Mylène Farmer/Désenchantée.flac'
  ]],
  cp850: ['CP850', [
    'João Gilberto/Chega de Saudade.flac', 'Caetano Veloso - Transa/Você não me ensina a bailar.flac',
    'Ólafur Arnalds/Þú ert jörðin.flac', 'Sigur Rós - Ágætis byrjun/Starálfur.flac', 'Gal Costa - Índia.flac', 'Céu - Vagarosa.flac'
  ]],
  'utf-8': ['UTF-8', ['Björk/01 Jóga.flac', '周杰伦/晴天.flac', '空洞です/01 曲.flac', 'Кино/Группа крови.mp3', '周杰倫 - 葉惠美/晴天.flac']]
};

test('zip names: a whole album is read right, with no second guess', () => {
  for (const [encoding, [codepage, names]] of Object.entries(CORPORA)) {
    const bytes = names.map((name) => encoded(name, codepage));
    const choice = chooseNameEncoding(bytes);
    assert.equal(choice.encoding, encoding);
    assert.deepEqual(choice.alternatives, [], encoding);
    assert.deepEqual(bytes.map((name) => decodeName(encoding, name)), names);
  }
  // Japanese written by Chinese Windows: GBK has the kana.
  const japanese = CORPORA.shift_jis[1].filter((name) => !/[ＢＥＳＴ]/.test(name));
  const choice = chooseNameEncoding(japanese.map((name) => encoded(name, 'CP936')));
  assert.equal(choice.encoding, 'gbk');
  assert.deepEqual(choice.alternatives, []);
});

// One name alone has less to go on. A wrong reading must never be a quiet one:
// either the guess is right, or the right encoding is offered beside it. The
// toss-ups are pinned, so a better guess has to say so here.
test('zip names: one name at a time, never wrong without saying so', () => {
  const tossUps = [];
  for (const [encoding, [codepage, names]] of Object.entries(CORPORA)) {
    for (const name of names) {
      const choice = chooseNameEncoding([encoded(name, codepage)]);
      const right = choice.encoding === encoding || decodeName(choice.encoding, encoded(name, codepage)) === name;
      assert.ok(right || choice.alternatives.includes(encoding), `${name}: ${choice.encoding}`);
      if (choice.alternatives.length > 0) {
        tossUps.push(`${name}: ${right ? 'right' : 'wrong'}, ${choice.encoding} or ${choice.alternatives.join(', ')}`);
      }
    }
  }
  assert.deepEqual(tossUps, [
    '歌詞/專輯介紹.txt: wrong, gbk or big5',
    '任賢齊/心太軟.mp3: wrong, gbk or big5',
    '莫文蔚 - 陰天.flac: wrong, gbk or big5',
    'RADWIMPS/前前前世.mp3: right, shift_jis or cp437, cp850',
    'Ñu - Fuego.mp3: right, cp437 or big5',
    'Amon Düül II/Yeti.flac: right, cp437 or shift_jis'
  ]);
});

test('zip names: the sample is the name in doubt', () => {
  // Nothing to guess: plain ASCII, or valid UTF-8.
  assert.deepEqual(chooseNameEncoding([hex('41 2f 31 2e 66 6c 61 63')]), { encoding: 'utf-8', sample: null, alternatives: [] });
  assert.equal(chooseNameEncoding([hex(FIXTURES['utf-8'][1])]).sample, null);
  // A guess with no rival points at a name that needed it, not an ASCII one.
  const ascii = hex('48 6f 6d 6f 67 65 6e 69 63 2f 63 6f 76 65 72 2e 6a 70 67');
  assert.equal(chooseNameEncoding([ascii, hex(FIXTURES.cp437[1])]).sample, 1);
  // A toss-up points at a name the readings disagree on.
  const doubtful = encoded('Amon Düül II/Yeti.flac', 'CP437');
  const choice = chooseNameEncoding([hex('63 6f 76 65 72 2e 6a 70 67'), doubtful]);
  assert.deepEqual(choice, { encoding: 'cp437', sample: 1, alternatives: ['shift_jis'] });
  assert.equal(decodeName('shift_jis', doubtful), 'Amon D＝l II/Yeti.flac');
});

test('zip names: when nothing fits, the raw name shows what it cannot read', () => {
  // A control byte is in no name, whatever the code page.
  const bytes = hex('41 01 82 2e 6d 70 33');
  assert.deepEqual(chooseNameEncoding([bytes]), { encoding: null, sample: null, alternatives: [] });
  assert.equal(rawName(bytes), 'A\u2401\u00e9.mp3');
  assert.doesNotMatch(rawName(bytes), /[\x00-\x1f\x7f-\x9f]/);
});

test('zip names: an album folder is one piece of evidence, however many tracks it holds', () => {
  const one = chooseNameEncoding([encoded('莫文蔚 - 陰天/01.mp3', 'CP950')]);
  const many = chooseNameEncoding(['01', '02', '03', '04'].map((n) => encoded(`莫文蔚 - 陰天/${n}.mp3`, 'CP950')));
  assert.deepEqual(many.alternatives, one.alternatives);
  assert.ok(many.alternatives.includes('big5') || many.encoding === 'big5');
});

test('zip names: valid UTF-8 is never dropped quietly', () => {
  // '÷/01 Eraser.mp3' from a Mac: GBK reads the first two bytes as 梅.
  const bytes = hex('c3 b7 2f 30 31 20 45 72 61 73 65 72 2e 6d 70 33');
  const choice = chooseNameEncoding([bytes]);
  assert.equal(choice.encoding, 'utf-8');
  assert.equal(decodeName('utf-8', bytes), '÷/01 Eraser.mp3');
  assert.equal(decodeName('gbk', bytes), '梅/01 Eraser.mp3');
});

test('zip names: controls are refused in plain ASCII too, and never shown', () => {
  assert.equal(chooseNameEncoding([hex('41 01 2e 6d 70 33')]).encoding, null);
  assert.equal(chooseNameEncoding([hex('41 00 2e 6d 70 33')]).encoding, null);
  // U+0085 (C2 85) is valid UTF-8 and still a control; byte for byte it is not.
  assert.equal(rawName(hex('41 01 c2 85 7f 2e 6d 70 33')), 'A\u2401\u252c\u00e0\u2421.mp3');
});

test('zip names: a leading U+FEFF is kept, not taken for a byte order mark', () => {
  assert.equal(decodeName('utf-8', hex('ef bb bf 54 2e 66 6c 61 63')), '\u{feff}T.flac');
});
