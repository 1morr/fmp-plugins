import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artwork, decodeHtmlEntities } from '../bilibili.js';

test('decodes named entities', () => {
  assert.equal(decodeHtmlEntities('&quot;a&quot; &amp; &lt;b&gt; &apos;'), '"a" & <b> \'');
});

test('decodes numeric entities, decimal and hex', () => {
  assert.equal(decodeHtmlEntities('it&#x27;s &#39;ok&#39; &#X41;&#66; &#x1F600;'), "it's 'ok' AB \u{1F600}");
});

test('decodes in a single pass', () => {
  assert.equal(decodeHtmlEntities('&amp;lt; &amp;#39;'), '&lt; &#39;');
});

test('leaves unknown and invalid entities alone', () => {
  assert.equal(decodeHtmlEntities('&foo; &#0; &#xD800; &#x110000; & &amp'), '&foo; &#0; &#xD800; &#x110000; & &amp');
});

test('artwork gives 160w and 480w thumbnails plus the original', () => {
  assert.deepEqual(artwork('//i0.hdslb.com/bfs/archive/a.jpg'), [
    { url: 'https://i0.hdslb.com/bfs/archive/a.jpg@160w', width: 160 },
    { url: 'https://i0.hdslb.com/bfs/archive/a.jpg@480w', width: 480 },
    { url: 'https://i0.hdslb.com/bfs/archive/a.jpg' },
  ]);
});

test('artwork upgrades http, keeps an existing suffix, rejects other hosts', () => {
  assert.equal(artwork('http://i1.hdslb.com/x.jpg').length, 3);
  assert.deepEqual(artwork('https://i1.hdslb.com/x.jpg@100w'), [{ url: 'https://i1.hdslb.com/x.jpg@100w' }]);
  assert.deepEqual(artwork('https://example.com/x.jpg'), []);
  assert.deepEqual(artwork(''), []);
  assert.deepEqual(artwork(null), []);
});
