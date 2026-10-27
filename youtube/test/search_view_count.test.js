// search 的觀看次數：只認完整數字的顯示文字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { searchViewCount } from '../src/search_view_count.js';

const text = (t) => ({ text: t });

test('searchViewCount: full numbers parse, with or without separators', () => {
  assert.deepEqual(searchViewCount(text('1,824,429,303 views')), { viewCount: 1824429303 });
  assert.deepEqual(searchViewCount(text('21950 views')), { viewCount: 21950 });
  assert.deepEqual(searchViewCount(text('1 view')), { viewCount: 1 });
  assert.deepEqual(searchViewCount(text(' 0 views ')), { viewCount: 0 });
  assert.deepEqual(searchViewCount(text('No views')), { viewCount: 0 });
});

test('searchViewCount: abbreviations, live counts, other languages and missing text are omitted', () => {
  for (const value of [
    text('1.8B'),
    text('1.8B views'),
    text('869K views'),
    text('1,234 watching'),
    text('1,23 views'),
    text('1.234 views'),
    text('観看回数 1,234 回'),
    text(''),
    {},
    null,
    undefined,
  ]) {
    assert.deepEqual(searchViewCount(value), {}, JSON.stringify(value));
  }
});

test('searchViewCount: every video in the recorded search response has a count', () => {
  const recorded = JSON.parse(readFileSync(new URL('../fixtures/search/003.json', import.meta.url), 'utf8'));
  const videos = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') {
      if (node.videoRenderer) videos.push(node.videoRenderer);
      Object.values(node).forEach(walk);
    }
  };
  walk(recorded.response.jsonBody);
  assert.ok(videos.length >= 10);
  // YouTube.js 的 Text 取 simpleText（或 runs 串起來）；這裡直接取 simpleText。
  const counts = videos.map((v) => searchViewCount({ text: v.viewCountText.simpleText }).viewCount);
  for (const n of counts) assert.ok(Number.isInteger(n) && n >= 0);
  assert.equal(counts[0], 1824429303);
});

test('searchViewCount: a live or upcoming video without viewCountText gets no viewCount and the result still maps', () => {
  // YouTube.js 只在有 viewCountText 時才建 view_count，所以缺的時候是 undefined。
  const result = { sourceId: 'abc', title: 't', ...searchViewCount(undefined) };
  assert.deepEqual(result, { sourceId: 'abc', title: 't' });
  assert.equal('viewCount' in result, false);
});
