// 把 src/plugin.js 打包成一個 FMP 安裝檔：manifest 標頭 + ES module（youtube.js）。
// 用法：npm ci && node build.mjs
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

const manifest = {
  id: 'youtube',
  name: 'YouTube',
  version: '1.0.0',
  author: 'FMP',
  description: '搜尋 YouTube 影片並播放其音訊。',
  apiVersion: 1,
  capabilities: ['search', 'resolveStream', 'login'],
  // accounts.google.com：登入頁（webView.url）；ggpht.com：帳號頭像。
  allowedHosts: ['youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'accounts.google.com'],
  login: {
    methods: ['webView', 'cookie'],
    webView: {
      url: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/',
      cookieHosts: ['https://www.youtube.com'],
      doneCookies: ['SAPISID', '__Secure-1PSID', '__Secure-3PSID'],
    },
    automationRisk: true,
  },
};

const result = await build({
  entryPoints: ['src/plugin.js'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});
const header = `/* ==FMP Plugin==\n${JSON.stringify(manifest, null, 2)}\n==/FMP Plugin== */\n`;
writeFileSync('youtube.js', header + result.outputFiles[0].text);
console.log(`youtube.js ${statSync('youtube.js').size} bytes`);
