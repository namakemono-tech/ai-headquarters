'use strict';
// 時計(0.5.0)。UserPromptSubmit、Stop、PostToolUse(Agent、Task)で、作戦中(最新の作戦記録の「## 結果」が「未完了」で、
// 「### 時程」の欄がある作戦)なら、時刻を state/clock.jsonl に1行ずつ足し、幕僚長に1行の知らせを返す(additionalContext)。
// 知らせるだけで、止めない。何があっても exit 0 で、指揮官の発言と作戦を止めない。単体のファイル(ほかに依存しない)。
const fs = require('node:fs');
const path = require('node:path');

const AHQ = '.ai-headquarters';
const ROLE_RE = /^(ai-headquarters:)?(intel|plans|unit|inspector)$/;
const MIN = 60000;

function latestOp(root) {
  try {
    const ns = fs.readdirSync(path.join(root, AHQ, 'operations')).map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean);
    if (!ns.length) return null;
    const m = ns.reduce((a, b) => (parseInt(b[1], 10) > parseInt(a[1], 10) ? b : a));
    return { op: `OP-${String(parseInt(m[1], 10)).padStart(3, '0')}`, text: fs.readFileSync(path.join(root, AHQ, 'operations', m[0]), 'utf8') };
  } catch { return null; }
}
// 欄(### X)か節(## X)の本文。無ければ null
function body(text, heading) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return null;
  const end = heading.startsWith('### ') ? /^###?(?!#)/ : /^##(?!#)/;
  let j = i + 1;
  while (j < lines.length && !end.test(lines[j].trimStart())) j++;
  return lines.slice(i + 1, j).join('\n').trim();
}
function inOperation(text) {
  if (body(text, '### 時程') === null) return false;
  const r = body(text, '## 結果');
  return r === null || r === '' || r.startsWith('未完了') || r.startsWith('#');
}
function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r === 'object'); } catch { return []; }
}
const num = (re, s) => { const m = re.exec(s || ''); return m ? parseInt(m[1], 10) : null; };
const fmt = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const mins = (ms) => Math.round(ms / MIN);
// 【統制】の1行目(手順、点検の単位、持ち時間)と、【任務番号】
function control(prompt) {
  const s = String(prompt || '');
  const m = /^\s*【統制】(.*)$/m.exec(s);
  const first = m ? (m[1].trim() || (s.slice(m.index + m[0].length).split(/\r?\n/).find((l) => l.trim()) || '')) : '';
  const step = /手順\s*(\d+(?:\s*の\s*\d+)?)/.exec(first);
  const unit = /単\s*(\d+)/.exec(first);
  return {
    task: (/^\s*【任務番号】\s*(\S+)/m.exec(s) || [])[1] || null,
    step: step ? step[1].replace(/\s+/g, '') : null,
    unit: unit ? `単${unit[1]}` : (/(^|[^\S\r\n]|。)なし/.test(first) ? 'なし' : null),
    minutes: num(/持ち時間\s*[:：]\s*(\d+)\s*分/, first),
  };
}
// inspector の報告の【結論】の1行目の合否
function verdict(resp) {
  const t = (typeof resp === 'string' ? resp : JSON.stringify(resp && (resp.content || resp) || '')).replace(/\\n/g, '\n');
  const m = /【結論】[ \t　]*\n?[ \t　]*([^\n]*)/.exec(t);
  if (!m) return null;
  return /不合格/.test(m[1]) ? 'fail' : (/合格/.test(m[1]) ? 'pass' : null);
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
// 期限までの残り(分)。日時か「作業の時間で N分」。読めなければ null
function remainMin(deadline, now, work) {
  if (!deadline) return null;
  const w = /作業の時間で\s*(\d+)\s*分/.exec(deadline);
  if (w) return parseInt(w[1], 10) - mins(work);
  const d = /(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})/.exec(deadline);
  return d ? mins(new Date(+d[1], d[2] - 1, +d[3], +d[4], +d[5]).getTime() - now) : null;
}
// 残りの見込み(分)。まだ1回も終わっていない手順と点検の単位の持ち時間に、不合格で終わっている単位の直しと再点検の見込みを足す
function remainingEstimate(copy, ends) {
  const doneSteps = new Set(ends.filter((e) => e.role === 'unit' && e.step).map((e) => String(e.step).split('の')[0]));
  let est = 0;
  for (const s of copy.steps || []) if (!doneSteps.has(String(s.step).split('の')[0])) est += s.minutes;
  for (const u of copy.units || []) {
    const mine = ends.filter((e) => e.role === 'inspector' && e.unit === u.unit);
    if (!mine.length) { est += u.minutes; continue; }
    if (mine[mine.length - 1].verdict === 'fail') {
      const half = (copy.steps || []).filter((s) => u.steps.includes(String(s.step).split('の')[0])).reduce((a, s) => a + s.minutes, 0) / 2;
      est += u.redo != null ? u.redo : Math.round(u.minutes + half);
    }
  }
  return est;
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
  const endHead = (r) => {
    const a = r.actual_min === null ? null : Math.round(r.actual_min);
    let h = `${r.task ? `${r.task} ` : ''}${r.role} は ${a === null ? '時間不明' : `${a}分`}`;
    if (r.minutes && a !== null) h += a > r.minutes ? `(持ち時間 ${r.minutes}分。${a - r.minutes}分の超過)` : `(持ち時間 ${r.minutes}分)`;
    return `${h}。`;
  };
  if (ev === 'UserPromptSubmit') {
    const pr = String(input.prompt || '');
    if (/^\s*<task-notification>/.test(pr)) {
      // バックグラウンドで起動した4体の終わりは、報告の知らせ(task-id は起動の agentId)で記録して知らせる
      const id = (/<task-id>\s*([^<\s]+)/.exec(pr) || [])[1];
      const l = id && all.find((r) => r.ev === 'agent_launch' && r.agent_id === id);
      if (!l || all.some((r) => r.ev === 'agent_end' && r.agent_id === id)) { add({ ev: 'notification' }); return; }
      rec = { ev: 'agent_end', agent_id: id, role: l.role, task: l.task, step: l.step, unit: l.unit, minutes: l.minutes, actual_min: Math.round((now - Date.parse(l.ts)) / MIN * 10) / 10, verdict: l.role === 'inspector' ? verdict(pr) : null, via: 'notification' };
      head = endHead(rec);
    } else rec = { ev: 'prompt' };
  } else if (ev === 'Stop') {
    add({ ev: 'stop' });
    return;
  } else if (ev === 'PostToolUse' && /^(Agent|Task)$/.test(input.tool_name || '')) {
    const ti = input.tool_input || {};
    const rm = ROLE_RE.exec(String(ti.subagent_type || ''));
    if (!rm) return;
    const c = control(ti.prompt);
    const resp = input.tool_response || {};
    const ms = Number(resp.totalDurationMs) || null;
    if (!ms && (ti.run_in_background || /async/i.test(String(resp.status || '')))) {
      // バックグラウンドの起動: 終わりは、あとの報告の知らせで記録する。ここでは起動だけを記録し、知らせない
      const id = resp.agentId || (/agentId:\s*([A-Za-z0-9]+)/.exec(JSON.stringify(resp)) || [])[1] || null;
      add({ ev: 'agent_launch', agent_id: id, role: rm[2], task: c.task, step: c.step, unit: c.unit, minutes: c.minutes });
      return;
    }
    rec = { ev: 'agent_end', agent_id: resp.agentId || null, role: rm[2], task: c.task, step: c.step, unit: c.unit, minutes: c.minutes, actual_min: ms ? Math.round(ms / MIN * 10) / 10 : null, verdict: rm[2] === 'inspector' ? verdict(resp) : null };
    head = endHead(rec);
  } else return;
  const rows = all.concat([{ ...rec, ts: new Date(now).toISOString() }]);
  const start = Date.parse(all.find((r) => r.ev === 'start').ts);
  const work = workMs(rows, now);
  const ap = readLines(path.join(state, 'approvals.jsonl')).filter((r) => r.operation === cur.op);
  const holder = [...ap].reverse().find((r) => ['plan', 'milestone', 'accept'].includes(r.kind) && r.copy) || null;
  const copy = holder ? holder.copy : null;
  const lim = body(cur.text, '### 起動の上限') || '';
  const deadline = copy ? copy.deadline : ((lim.split('\n').find((l) => /^\s*期限\s*[:：]/.test(l)) || '').replace(/^\s*期限\s*[:：]\s*/, '') || null);
  const left = remainMin(deadline, now, work);
  let t = `時計: ${fmt(now)}。${head}${cur.op} は開始から ${mins(now - start)}分(作業 ${mins(work)}分)。`;
  if (left !== null) t += `期限まで ${left}分`;
  const tips = [];
  if (copy) {
    const est = remainingEstimate(copy, rows.filter((r) => r.ev === 'agent_end'));
    if (left !== null) {
      const slackLeft = left - est;
      t += `、残りの見込み ${est}分、余りの残り ${slackLeft}分${copy.slack != null ? `(認めた余り ${copy.slack}分)` : ''}。`;
      if (slackLeft < 0) tips.push('このままでは期限に間に合いません。残すものと捨てるものを添えて、いま伺ってください。');
      else if (copy.slack != null && slackLeft < copy.slack / 2) tips.push('遅れの見込みです。時程を引き直し、指揮官に知らせてください。');
    } else t += `残りの見込み ${est}分。`;
  } else {
    if (left !== null) t += '。';
    const pt = num(/計画の持ち時間\s*[:：]\s*(\d+)\s*分/, body(cur.text, '### 時程'));
    if (pt !== null) {
      t += `計画の持ち時間は残り ${pt - mins(work)}分。`;
      if (mins(work) > pt) tips.push('計画の持ち時間を超えました。いまある最良の案で、決心を求めてください。');
    }
  }
  const n = new Set(readLines(path.join(state, 'launches.jsonl')).filter((r) => r.operation === cur.op).map((r, i) => r.agent_id || `#${i}`)).size;
  const ll = copy ? copy.launch_limit : num(/^\s*(\d+)/, lim);
  t += ll ? `起動 ${n}/${ll}回。` : `起動 ${n}回。`;
  const text = [t, ...tips].join('');
  add({ ...rec, notice: text });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: text } }));
}

try { main(); } catch { /* 作戦を止めない */ }
process.exitCode = 0;
