#!/usr/bin/env node
'use strict';
// 自動テストを流す(npm test から呼ぶ。依存なし)。
// tests/ の *.test.js を並べて node --test に渡す。`node --test tests/` のようにフォルダを渡す書き方は、
// Node.js の版によって動かない(Node 24 では、フォルダを1つのファイルとして読もうとして失敗する)ため。
// 使い方: node scripts/run-tests.js [node --test に渡すオプション]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('tests', f));
if (files.length === 0) {
  console.error('run-tests: tests/ にテストのファイルがありません');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: ROOT, stdio: 'inherit' });
if (r.error) {
  console.error(`run-tests: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
