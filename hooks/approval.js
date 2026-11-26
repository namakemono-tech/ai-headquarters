'use strict';
// 承認の記録(0.6.0。設計書 4.2)。道は1本(state/approvals.jsonl)。
// UserPromptSubmit: 指揮官の「承認」だけを、最新の作戦記録に結び付けて1行足す(goals、plan、milestone。accept もここで足すことがある)。
//   目標の決心と計画の決心を分けて記録する(K35)。迷ったら止める側(目標の決心)に倒す。
//   計画の決心と記録し直しの行には、「## 目標」と「## 方針」の2つの指紋を入れ、作戦記録の「## 承認」の節に1行書き足す。
// PostToolUse(引数 post): メインセッションが作戦記録の「## いま」に足した「引き継ぎ待ち: 」「受け継ぎの申し出: 」から、offer と claim を足す(K75)。
// どんな入力でも指揮官の発言と作業を止めない(異常は握りつぶして exit 0)。
const fs = require('node:fs');
const path = require('node:path');

const AHQ = '.ai-headquarters';

// 0.5.0 までの形の作戦記録の移し方(guard.js と同じ文)
const MIGRATE = (op) => `書き直すより、次の形で移すことを勧めます。(1) ${op} の「## 結果」の最初の行を、ここまでの結果と「残りは次の作戦に移す」に書き換えて閉じる。(2) 残りの仕事を、次の番号の作戦記録として新しい雛形(mission-analysis の「作戦記録」の章。見出し9つ)で立て、「## 企図」に「経過: ${op}(0.5.0 の形の記録)」の1行だけを置く。(3) 新しい作戦の目標と方針を、ふつうの作戦と同じく、目標の決心と計画の決心で指揮官に示し、それぞれ「承認」とだけ入力してもらう。`;

function latestOperation(root) {
  try {
    const nums = fs.readdirSync(path.join(root, AHQ, 'operations'))
      .map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean).map((m) => parseInt(m[1], 10));
    return nums.length ? Math.max(...nums) : null;
  } catch { return null; }
}
function opPath(root, latest) {
  try {
    const dir = path.join(root, AHQ, 'operations');
    const name = fs.readdirSync(dir).find((n) => { const m = /^OP-(\d+)\.md$/i.exec(n); return m && parseInt(m[1], 10) === latest; });
    return name ? path.join(dir, name) : null;
  } catch { return null; }
}
function readOperation(root, latest) {
  const p = opPath(root, latest);
  try { return p ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}
// ---- 指紋(ここから。0.6.0。approval.js と guard.js に一字も違わず同じものを書く。直すときは両方を直す)
// 指紋は2つ。目標の指紋は「## 目標」の節、方針の指紋は「## 方針」の節から取る。節の見出しは行の全体が「## 目標」(前後の空白は可)。
// 節の本文は、次の「## 」で始まる行の前まで(「### 」の行は含む)。最初に見つけたものを使う。
// 本文の前後の空行を除き、行末の空白と改行の種類をそろえてから計算する。節が無いときは、空として計算する。
function fpLines(text) {
  return String(text == null ? '' : text).replace(/^﻿/, '').split(/\r\n|\r|\n/).map((l) => l.replace(/[ \t　]+$/, ''));
}
function fpBody(lines, heading) {
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^##(?!#)/.test(lines[j].trimStart())) j++;
  const body = lines.slice(i + 1, j);
  while (body.length && body[0] === '') body.shift();
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}
const fpHash = (s) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
function fingerprints(text) {
  const lines = fpLines(text);
  return { fp_goals: fpHash(`## 目標\n${fpBody(lines, '## 目標') || ''}`), fp_policy: fpHash(`## 方針\n${fpBody(lines, '## 方針') || ''}`) };
}
const sameFp = (a, b) => !!a && !!b && a.fp_goals === b.fp_goals && a.fp_policy === b.fp_policy;
// 「## 方針」が書かれているか(節があり、空でなく、「未作成」で始まらず、雛形の括弧書きの1行だけでもない)
function policyWritten(text) {
  const b = (fpBody(fpLines(text), '## 方針') || '').trim();
  return b !== '' && !b.startsWith('未作成') && !/^[(（][^\n]*[)）]$/.test(b);
}
// ---- 指紋(ここまで)

// 「## 承認」の節の「目標の決心: 」の行の語(承認、修正、省略、未決心)。読めなければ null
function goalDecision(text) {
  const b = fpBody(fpLines(text), '## 承認');
  const l = (b || '').split('\n').map((x) => x.trim()).find((x) => /^目標の決心\s*[:：]/.test(x));
  const m = l ? /^目標の決心\s*[:：]\s*(承認|修正|省略|未決心)/.exec(l) : null;
  return m ? m[1] : null;
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
const HOLD = ['plan', 'milestone', 'accept'];
const lastOf = (rows, kinds) => { for (let i = rows.length - 1; i >= 0; i--) if (kinds.includes(rows[i].kind)) return rows[i]; return null; };
function appendRow(root, rec) {
  fs.mkdirSync(path.join(root, AHQ, 'state'), { recursive: true });
  fs.appendFileSync(path.join(root, AHQ, 'state', 'approvals.jsonl'), `${JSON.stringify(rec)}\n`);
}
// 作戦記録の「## 承認」の節の終わりに1行足す(節の外の書き換えなので、指紋は変わらない)。節が無ければ何もしない
function noteInLog(file, line) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim() === '## 承認');
    if (i < 0) return;
    let j = i + 1;
    while (j < lines.length && !/^##(?!#)/.test(lines[j].trimStart())) j++;
    while (j > i + 1 && lines[j - 1].trim() === '') j--;
    lines.splice(j, 0, line);
    fs.writeFileSync(file, lines.join(nl));
  } catch { /* 書けなくても、承認の記録は残す */ }
}
// 「## 結果」の次の行(空行を除く)が「未完了」で始まるか。欄が無い・読み取れないときは未完了とみなす(guard.js の resultPending と同じ)
function resultOpen(text) {
  if (typeof text !== 'string') return true;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s*結果\s*$/.test(l.trim()));
  if (i < 0) return true;
  for (let k = i + 1; k < lines.length; k++) {
    const t = lines[k].trim();
    if (!t) continue;
    if (/^#/.test(t)) return true;
    return t.startsWith('未完了');
  }
  return true;
}
function say(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}
const stamp = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// 前後の空白(全角を含む)と、末尾の「。」「!」「!」(半角・全角、複数可)を取り除く
function isApproval(prompt) {
  if (typeof prompt !== 'string') return false;
  const s = prompt.replace(/^[\s　﻿]+/, '').replace(/(?:[\s　﻿]|[。!！])+$/, '');
  return s === '承認';
}

function mainPrompt(input) {
  // 指揮官以外の出どころ(サブエージェントの報告の知らせは <task-notification> で始まる)は、完全一致で落ちる
  if (!isApproval(input.prompt)) return;
  const me = input.session_id;
  if (typeof me !== 'string' || me === '') return;
  const root = path.resolve(String(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
  const latest = latestOperation(root);
  if (latest === null) {
    say('UserPromptSubmit', '作戦記録が無いため、承認は記録していません。実行だけの依頼なら、このまま進めてください。簡易か完全の作戦なら、作戦記録を作ってから、もう一度「承認」と入力してもらってください。');
    return;
  }
  const operation = `OP-${String(latest).padStart(3, '0')}`;
  const file = opPath(root, latest);
  const log = readOperation(root, latest);
  // 閉じた作戦(「## 結果」の最初の行が「未完了」でない)には記録しない(T10 の重1。guard.js の resultPending と同じ見分け方)
  if (!resultOpen(log)) {
    say('UserPromptSubmit', `作戦記録 ${operation} は閉じている(「## 結果」が「未完了」ではない)ので、承認は記録していません。新しい仕事なら、次の番号の作戦記録を新しい雛形で作ってから、目標と方針を示し、もう一度「承認」と入力してもらってください。実行だけの依頼なら、このまま進めてください。`);
    return;
  }
  // 0.5.0 までの形の作戦記録は記録せずに、移し方を示す(guard.js と同じ見分け方と同じ文)
  if (!/^目標の決心\s*[:：]/m.test(String(log || '')) && (/^###\s*(時程|目標の決心|計画の決心)\s*$/m.test(String(log || '')) || /^##\s*計画\s*$/m.test(String(log || '')))) {
    say('UserPromptSubmit', `作戦記録 ${operation} は 0.5.0 までの形(「### 時程」や「## 計画」がある)なので、承認は記録していません。${MIGRATE(operation)}`);
    return;
  }
  const rows = readRows(root, operation);
  const fp = fingerprints(log);
  let holder = lastOf(rows, HOLD);
  let inherited = false;
  // 引き継ぎ待ち(別のセッションの offer。あとに accept も cancel も無い)が残っていれば、まず受け継ぐ。
  // 受け継いだあと unit の前に目標か方針を書き換えていても受け継ぎ、いまの指紋で記録し直す(指揮官は書き換えたものを見て「承認」と入力している)
  const ho = lastOf(rows, ['offer', 'accept', 'cancel']);
  if (holder && holder.session_id !== me && ho && ho.kind === 'offer' && ho.session_id !== me) {
    const acc = { ts: new Date().toISOString(), session_id: me, operation, kind: 'accept', fp_goals: ho.fp_goals, fp_policy: ho.fp_policy };
    appendRow(root, acc);
    rows.push(acc);
    holder = acc;
    inherited = true;
  }
  // 計画の決心とするのは、次のどれか。(4) 承認を持つセッションの「承認」(記録し直し)。(1) 同じセッションで目標の決心が記録済み。
  // (2) 「目標の決心: 」の行が「修正」か「省略」で、まだ誰も承認を持っていない。(3) 受け継ぎの申し出のあと(指紋が前の計画の決心と同じとき)。
  // どれでもなければ、目標の決心に倒す
  const lastPlan = lastOf(rows, ['plan', 'milestone']);
  let kind;
  if (holder && holder.session_id === me) kind = 'milestone';
  else if (rows.some((r) => r.kind === 'goals' && r.session_id === me)) kind = 'plan';
  else if (!holder && ['修正', '省略'].includes(goalDecision(log))) kind = 'plan';
  else if (rows.some((r) => r.kind === 'claim' && r.session_id === me) && sameFp(lastPlan, fp)) kind = 'plan';
  else kind = 'goals';
  const ts = new Date().toISOString();
  if (kind === 'goals') {
    appendRow(root, { ts, session_id: me, operation, kind });
    say('UserPromptSubmit', `指揮官の承認を、目標の決心として ${operation} に記録しました。unit はまだ起動できません。「## 承認」の「目標の決心: 」の行を「目標の決心: 承認 」と日時に書き換え、計画を「## 方針」に書いて示し、改めて「承認」とだけ入力してもらってください。(別のセッションで続けている作戦なら、「## いま」に「受け継ぎの申し出: 」の行を書いてから「承認」を受けると、計画の決心として記録されます。)`);
    return;
  }
  if (!policyWritten(log)) {
    say('UserPromptSubmit', `${operation} の「## 方針」が書かれていない(節が無い、空、または「未作成」)ため、計画の決心として記録していません。方針を作戦記録に書いて示してから、もう一度「承認」と入力してもらってください。`);
    return;
  }
  appendRow(root, { ts, session_id: me, operation, kind, ...fp });
  if (file) noteInLog(file, `計画の決心: 承認 ${stamp(ts)}(指紋 ${fp.fp_goals}/${fp.fp_policy})`);
  let t = `${inherited ? `引き継ぎ待ちの ${operation} の承認を、このセッションに引き継ぎました。` : ''}指揮官の承認を、${kind === 'plan' ? '計画の決心として' : ''} ${operation} に記録${kind === 'plan' ? '' : 'し直'}しました(指紋 ${fp.fp_goals}/${fp.fp_policy})。作戦記録の「## 承認」に1行書き足しました。このあと「## 目標」か「## 方針」を書き換えると、unit を起動できなくなります(ほかの節は変えてかまいません)。`;
  if (kind === 'milestone') {
    const prev = lastOf(rows, HOLD);
    if (prev && !sameFp(prev, fp)) t += '前の承認のあとで「## 目標」か「## 方針」が書き換えられています。書き換えた点を指揮官に示していなければ、いま示してください。';
  }
  say('UserPromptSubmit', t);
}

// ---------------------------------------------------------------- 書き込みのあと(PostToolUse の Edit、Write、MultiEdit。引数 post)
// メインセッションが最新の作戦記録の「## いま」に新しく足した「引き継ぎ待ち: 」「受け継ぎの申し出: 」の行から、offer と claim を足す。
// 書き込みが済んだあとで、old_string に無く new_string で増えた行だけを数える。止めない
function mainPost(input) {
  if (!/^(Edit|Write|MultiEdit)$/.test(String(input.tool_name || '')) || input.agent_id) return;
  const me = input.session_id;
  if (typeof me !== 'string' || me === '') return;
  const root = path.resolve(String(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
  const latest = latestOperation(root);
  if (latest === null) return;
  const file = opPath(root, latest);
  const ti = input.tool_input || {};
  if (!file || path.resolve(root, String(ti.file_path || '')).toLowerCase() !== file.toLowerCase()) return;
  const log = readOperation(root, latest);
  const operation = `OP-${String(latest).padStart(3, '0')}`;
  const pick = (k) => [ti[k], ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e && e[k]) : [])].filter((x) => typeof x === 'string').join('\n');
  const before = new Set(pick('old_string').split(/\r?\n/).map((l) => l.trim()));
  const added = `${pick('new_string')}\n${typeof ti.content === 'string' ? ti.content : ''}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !before.has(l));
  const field = new Set((fpBody(fpLines(log), '## いま') || '').split('\n').map((l) => l.trim()));
  // 「引き継ぎ待ち: なし」のような、中身の無い行は数えない(T10 の軽1)
  const real = (l, re) => { const t = l.replace(/^[-*]\s*/, ''); const m = re.exec(t); if (!m) return false; const rest = t.slice(m[0].length).trim().replace(/[。.]$/, ''); return rest !== '' && !/^(なし|無し|ない|無い|未定|-|—|―)$/.test(rest); };
  const has = (re) => added.some((l) => real(l, re) && field.has(l));
  const rows = readRows(root, operation);
  const fp = fingerprints(log);
  const base = { ts: new Date().toISOString(), session_id: me, operation, ...fp };
  const h = lastOf(rows, HOLD);
  if (has(/^引き継ぎ待ち\s*[:：]/) && h && h.session_id === me && sameFp(h, fp)) appendRow(root, { ...base, kind: 'offer' });
  if (has(/^受け継ぎの申し出\s*[:：]/)) appendRow(root, { ...base, kind: 'claim' });
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (process.argv[2] === 'post') mainPost(input);
  else mainPrompt(input);
}

try { main(); } catch { /* 指揮官の発言を止めない */ }
process.exitCode = 0;
