// 把 src/plugin.js 打包成一個 FMP 安裝檔：manifest 標頭 + ES module（spotify.js）。
// 用法：npm ci && node build.mjs
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

const manifest = {
  id: 'spotify',
  name: 'Spotify',
  version: '1.0.0',
  author: 'FMP',
  description: '匯入 Spotify 公開歌單的曲目清單（不需登入）；Spotify 的曲目不能直接播放，只用來到其他音源匹配。',
  apiVersion: 1,
  capabilities: ['importPlaylist'],
  allowedHosts: ['open.spotify.com', 'spotify.link', 'scdn.co'],
  rateLimit: { maxConcurrentRequests: 1, minRequestIntervalMs: 500 },
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
writeFileSync('spotify.js', header + result.outputFiles[0].text);
console.log(`spotify.js ${statSync('spotify.js').size} bytes`);
