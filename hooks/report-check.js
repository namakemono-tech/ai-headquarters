'use strict';
// 報告の型の確認(PreToolUse の SubagentHandback と SubagentStop)と、unit の予約の解除。
// 品質のための確認なので、どんな異常でも exit 0 で何もしない。差し戻しはエージェント(agent_id)ごとに1回だけ。
const fs = require('node:fs');
const path = require('node:path');

const AHQ = '.ai-headquarters';
const ROLE_RE = /^(ai-headquarters:)?(intel|plans|unit|inspector)$/;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const BASE_HEADINGS = ['任務番号', '結論', '根拠', '未解決・懸念', '推測'];
const HEAD_PREFIX = /^[ \t\u3000#>*-]*/.source;
const LOCK_WAIT_MS = 3000; // 全件のテストのような高い負荷でも取れるよう3秒(ロックの待ち時間を3秒に延ばした理由)。report-check の timeout(10秒)より十分短い
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 5000;
const GUIDE = 'mission-order スキルの報告の型で書き直してください';

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function atomicWrite(p, obj) {
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 無視 */ } throw e; }
}

function missingHeadings(text, role) {
  // 【実施内容】は unit だけ。【目標の達成】(0.2.0)は unit と inspector だけ。並びは報告の型の順
  const need = [...BASE_HEADINGS.slice(0, 3)];
  if (role === 'unit') need.push('実施内容');
  if (role === 'unit' || role === 'inspector') need.push('目標の達成');
  need.push(...BASE_HEADINGS.slice(3));
  // 行頭の空白と、Markdown の飾り(# > - * **)は許す。行の途中の見出しは数えない
  return need.filter((h) => !new RegExp(HEAD_PREFIX + '【' + h + '】', 'm').test(text)).map((h) => `【${h}】`);
}

// 状態(agent_id ごとの回数と通過済み)。.ai-headquarters が無ければ null(作らない)
function stateFile(root) {
  try {
    if (!fs.statSync(path.join(root, AHQ)).isDirectory()) return null;
  } catch { return null; }
  return path.join(root, AHQ, 'state', 'report-retries.json');
}

function loadState(file) {
  const s = readJsonSafe(file);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 無視 */ }
}

// 短い排他ロック(wx)。固有の値(pid と乱数)を書き、解除は自分の値のときだけ行う。
// 取れたら解除用の関数、期限(約1秒)までに取れなければ null。5秒より古いロックは、読んだ値が変わっていなければ捨てる
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = process.pid + '.' + Math.random().toString(36).slice(2);
  for (;;) {
    try {
      fs.writeFileSync(lockPath, token, { flag: 'wx' });
      return () => { try { if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath); } catch { /* 無視 */ } };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
    }
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        const seen = fs.readFileSync(lockPath, 'utf8');
        if (fs.readFileSync(lockPath, 'utf8') === seen) fs.unlinkSync(lockPath);
      }
    } catch { /* 無視。期限の確認へ進む */ }
    if (Date.now() >= deadline) return null;
    sleepMs(LOCK_RETRY_MS);
  }
}

// ロックの中で読み直し、decide(その agent_id の記録) が返した値を書き足す(null なら書かない)。
// 書くたびに24時間より古い記録を捨てる。戻り値: {ok:false}(ロックや書き込みの失敗)か {ok:true, rec(書く前の記録), wrote}
function updateState(file, agentId, decide) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { return { ok: false }; }
  const release = acquireLock(path.join(path.dirname(file), 'report-retries.lock'));
  if (!release) return { ok: false };
  try {
    const state = loadState(file);
    const cur = state[agentId] && typeof state[agentId] === 'object' ? state[agentId] : {};
    const patch = decide(cur);
    if (!patch) return { ok: true, rec: cur, wrote: false };
    const now = Date.now();
    const next = {};
    for (const [k, v] of Object.entries(state)) {
      if (v && typeof v === 'object' && now - Number(v.ts) <= RETENTION_MS) next[k] = v;
    }
    next[agentId] = { ...(next[agentId] || {}), ...patch, ts: now };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, next);
    return { ok: true, rec: cur, wrote: true };
  } catch { return { ok: false }; } finally { release(); }
}

// running で、session_id と agent_id が入力と同じ記録だけ消す(別の unit の予約を消さないため)
function releaseUnit(root, input) {
  try {
    if (typeof input.session_id !== 'string' || !input.session_id) return;
    const lockPath = path.join(root, AHQ, 'state', 'unit-lock.json');
    const lock = readJsonSafe(lockPath);
    if (!lock || typeof lock !== 'object' || lock.status !== 'running' || lock.session_id !== input.session_id) return;
    if (typeof lock.agent_id === 'string' && lock.agent_id === input.agent_id) fs.unlinkSync(lockPath);
  } catch { /* 無視 */ }
}

function out(o) { process.stdout.write(JSON.stringify(o)); }

function block(event, reason) {
  if (event === 'PreToolUse') out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  else out({ decision: 'block', reason });
}

// 通すときの警告は systemMessage だけ(additionalContext は報告を渡し終えたサブエージェントに届き、出し直しを誘うため)
function warn(text) { out({ systemMessage: text }); }

// 戻り値: 差し戻したら true
function check(input, event, role, root) {
  const agentId = input.agent_id;
  const file = stateFile(root);
  let text;
  if (event === 'PreToolUse') {
    text = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input.message : undefined;
    if (typeof text !== 'string') return false;
  } else {
    // auto モードでは報告は Handback で確かめ済み。最後の応答は報告ではなく締めの文
    if (input.permission_mode === 'auto') return false;
    if (file && loadState(file)[agentId] && loadState(file)[agentId].passed) return false;
    text = input.last_assistant_message;
    if (typeof text !== 'string' || !text.trim()) return false;
  }
  const missing = missingHeadings(text, role);
  if (!missing.length) {
    if (event === 'PreToolUse' && file) updateState(file, agentId, () => ({ passed: true }));
    return false;
  }
  const list = missing.join('');
  const op = /【任務番号】[ \t\u3000]*(OP-\d+(?:-\d+)?)/.exec(text);
  const warnText = `${op ? `${op[1]}(${role})` : role}の報告に${list}が欠けています。`;
  const reason = `報告に${list}が欠けています。${GUIDE}。`;
  // 1回目なら回数を記録して差し戻す。2回目以降なら通過を記録して警告付きで通す
  let first = false;
  const r = file ? updateState(file, agentId, (rec) => {
    if (event === 'SubagentStop' && rec.passed) return null;
    if (Number(rec.count) >= 1) return event === 'PreToolUse' ? { passed: true } : null;
    first = true;
    return { count: 1 };
  }) : { ok: false };
  if (r.ok && first) { block(event, reason); return true; }
  if (r.ok) { warn(`${warnText}(1回差し戻しましたが直らなかったため通しました)`); return false; }
  // .ai-headquarters はあるが、ロックが取れない・書けない場合は、記録を諦めて通す(差し戻さない)
  if (file) { warn(`${warnText}(回数を記録できないため差し戻さずに通しました)`); return false; }
  // .ai-headquarters が無く、回数を記録できない場合
  if (event === 'PreToolUse') { warn(`${warnText}(回数を記録できないため差し戻さずに通しました)`); return false; }
  if (input.stop_hook_active === true) { warn(`${warnText}(回数を記録できないため、2回目として通しました)`); return false; }
  block(event, reason);
  return true;
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const event = input.hook_event_name;
  if (event === 'PreToolUse' ? input.tool_name !== 'SubagentHandback' : event !== 'SubagentStop') return;
  if (typeof input.agent_id !== 'string' || !input.agent_id) return;
  const m = typeof input.agent_type === 'string' ? ROLE_RE.exec(input.agent_type) : null;
  if (!m) return;
  const role = m[2];
  const root = path.resolve(String(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
  let blocked = false;
  try { blocked = check(input, event, role, root); } catch { blocked = false; }
  if (!blocked && event === 'SubagentStop' && role === 'unit') releaseUnit(root, input);
}

try { main(); } catch { /* 確認の失敗で作業を止めない */ }
process.exitCode = 0;
