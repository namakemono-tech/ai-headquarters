'use strict';
// UserPromptSubmit: 指揮官の「承認」だけを作戦記録に結び付けて state/approval.json に書く。
// 目標の決心と計画の決心を区別して記録する(2026-11-22)。迷ったら止める側(目標の決心)に倒す。
// 計画の決心では、作戦記録の目標の3つの欄と計画の節の指紋を取る。「## 計画」が書かれていなければ記録しない(0.4.0)。
// 「承認」を記録するときに、作戦記録の「### 起動の上限」の数を控える(0.4.0。guard.js が起動を数えるときに使う)。
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

// 最新の作戦記録の本文。読めないときは null
function readOperation(root, latest) {
  try {
    const dir = path.join(root, AHQ, 'operations');
    const name = fs.readdirSync(dir).find((n) => { const m = /^OP-(\d+)\.md$/i.exec(n); return m && parseInt(m[1], 10) === latest; });
    return name ? fs.readFileSync(path.join(dir, name), 'utf8') : null;
  } catch { return null; }
}
// 作戦記録の「### 目標の決心」の次の行(空行を除く最初の行)が「修正:」か「省略:」で始まるか。読めないときは false
function goalsDecidedInLog(text) {
  try {
    if (typeof text !== 'string') return false;
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim() === '### 目標の決心');
    if (i < 0) return false;
    const next = lines.slice(i + 1).find((l) => l.trim() !== '');
    if (next === undefined || /^\s*#/.test(next)) return false;
    return /^(修正|省略)[:：]/.test(next.trim());
  } catch { return false; }
}
// ---- 指紋(ここから。0.4.0。approval.js と guard.js に一字も違わず同じものを書く。直すときは両方を直す)
// 指紋の対象は、作戦記録の「### 必成目標」「### 点検の物差し」「### 起動の上限」の3つの欄と、「## 計画」の節。
// 節の見出しは行の全体が「## 計画」(前後の空白は可)。節の本文は、次の「## 」で始まる行の前まで(「### 」の行は含む)。
// 欄の見出しは行の全体が「### 必成目標」など。欄の本文は、次の「## 」か「### 」で始まる行の前まで。最初に見つけたものを使う。
// 本文の前後の空行を除き、行末の空白と改行の種類をそろえてから計算する。欄や節が無いときは、空として計算する。
const FP_FIELDS = ['必成目標', '点検の物差し', '起動の上限'];
function fpLines(text) {
  return String(text == null ? '' : text).replace(/^﻿/, '').split(/\r\n|\r|\n/).map((l) => l.replace(/[ \t　]+$/, ''));
}
function fpBody(lines, heading, endRe) {
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !endRe.test(lines[j].trimStart())) j++;
  const body = lines.slice(i + 1, j);
  while (body.length && body[0] === '') body.shift();
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}
const FP_SECTION_END = /^##(?!#)/;
const FP_FIELD_END = /^###?(?!#)/;
function fingerprintOf(text) {
  const lines = fpLines(text);
  const parts = FP_FIELDS.map((f) => `### ${f}\n${fpBody(lines, `### ${f}`, FP_FIELD_END) || ''}`);
  parts.push(`## 計画\n${fpBody(lines, '## 計画', FP_SECTION_END) || ''}`);
  return require('crypto').createHash('sha256').update(parts.join('\n\u0000\n'), 'utf8').digest('hex').slice(0, 12);
}
// 「## 計画」の節があり、空でなく、「未作成」で始まらないか
function planWritten(text) {
  const body = fpBody(fpLines(text), '## 計画', FP_SECTION_END);
  return typeof body === 'string' && body.trim() !== '' && !body.trim().startsWith('未作成');
}
// 「### 起動の上限」の欄の最初の行の、先頭の半角の数字(1以上)。読み取れなければ null
function launchLimitOf(text) {
  const body = fpBody(fpLines(text), '### 起動の上限', FP_FIELD_END);
  const m = body ? /^\s*(\d+)/.exec(body.split('\n')[0]) : null;
  const n = m ? parseInt(m[1], 10) : 0;
  return n > 0 ? n : null;
}
// ---- 指紋(ここまで)

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
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
  const appPath = path.join(stateDir, 'approval.json');
  const prev = readJsonSafe(appPath);
  const same = !!prev && typeof prev === 'object' && prev.session_id === input.session_id && prev.operation === operation;
  const prevGoals = same && typeof prev.goals === 'string' && prev.goals !== '' ? prev.goals : null;
  const prevPlan = same && typeof prev.plan === 'string' && prev.plan !== '' ? prev.plan : null;
  const log = readOperation(root, latest);
  // 計画の決心とするのは、このセッションのこの作戦の目標の決心が記録済みのときか、作戦記録の欄が「修正:」「省略:」で始まるときだけ
  const stage = prevGoals || goalsDecidedInLog(log) ? 'plan' : 'goals';
  // 計画の決心は、作戦記録の「## 計画」に計画書が書かれているときだけ記録する(0.4.0)。記録は変えない
  if (stage === 'plan' && !planWritten(log)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `${operation} の「## 計画」に計画書が書かれていない(節が無い、空、または「未作成」)ため、計画の決心として記録していません。計画を作戦記録に書いてから、もう一度『承認』と入力してもらってください。` } }));
    return;
  }
  const now = new Date().toISOString();
  const rec = { session_id: input.session_id, operation, goals: stage === 'goals' ? now : prevGoals, plan: stage === 'plan' ? now : prevPlan, ts: now };
  if (stage === 'plan') rec.fingerprint = fingerprintOf(log);
  const limit = launchLimitOf(log);
  if (limit !== null) rec.launch_limit = limit;
  atomicWrite(appPath, rec);
  // 同じセッションの同じ作戦で、計画の決心がすでに記録されていれば、記録し直し(節目の承認、処置事項の一覧への承認)として案内する(0.4.1)。
  // 前の指紋と違うときだけ、書き換えの知らせを足す。止める動きと状態ファイルの形は変えない
  const prevFp = prevPlan && typeof prev.fingerprint === 'string' && prev.fingerprint !== '' ? prev.fingerprint : null;
  let text;
  if (stage === 'goals') {
    text = `指揮官の承認を、目標の決心として ${operation} に記録しました。unit はまだ起動できません。作戦記録の「### 目標の決心」の次の行を「承認: 」と日時に書き換え、計画を作戦記録の「## 計画」に書いて示し、改めて「承認」とだけ入力してもらってください。(欄の無い古い作戦記録では、このため「承認」が2回要ります。)`;
  } else if (prevPlan) {
    text = `指揮官の承認を、${operation} に記録し直しました(節目の承認。処置事項の一覧を示していたなら、その承認も兼ねます。指紋 ${rec.fingerprint})。作戦記録の「### 計画の決心」に「承認: 日時(指紋 ${rec.fingerprint})」を足してください。`;
    if (prevFp && prevFp !== rec.fingerprint) text += `前の承認の指紋(${prevFp})と違います。目標の3つの欄か計画の節が書き換えられています。書き換えた点を指揮官に示していなければ、いま示してください。`;
  } else {
    text = `指揮官の承認を、計画の決心として ${operation} に記録しました(指紋 ${rec.fingerprint})。作戦記録の「### 計画の決心」に「承認: 日時(指紋 ${rec.fingerprint})」と書いてください。承認のあとに、目標の3つの欄(必成目標、点検の物差し、起動の上限)か計画の節を書き換えると、unit を起動できなくなります。`;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  }));
}

try { main(); } catch { /* 指揮官の発言を止めない */ }
process.exitCode = 0;
