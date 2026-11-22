'use strict';
// UserPromptSubmit: 指揮官の「承認」だけを作戦記録に結び付けて state/approval.json に書く。
// 目標の決心と計画の決心を区別して記録する(2026-11-22)。迷ったら止める側(目標の決心)に倒す。
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

// 作戦記録の「### 目標の決心」の次の行(空行を除く最初の行)が「修正:」か「省略:」で始まるか。読めないときは false
function goalsDecidedInLog(root, latest) {
  try {
    const dir = path.join(root, AHQ, 'operations');
    const name = fs.readdirSync(dir).find((n) => { const m = /^OP-(\d+)\.md$/i.exec(n); return m && parseInt(m[1], 10) === latest; });
    if (!name) return false;
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim() === '### 目標の決心');
    if (i < 0) return false;
    const next = lines.slice(i + 1).find((l) => l.trim() !== '');
    if (next === undefined || /^\s*#/.test(next)) return false;
    return /^(修正|省略)[:：]/.test(next.trim());
  } catch { return false; }
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
// 前後の空白(全角を含む)と、末尾の「。」「!」「!」(半角・全角、複数可)を取り除く
function isApproval(prompt) {
  if (typeof prompt !== 'string') return false;
  const s = prompt.replace(/^[\s　﻿]+/, '').replace(/(?:[\s　﻿]|[。!！])+$/, '');
  return s === '承認';
}

// 作戦の始まりの記録(0.3.0)。guard.js と同じ場所(OS の一時フォルダの ai-headquarters)。
// /ai-headquarters:mission か /mission で始まる発言なら記録する(mission-analysis の読み込み前の印。数え直しにもなる)。
// それ以外の発言では、mission-analysis の読み込み前なら記録を消す(作戦の始まりを終える)。
// mission-analysis の読み込み後(analysis: true)は、任務分析の途中の質問への答えで終わらないよう、発言を数え、3回目で消す
const PENDING_PROMPT_LIMIT = 3;
function pendingPath(sid) {
  return path.join(require('node:os').tmpdir(), 'ai-headquarters', `pending-${String(sid).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}
function updatePending(input) {
  const sid = input.session_id;
  if (typeof sid !== 'string' || !sid || typeof input.prompt !== 'string') return;
  const p = pendingPath(sid);
  if (/^[\s　﻿]*\/(ai-headquarters:)?mission(?:\s|$)/.test(input.prompt)) {
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    const limit = Date.now() - 24 * 3600 * 1000;
    for (const n of fs.readdirSync(dir)) {
      try { const q = path.join(dir, n); if (fs.statSync(q).mtimeMs < limit) fs.unlinkSync(q); } catch { /* 無視 */ }
    }
    atomicWrite(p, { session_id: sid, ts: new Date().toISOString(), analysis: false, prompts: 0 });
  } else if (!/^[\s　﻿]*<task-notification>/.test(input.prompt)) {
    // サブエージェントの報告の知らせ(<task-notification> で始まるもの)は、指揮官の発言として数えない
    const rec = readJsonSafe(p);
    if (rec === null && !fs.existsSync(p)) return;
    const n = rec && Number.isInteger(rec.prompts) && rec.prompts >= 0 ? rec.prompts + 1 : 1;
    if (rec && rec.analysis === true && n < PENDING_PROMPT_LIMIT) {
      atomicWrite(p, { ...rec, prompts: n });
    } else {
      try { fs.unlinkSync(p); } catch { /* 無ければ何もしない */ }
    }
  }
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  try { updatePending(input); } catch { /* 指揮官の発言を止めない */ }
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
  // 計画の決心とするのは、このセッションのこの作戦の目標の決心が記録済みのときか、作戦記録の欄が「修正:」「省略:」で始まるときだけ
  const stage = prevGoals || goalsDecidedInLog(root, latest) ? 'plan' : 'goals';
  const now = new Date().toISOString();
  atomicWrite(appPath, { session_id: input.session_id, operation, goals: stage === 'goals' ? now : prevGoals, plan: stage === 'plan' ? now : prevPlan, ts: now });
  const text = stage === 'goals'
    ? `指揮官の承認を、目標の決心として ${operation} に記録しました。unit はまだ起動できません。作戦記録の「### 目標の決心」の次の行を「承認: 」と日時に書き換え、計画を示し、改めて「承認」とだけ入力してもらってください。(欄の無い古い作戦記録では、このため「承認」が2回要ります。)`
    : `指揮官の承認を、計画の決心として ${operation} に記録しました。`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  }));
}

try { main(); } catch { /* 指揮官の発言を止めない */ }
process.exitCode = 0;
