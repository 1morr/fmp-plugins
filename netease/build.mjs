// 把 src/plugin.js 打包成一個 FMP 安裝檔：manifest 標頭 + ES module（netease.js）。
// 用法：npm ci && node build.mjs
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

const manifest = {
  id: 'netease',
  name: '網易雲音樂',
  version: '1.0.1',
  author: 'FMP',
  description: '搜尋網易雲音樂的歌曲並播放。',
  apiVersion: 1,
  capabilities: ['search', 'resolveStream'],
  allowedHosts: ['music.163.com', 'music.126.net'],
  rateLimit: { maxConcurrentRequests: 2, minRequestIntervalMs: 300 },
};

const result = await build({
  entryPoints: ['src/plugin.js'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2020',
  minify: false,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});
const header = `/* ==FMP Plugin==\n${JSON.stringify(manifest, null, 2)}\n==/FMP Plugin== */\n`;
writeFileSync('netease.js', header + result.outputFiles[0].text);
console.log(`netease.js ${statSync('netease.js').size} bytes`);
