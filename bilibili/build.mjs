// 把 src/plugin.js 打包成一個 FMP 安裝檔：manifest 標頭 + ES module（bilibili.js）。
// 用法：npm ci && node build.mjs
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

const manifest = {
  id: 'bilibili',
  name: 'Bilibili',
  version: '1.2.0',
  author: 'FMP',
  description: '搜尋 Bilibili 影片並播放其音訊，可用 QR 碼登入。',
  apiVersion: 1,
  capabilities: ['search', 'resolveStream', 'login'],
  allowedHosts: [
    'api.bilibili.com',
    'passport.bilibili.com',
    'www.bilibili.com',
    'hdslb.com',
    'bilivideo.com',
    'bilivideo.cn',
    'upos-hz-mirrorakam.akamaized.net',
  ],
  login: { methods: ['qr'], refresh: 'onStartup' },
  rateLimit: { maxConcurrentRequests: 2, minRequestIntervalMs: 300 },
  redaction: {
    headerNames: ['X-Bili-Metadata-Ip-Region', 'X-Bili-Metadata-Legal-Region', 'X-Bili-Gaia-Vvoucher'],
    keyNames: [
      'buvid',
      'buvid3',
      'buvid4',
      'buvid_fp',
      '_uuid',
      'b_nut',
      'bili_ticket',
      'v_voucher',
      'w_rid',
      'wts',
      'hdnts',
      'ip_region',
      'refresh_token',
      'qrcode_key',
      // 刷新用的一次性值：refresh_csrf 在 form body 與 correspond 頁（宿主名單只有 csrf）。
      'refresh_csrf',
    ],
  },
};

const result = await build({
  entryPoints: ['src/plugin.js'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['main'],
  target: 'es2020',
  minify: false,
  legalComments: 'none',
  // bn.js 試著 require('buffer')（失敗會接住）；QuickJS 沒有它，換成空模組。
  alias: { buffer: './src/empty-buffer.cjs' },
  write: false,
  logLevel: 'warning',
});
const header = `/* ==FMP Plugin==\n${JSON.stringify(manifest, null, 2)}\n==/FMP Plugin== */\n`;
writeFileSync('bilibili.js', header + result.outputFiles[0].text);
console.log(`bilibili.js ${statSync('bilibili.js').size} bytes`);
