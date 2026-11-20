'use strict';
// UserPromptSubmit: 指揮官の「承認」だけを作戦記録に結び付けて state/approval.json に書く。
// 作戦記録が無いときは何も書かず、記録しなかった旨だけを additionalContext で返す。
// どんな入力でも指揮官の発言を止めない(異常は握りつぶして exit 0。出力は上の案内か、無し)。
const fs = require('node:fs');
const path = require('node:path');

const AHQ = '.ai-headquarters';

function atomicWrite(p, obj) {
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 無視 */ } throw e; }
}

function latestOperation(root) {
  try {
    const nums = fs.readdirSync(path.join(root, AHQ, 'operations'))
      .map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean).map((m) => parseInt(m[1], 10));
    return nums.length ? Math.max(...nums) : null;
  } catch { return null; }
}

// 前後の空白(全角を含む)と、末尾の「。」「!」「!」(半角・全角、複数可)を取り除く
function isApproval(prompt) {
  if (typeof prompt !== 'string') return false;
  const s = prompt.replace(/^[\s　﻿]+/, '').replace(/(?:[\s　﻿]|[。!！])+$/, '');
  return s === '承認';
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  // 入力に出どころを見分ける欄は確認できていない。完全一致だけで判定する
  if (!isApproval(input.prompt)) return;
  if (typeof input.session_id !== 'string' || input.session_id === '') return;
  const root = path.resolve(String(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
  const latest = latestOperation(root);
  if (latest === null) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '作戦記録が無いため、承認は記録していません。小規模の作業ならこのまま進めてください。中規模以上の作戦なら、作戦記録を作ってから、もう一度「承認」と入力してもらってください。' } }));
    return;
  }
  const operation = `OP-${String(latest).padStart(3, '0')}`;
  const stateDir = path.join(root, AHQ, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  atomicWrite(path.join(stateDir, 'approval.json'), { session_id: input.session_id, operation, ts: new Date().toISOString() });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `指揮官の承認を ${operation} に記録しました。`,
    },
  }));
}

try { main(); } catch { /* 指揮官の発言を止めない */ }
process.exitCode = 0;
