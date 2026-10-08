// 從 stdin 的插件 .js 讀標頭 manifest，印出 version。給 CI 的版本檢查用。
import { readFileSync } from 'node:fs';

const source = readFileSync(0, 'utf8');
const match = /^﻿?\/\* ==FMP Plugin==([\s\S]*?)==\/FMP Plugin== \*\//.exec(source);
if (!match) {
  console.error('missing ==FMP Plugin== header');
  process.exit(1);
}
const { version } = JSON.parse(match[1]);
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`bad version: ${version}`);
  process.exit(1);
}
console.log(version);
