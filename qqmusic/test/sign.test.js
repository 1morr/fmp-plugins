// sign：向量由舊專案 qq_music_sign.dart 的 QQMusicSign.encrypt 產生（2026-10-21，dart run），
// 另以 node:crypto 獨立算 MD5 與 base64 對照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { base64, signOf } from '../src/sign.js';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

const VECTORS = {
  '': 'zzb98ffe087addcnuyjec90xpfdilcqea80d149dc',
  a: 'zzb970739762owlqnsfwosh2e5pthozwc11cc9b9',
  hello: 'zzbd4c1b979iwwqbnoib0krwpk3fitla7b14da20',
  abc: 'zzbf5ced317rcwa3p9x7htlssem5k4xda92100898',
  foo: 'zzb51cce64dejbin49hw5dwm5suaivm3ge2dbcbdc',
  bar: 'zzb61a25fdf45hnxynwscgiggjg2i59a555b791f',
  qq: 'zzbb3164ee83bzrqsl3kkpdlbweecgviqf4b99604',
  '中文 body': 'zzb3e44f22frshrcxgdoft0u1a2aqa22e22c8',
  [`${'x'.repeat(100)}`]: 'zzb96f1655bevgzqgwxhw74kkchjlovta445dece2',
  '{"comm":{"uin":0},"req_0":{"param":{"disstid":9780162922,"song_begin":0,"song_num":1000}}}':
    'zzbb67edf07ccs0cxr3wbjdtwvlyqrcw646edf46',
};

test('sign matches the legacy algorithm on known vectors', () => {
  for (const [input, expected] of Object.entries(VECTORS)) {
    assert.equal(signOf(input, md5), expected, JSON.stringify(input));
  }
});

test('sign length varies with the stripped base64 characters, always lowercase alphanumeric', () => {
  const lengths = new Set();
  for (let i = 0; i < 200; i += 1) {
    const sign = signOf(`body ${i}`, md5);
    assert.match(sign, /^zzb[0-9a-z]+$/);
    lengths.add(sign.length);
  }
  assert.ok(lengths.size > 1, 'padding and +/ are dropped, so lengths differ');
});

test('base64 equals the standard encoding', () => {
  for (const length of [0, 1, 2, 3, 4, 15, 16, 17]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 250) & 255);
    assert.equal(base64(bytes), Buffer.from(bytes).toString('base64'), `length ${length}`);
  }
});

test('sign depends on the md5 the host gives, not on node', () => {
  assert.equal(signOf('x', () => '0'.repeat(32)), signOf('y', () => '0'.repeat(32)));
});
