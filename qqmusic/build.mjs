// 把 src/plugin.js 打包成一個 FMP 安裝檔：manifest 標頭 + ES module（qqmusic.js）。
// 用法：npm ci && node build.mjs
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

const manifest = {
  id: 'qqmusic',
  name: 'QQ 音樂',
  version: '1.0.0',
  author: 'FMP',
  description: '匯入 QQ 音樂的公開歌單（只讀曲目資料，用來在其他音源配對播放），不需要登入。',
  apiVersion: 1,
  capabilities: ['importPlaylist'],
  // 宿主的網域規則含子網域：y.qq.com 涵蓋 u6、i、c 與封面的 music-file.y.qq.com；url.cn 是短網址。
  allowedHosts: ['y.qq.com', 'url.cn'],
  // 歌單分頁一次一個請求；一千首以內通常一頁收完。
  rateLimit: { maxConcurrentRequests: 1, minRequestIntervalMs: 300 },
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
writeFileSync('qqmusic.js', header + result.outputFiles[0].text);
console.log(`qqmusic.js ${statSync('qqmusic.js').size} bytes`);
