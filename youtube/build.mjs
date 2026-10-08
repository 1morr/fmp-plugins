// 把 src/plugin.js 打包成一個 FMP 安裝檔：manifest 標頭 + ES module（youtube.js）。
// 用法：npm ci && node build.mjs
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

const manifest = {
  id: 'youtube',
  name: 'YouTube',
  version: '1.0.0',
  author: 'FMP',
  apiVersion: 1,
  capabilities: ['search', 'resolveStream'],
  allowedHosts: ['youtube.com', 'googlevideo.com', 'ytimg.com'],
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
