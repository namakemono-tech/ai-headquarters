'use strict';
// 時計(0.6.0。伺4 の「止めずに知らせる」)。UserPromptSubmit、Stop、PostToolUse(Agent、Task)で、作戦中(最新の作戦記録の
// 「## 結果」の最初の行が「未完了」)なら、時刻を state/clock.jsonl に1行ずつ足し、幕僚長に事実の1行を返す(additionalContext)。
// 作戦記録から読むのは、作戦中かどうかだけ。知らせるだけで、止めない。何があっても exit 0 で、指揮官の発言と作戦を止めない。
// 指揮官の画面への知らせ(設定の線を超えたとき)は、guard.js が PreToolUse から出す(画面に出ることを確かめたイベントのため)。
// guard.js は、作業の時間の数え方(workMs)と線の読み方(noticeLines)を、このファイルから借りる。
const fs = require('node:fs');
const path = require('node:path');

const AHQ = '.ai-headquarters';
const ROLE_RE = /^(ai-headquarters:)?(intel|plans|unit|inspector)$/;
const MIN = 60000;
const NOTICE_DEFAULT = { launches: 12, minutes: 60 };

function latestOp(root) {
  try {
    const ns = fs.readdirSync(path.join(root, AHQ, 'operations')).map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean);
    if (!ns.length) return null;
    const m = ns.reduce((a, b) => (parseInt(b[1], 10) > parseInt(a[1], 10) ? b : a));
    return { op: `OP-${String(parseInt(m[1], 10)).padStart(3, '0')}`, text: fs.readFileSync(path.join(root, AHQ, 'operations', m[0]), 'utf8') };
  } catch { return null; }
}
// 「## 結果」の最初の行(空行を除く)が「未完了」か。節が無い、または空のときも作戦中とみなす
function inOperation(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const i = lines.findIndex((l) => /^##\s*結果\s*$/.test(l.trim()));
  if (i < 0) return true;
  const first = lines.slice(i + 1).map((l) => l.trim()).find((l) => l !== '');
  return first === undefined || first.startsWith('#') || first.startsWith('未完了');
}
function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r === 'object'); } catch { return []; }
}
const fmt = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const mins = (ms) => Math.round(ms / MIN);

// 設定ファイルの知らせの線(notice.launches、notice.minutes)。無ければ既定の線。0 か数でない値を書くと、その線は使わない
function noticeLines(root) {
  let n = null;
  try { const c = JSON.parse(fs.readFileSync(path.join(root, AHQ, 'config.json'), 'utf8')); n = c && typeof c.notice === 'object' && !Array.isArray(c.notice) ? c.notice : null; } catch { /* 無い */ }
  const pick = (k) => {
    if (!n || !Object.prototype.hasOwnProperty.call(n, k)) return NOTICE_DEFAULT[k];
    return Number.isFinite(n[k]) && n[k] > 0 ? n[k] : null;
  };
  return { launches: pick('launches'), minutes: pick('minutes') };
}
// この作戦の起動の回数(SubagentStart で guard.js が数えた state/launches.jsonl。同じ agent_id は1回)
function launchCount(root, op) {
  return new Set(readLines(path.join(root, AHQ, 'state', 'launches.jsonl')).filter((r) => r.operation === op).map((r, i) => r.agent_id || `#${i}`)).size;
}
// 作業の時間: 開始からの経過から、指揮官の入力を待った時間を引いたもの。待ちは、応答の終わり(動いている4体が無いとき)から、
// 次の指揮官の発言までとする(バックグラウンドの4体が動いているあいだは、応答が終わっていても待ちに数えない)
function workMs(rows, now) {
  const start = Date.parse((rows.find((r) => r.ev === 'start') || {}).ts);
  let wait = 0; let since = null; const open = new Map();
  for (const r of rows) {
    if (r.ev === 'agent_launch' && r.agent_id) open.set(r.agent_id, Date.parse(r.ts));
    else if (r.ev === 'agent_end') open.delete(r.agent_id);
    else if (r.ev === 'stop' && ![...open.values()].some((at) => Date.parse(r.ts) - at < 60 * MIN)) since = Date.parse(r.ts);
    else if (r.ev === 'prompt' && since !== null) { wait += Date.parse(r.ts) - since; since = null; }
  }
  if (since !== null) wait += now - since;
  return Number.isNaN(start) ? 0 : Math.max(0, now - start - wait);
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { return; }
  if (!input || typeof input !== 'object') return;
  const root = path.resolve(String(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
  const cur = latestOp(root);
  if (!cur || !inOperation(cur.text)) return;
  const ev = input.hook_event_name;
  const state = path.join(root, AHQ, 'state');
  const clockPath = path.join(state, 'clock.jsonl');
  const all = readLines(clockPath).filter((r) => r.operation === cur.op);
  const now = Date.now();
  const add = (rec) => { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(clockPath, `${JSON.stringify({ ts: new Date(now).toISOString(), operation: cur.op, session_id: input.session_id || null, ...rec })}\n`); };
  if (!all.some((r) => r.ev === 'start')) { add({ ev: 'start' }); all.push({ ev: 'start', ts: new Date(now).toISOString() }); }
  let rec = null; let head = '';
  const endHead = (r) => `${r.role} は ${r.actual_min === null ? '時間不明' : `${Math.round(r.actual_min)}分`}。`;
  if (ev === 'UserPromptSubmit') {
    const pr = String(input.prompt || '');
    if (/^\s*<task-notification>/.test(pr)) {
      // バックグラウンドで起動した4体の終わりは、報告の知らせ(task-id は起動の agentId)で記録して知らせる
      const id = (/<task-id>\s*([^<\s]+)/.exec(pr) || [])[1];
      const l = id && all.find((r) => r.ev === 'agent_launch' && r.agent_id === id);
      if (!l || all.some((r) => r.ev === 'agent_end' && r.agent_id === id)) { add({ ev: 'notification' }); return; }
      rec = { ev: 'agent_end', agent_id: id, role: l.role, actual_min: Math.round((now - Date.parse(l.ts)) / MIN * 10) / 10, via: 'notification' };
      head = endHead(rec);
    } else rec = { ev: 'prompt' };
  } else if (ev === 'Stop') {
    add({ ev: 'stop' });
    return;
  } else if (ev === 'PostToolUse' && /^(Agent|Task)$/.test(input.tool_name || '')) {
    const ti = input.tool_input || {};
    const rm = ROLE_RE.exec(String(ti.subagent_type || ''));
    if (!rm) return;
    const resp = input.tool_response || {};
    const ms = Number(resp.totalDurationMs) || null;
    if (!ms && (ti.run_in_background || /async/i.test(String(resp.status || '')))) {
      // バックグラウンドの起動: 終わりは、あとの報告の知らせで記録する。ここでは起動だけを記録し、知らせない
      const id = resp.agentId || (/agentId:\s*([A-Za-z0-9]+)/.exec(JSON.stringify(resp)) || [])[1] || null;
      add({ ev: 'agent_launch', agent_id: id, role: rm[2] });
      return;
    }
    rec = { ev: 'agent_end', agent_id: resp.agentId || null, role: rm[2], actual_min: ms ? Math.round(ms / MIN * 10) / 10 : null };
    head = endHead(rec);
  } else return;
  const rows = all.concat([{ ...rec, ts: new Date(now).toISOString() }]);
  const start = Date.parse(all.find((r) => r.ev === 'start').ts);
  const work = mins(workMs(rows, now));
  const n = launchCount(root, cur.op);
  const lines = noticeLines(root);
  const over = [];
  if (lines.minutes && work > lines.minutes) over.push(`作業の時間が線(${lines.minutes}分)`);
  if (lines.launches && n > lines.launches) over.push(`起動が線(${lines.launches}回)`);
  let text = `時計: ${fmt(now)}。${head}${cur.op} は開始から ${mins(now - start)}分。作業 ${work}分${lines.minutes ? `(線 ${lines.minutes}分)` : ''}、起動 ${n}回${lines.launches ? `(線 ${lines.launches}回)` : ''}。`;
  if (over.length) text += `${over.join('と')}を超えています。最初に示した配分と照らしてください。`;
  add({ ...rec, notice: text });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: text } }));
}

module.exports = { workMs, noticeLines, launchCount, readLines, inOperation };

if (require.main === module) {
  try { main(); } catch { /* 作戦を止めない */ }
  process.exitCode = 0;
}
