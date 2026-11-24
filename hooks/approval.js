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

// ---------------------------------------------------------------- 0.5.0 の道(作戦記録に「### 時程」の欄がある作戦)
// 承認は state/approvals.jsonl に1行ずつ足す(goals、plan、milestone。offer、accept、cancel、claim は guard.js が足す)。
// 計画の決心と記録し直しの行には、指紋と、計画の控え(起動の上限、点検の上限、期限、時程の余りと刻み、手順と点検の単位の持ち時間)を入れる。
// 道は、状態ファイルではなく作戦記録の形で分ける(途中の「承認」で道が替わらないため)
function hasTimetable(text) {
  return typeof text === 'string' && fpLines(text).some((l) => l.trim() === '### 時程');
}
function readRows(root, operation) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(root, AHQ, 'state', 'approvals.jsonl'), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    try { const r = JSON.parse(line); if (r && typeof r === 'object' && r.operation === operation) rows.push(r); } catch { /* 壊れた行は飛ばす */ }
  }
  return rows;
}
const lastOf = (rows, kinds) => { for (let i = rows.length - 1; i >= 0; i--) if (kinds.includes(rows[i].kind)) return rows[i]; return null; };
const minutesOf = (s) => { const m = /持ち時間\s*[:：]\s*(\d+)\s*分/.exec(s); return m ? parseInt(m[1], 10) : null; };
// 計画書の見出し(【手順】など)の中の行。見出しの行の残りも1行目として扱う
function block(lines, head) {
  const i = lines.findIndex((l) => l.trimStart().startsWith(head));
  // 見出しが無い計画(実地で見た書き方)は、計画の節の全体から、手順と点検の単位の行を拾う
  if (i < 0) return lines.map((l) => l.trim().replace(/^(?:[-*+]\s+|・\s*)/, '').replace(/^\*\*|\*\*$/g, '')).filter(Boolean);
  const out = [lines[i].trimStart().slice(head.length)];
  for (let j = i + 1; j < lines.length && !/^\s*【[^】]*】/.test(lines[j]); j++) out.push(lines[j]);
  return out.map((l) => l.trim().replace(/^(?:[-*+]\s+|・\s*)/, '')).filter(Boolean);
}
const stepNo = (s) => s.replace(/\s+/g, '');
// 「手順2〜4」「手順1、2」「手順3、手順5」の書き方から、手順の番号を拾う
function numList(s) {
  const out = [];
  for (const g of String(s).matchAll(/手順\s*([\d\s、,，〜~～ー-]+)/g)) {
    for (const part of g[1].split(/[、,，\s]+/).filter(Boolean)) {
      const r = /^(\d+)[〜~～ー-](\d+)$/.exec(part);
      if (r) { for (let k = +r[1]; k <= +r[2] && k - r[1] < 50; k++) out.push(String(k)); } else if (/^\d+$/.test(part)) out.push(part);
    }
  }
  return [...new Set(out)];
}
// 計画の控え。読み取れない行があれば { bad: [行] }
function planCopy(text) {
  const lines = fpLines(fpBody(fpLines(text), '## 計画', FP_SECTION_END) || '');
  const steps = []; const units = []; const bad = [];
  for (const l of block(lines, '【手順】')) {
    const m = /^手順\s*(\d+(?:\s*の\s*\d+)?)/.exec(l);
    if (!m) continue;
    const r = /担当\s*[:：]\s*([A-Za-z:-]+)/.exec(l);
    const min = minutesOf(l);
    const risk = (/危険度\s*[:：]\s*(高|中|低)/.exec(l) || [])[1];
    if (min === null || !risk) { bad.push(l); continue; }
    steps.push({ step: stepNo(m[1]), role: r ? r[1].replace(/^ai-headquarters:/, '') : null, minutes: min, risk });
  }
  let milestones = []; let floor = 3;
  for (const l of block(lines, '【点検と節目】')) {
    const ms = /^節目\s*[:：]\s*(.*)$/.exec(l);
    if (ms) { milestones = numList(ms[1]); continue; }
    const fl = /^節目の下限\s*[:：][^\d]*(\d+)/.exec(l);
    if (fl) { floor = Math.min(9, Math.max(1, parseInt(fl[1], 10))); continue; }
    const m = /^単\s*(\d+)/.exec(l);
    if (!m) continue;
    const min = minutesOf(l);
    if (min === null) { bad.push(l); continue; }
    const redo = /直しと再点検[^:：]*[:：]\s*(\d+)\s*分/.exec(l);
    units.push({ unit: `単${m[1]}`, minutes: min, steps: numList(l.split(/持ち時間/)[0].replace(/^単\s*\d+/, '')), redo: redo ? parseInt(redo[1], 10) : null });
  }
  if (!steps.length && !bad.length) bad.push('(計画に、「手順1 担当: unit。危険度: 中。持ち時間: 20分。」のように、行の初めが「手順」と番号の行が1つもありません。手順の行の初めを、この形にしてください)');
  if (bad.length) return { bad };
  const all = fpLines(text);
  const lim = fpBody(all, '### 起動の上限', FP_FIELD_END);
  const dl = lim ? lim.split('\n').find((x) => /^\s*期限\s*[:：]/.test(x)) : null;
  const tt = fpBody(all, '### 時程', FP_FIELD_END) || '';
  const num = (re, s) => { const m = re.exec(s || ''); return m ? parseInt(m[1], 10) : null; };
  return {
    copy: {
      launch_limit: launchLimitOf(text),
      inspect_limit: num(/点検の上限\s*[:：][^\d\n]*(\d+)\s*回/, fpBody(all, '### 点検の物差し', FP_FIELD_END)),
      deadline: dl ? dl.replace(/^\s*期限\s*[:：]\s*/, '').trim() : null,
      slack: num(/^\s*余り\s*[:：]\s*(\d+)\s*分/m, tt),
      tick: num(/^\s*刻み\s*[:：]\s*(\d+)\s*分/m, tt),
      steps, units, milestones, floor,
    },
  };
}
function say(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
}
function mainV5(root, input, operation, log) {
  const rows = readRows(root, operation);
  const me = input.session_id;
  let holder = lastOf(rows, ['plan', 'milestone', 'accept']);
  let inherited = false;
  const fpNow = fingerprintOf(log);
  // 引き継ぎ待ち(別のセッションの offer。あとに accept も cancel も無い)が残っていれば、まず受け継ぐ(12.14)。
  // そのあとの「承認」は、引き継いだセッションの「承認」として記録し直す。unit の起動より先に節目の「承認」が来たときのため。
  // 引き継いだあと unit の前に計画を書き換えていても(指紋が offer と違っても)受け継ぎ、いまの指紋で記録し直す。指揮官は書き換えた計画を見て
  // 「承認」と入力しているので、unit に要る「承認」は残る(第3段の実地で、目標の決心に倒れて「承認」が1回増えた)
  const ho = lastOf(rows, ['offer', 'accept', 'cancel']);
  if (holder && holder.session_id !== me && ho && ho.kind === 'offer' && ho.session_id !== me) {
    const acc = { ts: new Date().toISOString(), session_id: me, operation, kind: 'accept', fingerprint: ho.fingerprint, copy: holder.copy };
    fs.mkdirSync(path.join(root, AHQ, 'state'), { recursive: true });
    fs.appendFileSync(path.join(root, AHQ, 'state', 'approvals.jsonl'), `${JSON.stringify(acc)}\n`);
    rows.push(acc);
    holder = acc;
    inherited = true;
  }
  let kind;
  if (holder && holder.session_id === me) kind = 'milestone';
  else if (rows.some((r) => r.kind === 'goals' && r.session_id === me)) kind = 'plan';
  else if (!holder && goalsDecidedInLog(log)) kind = 'plan';
  else if (rows.some((r) => r.kind === 'claim' && r.session_id === me) && lastOf(rows, ['plan', 'milestone']) && lastOf(rows, ['plan', 'milestone']).fingerprint === fpNow) kind = 'plan';
  else kind = 'goals';
  const ts = new Date().toISOString();
  const rec = { ts, session_id: me, operation, kind };
  if (kind !== 'goals') {
    if (!planWritten(log)) {
      say(`${operation} の「## 計画」に計画書が書かれていない(節が無い、空、または「未作成」)ため、計画の決心として記録していません。計画を作戦記録に書いてから、もう一度『承認』と入力してもらってください。`);
      return;
    }
    const pc = planCopy(log);
    if (pc.bad) {
      say(`${operation} の計画に、持ち時間か危険度を読み取れない行があるため、「承認」を記録していません。次の行を「手順3 担当: unit。危険度: 中。持ち時間: 20分。」「単2 手順2〜4 のあと。持ち時間: 10分。」の形に直し、指揮官に示して、もう一度『承認』と入力してもらってください。\n${pc.bad.map((b) => `- ${b}`).join('\n')}`);
      return;
    }
    rec.fingerprint = fpNow;
    rec.copy = pc.copy;
  }
  fs.mkdirSync(path.join(root, AHQ, 'state'), { recursive: true });
  fs.appendFileSync(path.join(root, AHQ, 'state', 'approvals.jsonl'), `${JSON.stringify(rec)}\n`);
  if (kind === 'goals') {
    say(`指揮官の承認を、目標の決心として ${operation} に記録しました。unit はまだ起動できません。作戦記録の「### 目標の決心」の次の行を「承認: 」と日時に書き換え、計画を作戦記録の「## 計画」に書いて示し、改めて「承認」とだけ入力してもらってください。(別のセッションで続けている作戦なら、作戦記録の「### 引き継ぎ」に「受け継ぎの申し出: 」の行を書いてから「承認」を受けると、計画の決心として記録されます。)`);
  } else if (kind === 'milestone') {
    const prevFp = lastOf(rows, ['plan', 'milestone', 'accept']).fingerprint;
    let t = `${inherited ? `引き継ぎ待ちの ${operation} の承認を、このセッションに引き継ぎました。` : ''}指揮官の承認を、${operation} に記録し直しました(指紋 ${fpNow})。作戦記録の「### 計画の決心」に「承認: 日時(指紋 ${fpNow})」を足してください。このあと、目標の3つの欄か計画の節を書き換えると、unit を起動できなくなります。`;
    if (prevFp && prevFp !== fpNow) t += `前の承認の指紋(${prevFp})と違います。目標の3つの欄か計画の節が書き換えられています。書き換えた点を指揮官に示していなければ、いま示してください。`;
    say(t);
  } else {
    say(`指揮官の承認を、計画の決心として ${operation} に記録しました(指紋 ${fpNow})。作戦記録の「### 計画の決心」に「承認: 日時(指紋 ${fpNow})」と書いてください。承認のあとに、目標の3つの欄(必成目標、点検の物差し、起動の上限)か計画の節を書き換えると、unit を起動できなくなります(「### 時程」の引き直しは止まりません)。`);
  }
}

// ---------------------------------------------------------------- 書き込みのあと(PostToolUse の Edit、Write、MultiEdit。引数 post)
// メインセッションが最新の作戦記録(「### 時程」のある作戦)を書き換えたあとに、次の2つを行う。どちらも止めない。
// 1. 「### 引き継ぎ」の欄に新しく足された「引き継ぎ待ち: 」「受け継ぎの申し出: 」の行から、offer と claim を足す(12.14)。
//    書き込みが済んだあとで、old_string に無く new_string で増えた行だけを数える(点検の指摘2)
// 2. 計画、時程、点検の物差しを書き換えたときは、「承認」と同じ読み取りをして、読めない行と、時程に合わない点検の上限を知らせる
//    (指揮官が「承認」を入れる前に直せるようにするため。第1段の実地で、読めない計画のために入力が2回増えた)
const HOLD = ['plan', 'milestone', 'accept'];
function redoOf(u, steps) {
  if (u.redo != null) return u.redo;
  return Math.round(u.minutes + steps.filter((s) => u.steps.includes(String(s.step).split('の')[0])).reduce((a, s) => a + s.minutes, 0) / 2);
}
function planNotes(log) {
  const pc = planCopy(log);
  if (pc.bad) return [`計画に、持ち時間か危険度を読み取れない行があります。このままでは「承認」が記録されません。指揮官に示す前に、次の行を「手順3 担当: unit。危険度: 中。持ち時間: 20分。」「単2 手順2〜4 のあと。持ち時間: 10分。」の形に直してください。\n${pc.bad.map((b) => `- ${b}`).join('\n')}`];
  const c = pc.copy; const notes = [];
  if (c.slack == null) return ['「### 時程」の「余り: N分」を読み取れません。時程の行を「余り: 20分」の形で書いてください(点検の上限を、余りから決めるため)。'];
  const n = c.units.length;
  if (!n) return notes;
  const redo = c.units.reduce((a, u) => a + redoOf(u, c.steps), 0) / n;
  const fit = 1 + Math.min(2, Math.floor(c.slack / n / Math.max(1, redo)));
  if (c.inspect_limit != null && c.inspect_limit > fit) notes.push(`時程に合わせると、点検の上限は ${fit}回です(1 に、余り ${c.slack}分 ÷ 点検の単位 ${n}つ ÷ 直しと再点検1回 ${Math.round(redo)}分 の切り捨て、2まで、を足す)。いまの「点検の上限: ${c.inspect_limit}回」を ${fit}回に改めるか、改めない理由を、計画の決心を求める報告に書いてください。`);
  const unitSum = c.units.reduce((a, u) => a + u.minutes, 0);
  if (n > 1 && c.slack < unitSum) notes.push(`余り ${c.slack}分が、点検の単位 ${n}つの持ち時間の合計 ${unitSum}分より短いです。危険度が低の手順の点検を最後にまとめ、点検の単位を減らすことを考えてください。`);
  return notes;
}
// 振り返り(0.5.0。10.6): 作戦記録の「## 振り返り」の「次の見積もり:」の行。雛形のままなら null
const REVIEW_HINT = '次の作戦の時程に引く数字';
function reviewLine(text) {
  const body = fpBody(fpLines(text), '## 振り返り', FP_SECTION_END);
  const l = (body || '').split('\n').map((x) => x.trim()).find((x) => /^次の見積もり\s*[:：]/.test(x));
  if (!l || l.includes(REVIEW_HINT)) return null;
  const v = l.replace(/^次の見積もり\s*[:：]\s*/, '');
  return v === '' || /^(なし|未記入)/.test(v) ? null : v.slice(0, 200);
}
// latest より前の作戦記録のうち、「次の見積もり」が書かれた最も新しいもの
function lastReview(root, latest) {
  let nums = [];
  try { nums = fs.readdirSync(path.join(root, AHQ, 'operations')).map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean).map((m) => parseInt(m[1], 10)); } catch { return null; }
  for (const n of nums.filter((x) => x < latest).sort((a, b) => b - a)) {
    const v = reviewLine(readOperation(root, n));
    if (v) return { op: `OP-${String(n).padStart(3, '0')}`, text: v };
  }
  return null;
}

function mainPost(input) {
  if (!/^(Edit|Write|MultiEdit)$/.test(String(input.tool_name || '')) || input.agent_id) return;
  const root = path.resolve(String(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
  const latest = latestOperation(root);
  if (latest === null) return;
  const dir = path.join(root, AHQ, 'operations');
  const name = fs.readdirSync(dir).find((n) => { const m = /^OP-(\d+)\.md$/i.exec(n); return m && parseInt(m[1], 10) === latest; });
  const ti = input.tool_input || {};
  const target = path.resolve(root, String(ti.file_path || ''));
  if (!name || target.toLowerCase() !== path.join(dir, name).toLowerCase()) return;
  const log = readOperation(root, latest);
  if (!hasTimetable(log)) return;
  const operation = `OP-${String(latest).padStart(3, '0')}`;
  const pick = (k) => [ti[k], ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e && e[k]) : [])].filter((x) => typeof x === 'string').join('\n');
  const before = new Set(pick('old_string').split(/\r?\n/).map((l) => l.trim()));
  const added = `${pick('new_string')}\n${typeof ti.content === 'string' ? ti.content : ''}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !before.has(l));
  const field = new Set((fpBody(fpLines(log), '### 引き継ぎ', FP_FIELD_END) || '').split('\n').map((l) => l.trim()));
  const has = (re) => added.some((l) => re.test(l.replace(/^[-*]\s*/, '')) && field.has(l));
  const me = input.session_id;
  const rows = readRows(root, operation);
  const fpNow = fingerprintOf(log);
  const append = (rec) => { fs.mkdirSync(path.join(root, AHQ, 'state'), { recursive: true }); fs.appendFileSync(path.join(root, AHQ, 'state', 'approvals.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), session_id: me, operation, ...rec })}\n`); };
  if (typeof me === 'string' && me !== '') {
    const h = lastOf(rows, HOLD);
    if (has(/^引き継ぎ待ち\s*[:：]/) && h && h.session_id === me && h.fingerprint === fpNow) append({ kind: 'offer', fingerprint: fpNow });
    if (has(/^受け継ぎの申し出\s*[:：]/)) append({ kind: 'claim', fingerprint: fpNow });
  }
  const out = [];
  // 新しい作戦記録を作ったら(Write)、直近の作戦の振り返りの数字を知らせる。作戦を終える(「## 結果」を書き換えた)のに振り返りが雛形のままなら知らせる
  if (input.tool_name === 'Write') {
    const r = lastReview(root, latest);
    if (r) out.push(`AI司令部(振り返り。止めません): 振り返りのある直近の作戦 ${r.op} の「次の見積もり」は「${r.text}」です。時程の見積もりに、この数字を使ってください。使わないときは、理由を「### 時程」に1行で書いてください。`);
  }
  const lines = fpLines(log);
  const res = (fpBody(lines, '## 結果', FP_SECTION_END) || '').split('\n').map((l) => l.trim()).find((l) => l !== '') || '';
  if (res !== '' && !res.startsWith('未完了') && added.includes(res) && !reviewLine(log)) out.push('AI司令部(振り返り。止めません): 「## 振り返り」の「次の見積もり」が、まだ書かれていません。時計の知らせの実測から埋めてから、最終報告をしてください。');
  // 計画、時程、点検の物差しの行を書き換えたときだけ確かめる。承認した計画のままなら、確かめない
  const notes = (() => {
  const watched = new Set(['## 計画', '### 時程', '### 点検の物差し'].flatMap((hd) => (fpBody(lines, hd, hd.startsWith('### ') ? FP_FIELD_END : FP_SECTION_END) || '').split('\n').map((l) => l.trim())).filter(Boolean));
  if (!planWritten(log) || !added.some((l) => watched.has(l))) return [];
  const h = lastOf(rows, HOLD);
  if (h && h.fingerprint === fpNow) return [];
  return planNotes(log);
  })();
  if (notes.length) out.push(`AI司令部(計画の確かめ。止めません): ${notes.join('\n')}`);
  if (out.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: out.join('\n') } }));
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (process.argv[2] === 'post') { mainPost(input); return; }
  // 指揮官以外の出どころ(サブエージェントの報告の知らせは <task-notification> で始まる)は、完全一致で落ちる
  if (!isApproval(input.prompt)) return;
  if (typeof input.session_id !== 'string' || input.session_id === '') return;
  const root = path.resolve(String(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
  const latest = latestOperation(root);
  if (latest === null) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '作戦記録が無いため、承認は記録していません。小規模の作業ならこのまま進めてください。中規模以上の作戦なら、作戦記録を作ってから、もう一度「承認」と入力してもらってください。' } }));
    return;
  }
  const operation = `OP-${String(latest).padStart(3, '0')}`;
  const v5log = readOperation(root, latest);
  if (hasTimetable(v5log)) { mainV5(root, input, operation, v5log); return; }
  // ---------------------------------------------------------------- 0.4.1 の道(「### 時程」の無い作戦記録。終わるまでこの道で動かす)
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
