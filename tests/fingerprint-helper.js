'use strict';
// テスト用: hooks/approval.js の「指紋」の印のあいだのコードを取り出して使う(0.4.0)。
// Hooks は単体のファイルなので、指紋の計算は approval.js と guard.js に同じものを書いてある。
// テストは3つ目の写しを持たず、approval.js の印のあいだをそのまま動かす(guard.js と同じであることは fingerprint.test.js で確かめる)。
const fs = require('node:fs');
const path = require('node:path');

const BEGIN = '// ---- 指紋(ここから。';
const END = '// ---- 指紋(ここまで)';

function fpBlock(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const s = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (s < 0 || e < 0 || e < s) throw new Error(`${path.basename(file)} に指紋の印がありません`);
  return src.slice(s, e + END.length);
}

const block = fpBlock(path.join(__dirname, '..', 'hooks', 'approval.js'));
// eslint-disable-next-line no-new-func
const api = new Function('require', `${block}\nreturn { fingerprintOf, planWritten, launchLimitOf };`)(require);

// 作戦記録のファイルから指紋を計算する
const fingerprintFile = (p) => api.fingerprintOf(fs.readFileSync(p, 'utf8'));

module.exports = { fpBlock, ...api, fingerprintFile };
