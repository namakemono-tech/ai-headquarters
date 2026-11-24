#!/usr/bin/env node
'use strict';
// AI司令部プラグイン: 統制(Hooks)のうち PreToolUse と SubagentStart を受け持つ単体ファイル。
// Node.js 22 以上、外部パッケージなし。イベント名(hook_event_name)で振り分ける。
//   PreToolUse   : 役割ごとの制限、保護パス、破壊的コマンド、作戦記録・設定・状態の保護、承認の関門、unit の予約と範囲
//   PreToolUse の Agent: 4体の起動の前に、起動の上限の8割で知らせ(systemMessage)、上限で確認を出す(0.4.0)。
//                        大規模では、前の「承認」のあと unit を3回起動したら、4回目の unit の起動を止める(節目の承認の下限)
//   SubagentStart: unit の予約を「実行中」に切り替える(予約が無ければ実行中の記録を作る)。4体の起動を、作戦ごとに数える(0.4.0。失敗しない)
// PreToolUse で内部エラーが起きたときは、理由を標準エラーに出して exit 2(止める側に倒す)。

const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';
const AHQ = '.ai-headquarters';
const ROLE_RE = /^(ai-headquarters:)?(intel|plans|unit|inspector)$/;
const UNIT_RE = /^(ai-headquarters:)?unit$/;
const SUFFIX = '別の手段で同じことを試さず、『未解決』として報告してください';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const RESERVE_TTL_MS = 2 * 60 * 1000;
const RUNNING_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------- 基本部品

// Windows と Mac の標準のファイルシステムは、大文字・小文字を区別しない。Linux は区別する
const CASE_INSENSITIVE = WIN || process.platform === 'darwin';
const lc = (s) => (CASE_INSENSITIVE ? String(s).toLowerCase() : String(s));
const toPosix = (s) => String(s).replace(/\\/g, '/');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function atomicWrite(p, obj) {
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 無視 */ } throw e; }
}

// ---- グロブ(正規表現を使わず、区間ごとに照合する。メモ化により計算量は パターン数 x パス段数)

// 1段(区間)の中の * と ? の照合
function segGlob(p, s) {
  let pi = 0; let si = 0; let star = -1; let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== '*' && (p[pi] === '?' || p[pi] === s[si])) { pi++; si++; } else if (pi < p.length && p[pi] === '*') { star = pi++; mark = si; } else if (star >= 0) { pi = star + 1; si = ++mark; } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// グロブを区間の並びにする。連続する ** は1つにまとめる
function compileGlob(g) {
  const segs = [];
  for (let s of toPosix(g).split('/')) {
    if (!s) continue;
    if (s !== '**' && s.includes('**')) s = s.replace(/\*{2,}/g, '*');
    if (s === '**' && segs[segs.length - 1] === '**') continue;
    segs.push(s);
  }
  return segs;
}

// P: パターンの区間、S: パスの区間。tail が true なら、パターンの後ろにパスが余ってもよい(フォルダの中)
function globPath(P, S, tail) {
  const memo = new Map();
  const f = (pi, si) => {
    if (pi === P.length) return tail || si === S.length;
    const k = pi * (S.length + 1) + si;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (P[pi] === '**') r = f(pi + 1, si) || (si < S.length && f(pi, si + 1));
    else r = si < S.length && segGlob(P[pi], S[si]) && f(pi + 1, si + 1);
    memo.set(k, r);
    return r;
  };
  return f(0, 0);
}

function cleanSeg(seg) {
  // Windows では末尾のドット・空白と代替データストリームが無視される
  return WIN ? seg.replace(/:.*$/, '').replace(/[. ]+$/, '') : seg;
}

// 作業の前提(プロジェクトの最上位、作業ディレクトリ)
function makeBase(input) {
  const rootRaw = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let root = path.posix.normalize(toPosix(rootRaw));
  if (root.length > 1) root = root.replace(/\/+$/, '');
  let cwd = input.cwd ? path.posix.normalize(toPosix(input.cwd)) : root;
  if (cwd.length > 1) cwd = cwd.replace(/\/+$/, '');
  return { root, rootC: lc(root), cwd, rootNative: path.resolve(String(rootRaw)) };
}

// パスを絶対・正規化し、プロジェクトの最上位からの相対パスを求める
function resolvePath(p, base) {
  let s = toPosix(p).trim().replace(/^["'`@]+|["'`;]+$/g, '');
  if (WIN) {
    s = s.replace(/^\/\/\?\//, '');
    s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, (m, d) => d.toUpperCase() + ':');
  }
  const isAbs = /^[a-zA-Z]:(\/|$)/.test(s) || s.startsWith('/');
  if (!isAbs) s = base.cwd + '/' + s;
  s = path.posix.normalize(s);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  const sc = lc(s);
  let relC = null;
  if (sc === base.rootC) relC = '';
  else if (sc.startsWith(base.rootC + '/')) relC = sc.slice(base.rootC.length + 1);
  if (relC !== null) relC = relC.split('/').map(cleanSeg).join('/');
  const segs = (relC !== null ? relC : sc).split('/').map(cleanSeg).filter(Boolean);
  return { abs: s, relC, inside: relC !== null, segs, base: segs.length ? segs[segs.length - 1] : '' };
}

// ---------------------------------------------------------------- 設定と保護パス

function loadConfig(root) {
  const raw = readJsonSafe(path.join(root, AHQ, 'config.json'));
  const arr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()) : []);
  const o = raw && typeof raw === 'object' ? raw : {};
  const p = o.protect && typeof o.protect === 'object' ? o.protect : {};
  const i = o.inspector && typeof o.inspector === 'object' ? o.inspector : {};
  return {
    protectAdd: arr(p.add), protectExclude: arr(p.exclude),
    testCommands: arr(i.testCommands), allowedOptions: arr(i.allowedOptions),
  };
}

// .gitignore に近い書き方のパターン
function compilePattern(raw) {
  let p = toPosix(raw).trim();
  if (!p) return null;
  p = p.replace(/^\.\//, '');
  const dir = p.endsWith('/');
  if (dir) p = p.replace(/\/+$/, '');
  const anchored = p.includes('/');
  p = lc(p.replace(/^\//, ''));
  if (!p) return null;
  const segs = compileGlob(p);
  if (!segs.length) return null;
  return { dir, anchored, segs, name: segs[0].replace(/\*{2,}/g, '*') };
}

function matchPattern(pat, info) {
  if (!pat.anchored) {
    if (pat.dir) return info.segs.some((s) => segGlob(pat.name, s));
    return segGlob(pat.name, info.base);
  }
  return info.relC !== null && globPath(pat.segs, info.segs, true);
}

const DEFAULT_PROTECT = [
  '.env', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', 'id_rsa*', 'id_ed25519*', '.npmrc', '.netrc', 'secrets.toml',
  'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'secrets.json', 'secrets.yml', 'secrets.yaml', '.secrets',
].map(compilePattern);
// ZIP版では統制のスクリプトと登録がプロジェクトの中に入る(ZIP 版の .claude/ の保護)。最上位からの相対パスで照合する。
// 秘密のファイルと違い、書き込みだけを保護する(読み取りは通す)
const WRITE_PROTECT = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/ai-headquarters/'].map(compilePattern);
const BUILTIN_EXCLUDE = ['.env.example', '.env.sample', '.env.template'].map(compilePattern);

function makeProtector(cfg) {
  const add = cfg.protectAdd.map(compilePattern).filter(Boolean);
  const exc = cfg.protectExclude.map(compilePattern).filter(Boolean);
  return (info, readOnly = false) => {
    const hit = add.some((m) => matchPattern(m, info)) ||
      (DEFAULT_PROTECT.some((m) => matchPattern(m, info)) && !BUILTIN_EXCLUDE.some((m) => matchPattern(m, info))) ||
      (!readOnly && WRITE_PROTECT.some((m) => matchPattern(m, info)));
    return hit && !exc.some((m) => matchPattern(m, info));
  };
}

// .ai-headquarters/ の中での位置づけ(除外では外せない固定の保護)
function ahqKind(info) {
  if (!info.inside) return null;
  const r = info.relC;
  if (r === AHQ) return 'root';
  if (!r.startsWith(AHQ + '/')) return null;
  const sub = r.slice(AHQ.length + 1);
  if (sub === 'config.json') return 'config';
  if (sub === 'state' || sub.startsWith('state/')) return 'state';
  if (sub === 'operations' || sub.startsWith('operations/')) return 'ops';
  return 'other';
}

// cd の行き先が分からないとき、相対パスの末尾の形だけで .ai-headquarters/ の中かもしれないと見なす
function looseKind(t) {
  if (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('\\')) return null;
  const p = lc(toPosix(t)).replace(/^(?:\.\.?\/)+/, '').replace(/\/+$/, '');
  if (p === 'state' || p.startsWith('state/')) return 'state';
  if (p === 'config.json') return 'config';
  if (p === 'operations' || p.startsWith('operations/')) return 'ops';
  return null;
}

// ---------------------------------------------------------------- 判定の集約

class Verdict {
  constructor(ctx) { this.ctx = ctx; this.items = []; this.notices = []; this.contexts = []; }
  // 指揮官の画面への知らせ(止めない)
  notice(text) { this.notices.push(text); }
  // 幕僚長(サブエージェントの中なら、そのサブエージェント)への知らせ(止めない。0.5.0)
  context(text) { this.contexts.push(text); }
  _r(reason) {
    return this.ctx.role ? `${reason} ${SUFFIX}。` : reason;
  }
  deny(reason) { this.items.push({ d: 'deny', reason: this._r(reason) }); }
  ask(reason) {
    // bypassPermissions では確認の画面が出ないため、メインセッションへの確認は拒否に替える
    if (this.ctx.bypass) {
      this.items.push({ d: 'deny', reason: `${reason} bypassPermissions では確認の画面が出ないため、止めました。必要なら、権限モードを変えてから頼むか、指揮官が自分で行ってください。` });
      return;
    }
    this.items.push({ d: 'ask', reason });
  }
  // サブエージェントなら止め、メインセッションなら確認を出す
  denyOrAsk(reason) { if (this.ctx.isSub) this.deny(reason); else this.ask(reason); }
  allowUpdate(updatedInput) { this.items.push({ d: 'allow', updatedInput }); }
  result() {
    return this.items.find((x) => x.d === 'deny') || this.items.find((x) => x.d === 'ask') || this.items.find((x) => x.d === 'allow') || null;
  }
}

// ---------------------------------------------------------------- シェルの解析

// ヒアドキュメントの本文を取り除く(シェルに渡すものは本文も残す)。引用符の中の << は見ない
function stripHeredocs(s) {
  let out = '';
  let i = 0;
  const stack = [{ q: null }];
  let pending = [];
  while (i < s.length) {
    const c = s[i];
    const ctx = stack[stack.length - 1];
    if (c === '\n' && pending.length) {
      out += c; i++;
      for (const h of pending) {
        while (i < s.length) {
          const e = s.indexOf('\n', i);
          const line = s.slice(i, e < 0 ? s.length : e);
          i = e < 0 ? s.length : e + 1;
          const cmp = line.replace(/\r$/, '');
          if ((h.dash ? cmp.replace(/^\t+/, '').trim() : cmp) === h.word) break;
          if (h.keep) out += line + '\n';
        }
      }
      pending = [];
      continue;
    }
    if (ctx.q === "'") { if (c === "'") ctx.q = null; out += c; i++; continue; }
    if (ctx.q === '"') {
      if (c === '"') ctx.q = null;
      else if (c === '$' && s[i + 1] === '(') { stack.push({ q: null }); out += '$('; i += 2; continue; }
      out += c; i++; continue;
    }
    if (c === "'") { ctx.q = "'"; out += c; i++; continue; }
    if (c === '"') { ctx.q = '"'; out += c; i++; continue; }
    if (c === '$' && s[i + 1] === '(') { stack.push({ q: null }); out += '$('; i += 2; continue; }
    if (c === ')' && stack.length > 1) { stack.pop(); out += c; i++; continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z_][\w-]*))/.exec(s.slice(i, i + 200));
      if (m) {
        const ls = s.lastIndexOf('\n', i) + 1;
        const le = s.indexOf('\n', i);
        const lineText = s.slice(ls, le < 0 ? s.length : le);
        pending.push({
          dash: m[1] === '-', word: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4],
          keep: /\b(bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|python3?|node|perl|ruby|source|eval|ssh)\b/i.test(lineText),
        });
        out += m[0]; i += m[0].length;
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}

function scanSegments(s, literal) {
  const segs = [];
  let bad = -1;
  function run(start, term) {
    let i = start;
    let cur = ''; let q = null; let qs = -1; let depth = 0;
    const flush = () => { const t = cur.trim(); if (t) segs.push(t); cur = ''; };
    while (i < s.length) {
      const c = s[i];
      if (q) {
        if (c === q) { q = null; cur += c; i++; continue; }
        if (q === '"' && c === '$' && s[i + 1] === '(') { i = run(i + 2, ')'); cur += ' '; continue; }
        if (q === '"' && c === '`') { i = run(i + 1, '`'); cur += ' '; continue; }
        cur += c; i++; continue;
      }
      if ((c === "'" || c === '"') && !literal.has(i)) { q = c; qs = i; cur += c; i++; continue; }
      if (c === '$' && s[i + 1] === '(') { i = run(i + 2, ')'); cur += ' '; continue; }
      if (c === '`') {
        if (term === '`') { flush(); return i + 1; }
        i = run(i + 1, '`'); cur += ' '; continue;
      }
      if (c === ')' && term === ')' && depth === 0) { flush(); return i + 1; }
      if (c === '(') { flush(); depth++; i++; continue; }
      if (c === ')') { flush(); if (depth > 0) depth--; i++; continue; }
      if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '\r') { flush(); i++; continue; }
      cur += c; i++;
    }
    if (q && bad < 0) bad = qs;
    flush();
    return i;
  }
  run(0, null);
  return { segs, bad };
}

// コマンドを && || ; | & ( ) 改行 で区切る。引用符の中では区切らないが、$( ) とバッククォートの中身は別に取り出す
function splitSegments(cmd) {
  const s = stripHeredocs(String(cmd));
  const literal = new Set();
  let r = null;
  for (let n = 0; n < 30; n++) {
    r = scanSegments(s, literal);
    if (r.bad < 0) return r.segs;
    literal.add(r.bad); // 閉じていない引用符は、ただの文字として読み直す
  }
  return r.segs;
}

function stripQuotes(s) { return s.replace(/["'`]/g, ''); }

// リダイレクト・空白・, ・= で語に分け、引用符を外す
function tokenizeSeg(seg) {
  const tokens = [];
  const pieces = seg.split(/(>>|>|<)/);
  let mode = null;
  for (const piece of pieces) {
    if (piece === '>>' || piece === '>' || piece === '<') { mode = piece; continue; }
    const words = piece.split(/[\s=,]+/).map(stripQuotes).filter(Boolean);
    words.forEach((w, i) => tokens.push({ t: w, redir: i === 0 ? mode : null }));
    if (words.length) mode = null;
  }
  return tokens;
}

// 引用符を考慮した語の分割(位置つき)
function splitWordsPos(s) {
  const words = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let q = null;
    while (i < s.length) {
      const c = s[i];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (/\s/.test(c)) break;
      i++;
    }
    words.push({ raw: s.slice(start, i), start, end: i });
  }
  return words;
}

function unquoteWhole(s) {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

function normName(w) {
  return stripQuotes(w).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'xargs', 'nohup', 'time', 'command', 'exec', 'nice', 'timeout', 'call', 'start', 'stdbuf', 'setsid', 'ionice', 'builtin']);
const NONE = new Set();
const WRAP_VALOPTS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R', '-T']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S', '-P']),
  xargs: new Set(['-I', '-n', '-P', '-d', '-E', '-L', '-s', '-a', '-l']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
const SHELLS = { cmd: 'cmd', bash: 'posix', sh: 'posix', zsh: 'posix', dash: 'posix', ksh: 'posix', pwsh: 'ps', powershell: 'ps' };
const EVALS = new Set(['eval', 'invoke-expression', 'iex']);

// 1つの区切り(セグメント)から、実際に実行されるコマンドを求める。
// 包みはオプションと VAR=値 を飛ばし、直後の1語だけをコマンド名とする。シェルの -c などは中身の文字列(inner)を返す
function resolveWords(seg, words) {
  for (let n = 0; n < 10; n++) {
    let i = 0;
    while (i < words.length && ASSIGN.test(words[i].raw)) i++;
    words = words.slice(i);
    if (!words.length) return null;
    const name = normName(words[0].raw);
    if (WRAPPERS.has(name)) {
      const vo = WRAP_VALOPTS[name] || NONE;
      let k = 1; let dur = false;
      while (k < words.length) {
        const w = stripQuotes(words[k].raw);
        if (ASSIGN.test(w)) k++;
        else if (w === '--') { k++; break; } else if (w.length > 1 && w[0] === '-') k += vo.has(w) ? 2 : 1;
        else if (WIN && (name === 'start' || name === 'call') && /^\/[a-z]+$/i.test(w)) k++;
        else if (name === 'timeout' && !dur) { dur = true; k++; } else break;
      }
      words = words.slice(k);
      continue;
    }
    if (EVALS.has(name)) return { inner: unquoteWhole(seg.slice(words[0].end)) };
    const kind = SHELLS[name];
    let inner = null;
    if (kind === 'posix') {
      const k = words.findIndex((w, idx) => idx > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.raw));
      if (k > 0 && words[k + 1]) inner = unquoteWhole(words[k + 1].raw);
    } else if (kind === 'cmd') {
      for (let k = 1; k < words.length; k++) {
        const m = /^\/[ck](.*)$/i.exec(words[k].raw);
        if (m) { inner = unquoteWhole(m[1] + ' ' + seg.slice(words[k].end)); break; }
      }
    } else if (kind === 'ps') {
      for (let k = 1; k < words.length; k++) {
        const w = words[k].raw;
        if (/^-(c|command|commandwithargs)$/i.test(w)) { inner = unquoteWhole(seg.slice(words[k].end)); break; }
        if (/^-(e|ec|enc|encodedcommand)$/i.test(w) && words[k + 1]) {
          try { inner = Buffer.from(stripQuotes(words[k + 1].raw), 'base64').toString('utf16le'); } catch { /* 無視 */ }
          break;
        }
      }
      if (inner === null) {
        const k = words.findIndex((w, idx) => idx > 0 && !w.raw.startsWith('-'));
        if (k > 0) inner = unquoteWhole(seg.slice(words[k].start));
      }
    }
    if (inner !== null) return { inner };
    return { name, args: words.slice(1).map((w) => stripQuotes(w.raw)), words };
  }
  return null;
}

// ---------------------------------------------------------------- 破壊的コマンド

const RM_NAMES = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const PS_PARAMS = ['force', 'confirm', 'whatif', 'verbose', 'path', 'literalpath', 'include', 'exclude', 'filter', 'stream', 'credential', 'erroraction', 'errorvariable',
  'debug', 'informationaction', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'warningaction', 'warningvariable', 'usetransaction', 'recurse'];
const isPsParam = (w) => { const x = w.slice(1).toLowerCase().split(':')[0]; return x.length > 0 && PS_PARAMS.some((p) => p.startsWith(x)); };
const psRecurse = (w) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(w.split(':')[0]);
const slashS = (w) => w[0] === '/' && w.slice(1).split('/').some((p) => p.toLowerCase() === 's');

function gitSub(args) {
  const withVal = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += withVal.has(args[i]) ? 2 : 1;
  return { sub: args[i], rest: args.slice(i + 1) };
}

function destructiveLabel(name, args) {
  if (RM_NAMES.has(name)) {
    for (const w of args) {
      if (psRecurse(w)) return '再帰削除(rm -r / Remove-Item -Recurse)';
      if (name === 'rm' && (/^--recursive$/i.test(w) || (/^-[A-Za-z]+$/.test(w) && /[rR]/.test(w) && !isPsParam(w)))) return '再帰削除(rm -r)';
      if (['del', 'erase', 'rd', 'rmdir'].includes(name) && slashS(w)) return '再帰削除(rd /s, del /s)';
    }
  }
  if (name === 'format' || name === 'format-volume') return 'ディスクの初期化(format)';
  if (name === 'find' && args.some((a) => a.toLowerCase() === '-delete')) return 'find -delete';
  if (name === 'git') {
    const { sub, rest } = gitSub(args);
    const shortHas = (c) => rest.some((w) => /^-[A-Za-z]+$/.test(w) && w.includes(c));
    if (sub === 'push' && (rest.some((w) => w === '--force' || w === '-f' || w.startsWith('--force-with-lease') || w.startsWith('--force-if-includes') || w.startsWith('+')) || shortHas('f'))) return 'git push の強制(--force)';
    if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard';
    if (sub === 'clean' && (rest.includes('--force') || shortHas('f'))) return 'git clean -f';
    if (sub === 'checkout' && (rest.includes('.') || (rest.includes('--') && rest.some((w) => w === '.' || w === './' || w === '*')))) return 'git checkout -- .';
    if (sub === 'restore' && rest.includes('.') && !((rest.includes('--staged') || rest.includes('-S')) && !rest.includes('--worktree') && !rest.includes('-W'))) return 'git restore .';
    if (sub === 'stash' && rest.some((w) => w === '--include-untracked' || w === '--all' || (/^-[A-Za-z]+$/.test(w) && /[ua]/.test(w)))) return 'git stash -u / -a(未追跡のファイルまで退避)';
    if (sub === 'branch' && (shortHas('D') || (rest.some((w) => w === '--delete') && rest.some((w) => w === '--force')))) return 'git branch -D';
  }
  return null;
}

// ---------------------------------------------------------------- 作戦記録・設定・状態の削除/移動/上書き

const DELMOVE = new Set(['rm', 'del', 'erase', 'remove-item', 'ri', 'rd', 'rmdir', 'mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'rename', 'unlink']);
const AHQ_CANDIDATES = [AHQ, `${AHQ}/operations`, `${AHQ}/operations/op-001.md`, `${AHQ}/config.json`, `${AHQ}/state`, `${AHQ}/state/approval.json`].map((c) => c.split('/'));
const opsExists = (base) => fs.existsSync(path.join(base.rootNative, AHQ, 'operations'));

function hitsAhqProtected(arg, base, unknown) {
  let a = arg;
  if (a.startsWith('-')) { const k = a.indexOf(':'); if (k < 0) return false; a = a.slice(k + 1); }
  if (!a || (WIN && /^\/[a-z?]$/i.test(a))) return false;
  if (unknown && looseKind(a)) return true;
  const info = resolvePath(a, base);
  if (/[*?]/.test(a)) {
    if (!info.inside) return false;
    const P = compileGlob(info.relC);
    return AHQ_CANDIDATES.some((c) => globPath(P, c, false));
  }
  if (info.inside) {
    const r = info.relC;
    return r === AHQ || r === `${AHQ}/operations` || r.startsWith(`${AHQ}/operations/`) ||
      r === `${AHQ}/config.json` || r === `${AHQ}/state` || r.startsWith(`${AHQ}/state/`) ||
      (r === '' && opsExists(base));
  }
  // プロジェクトの上位フォルダ(丸ごと移動・削除)
  return opsExists(base) && base.rootC.startsWith(lc(info.abs) + '/');
}

// ZIP 版の .claude/ の保護対象の3つ(.claude/settings.json など)と、その親フォルダ(.claude、.claude/hooks)を指しているか
const CLAUDE_CANDIDATES = ['.claude', '.claude/hooks', '.claude/hooks/ai-headquarters', '.claude/hooks/ai-headquarters/guard.js', '.claude/settings.json', '.claude/settings.local.json'].map((c) => c.split('/'));
const claudeExists = (base) => fs.existsSync(path.join(base.rootNative, '.claude'));
function hitsClaudeProtected(arg, base, allowRoot) {
  let a = arg;
  if (a.startsWith('-')) { const k = a.indexOf(':'); if (k < 0) return false; a = a.slice(k + 1); }
  if (!a || (WIN && /^\/[a-z?]$/i.test(a))) return false;
  const info = resolvePath(a, base);
  if (/[*?]/.test(a)) {
    if (!info.inside) return false;
    const P = compileGlob(info.relC);
    return CLAUDE_CANDIDATES.some((c) => globPath(P, c, false));
  }
  if (info.inside) {
    const r = info.relC;
    return r === '.claude' || r === '.claude/hooks' || r === '.claude/hooks/ai-headquarters' ||
      r.startsWith('.claude/hooks/ai-headquarters/') || r === '.claude/settings.json' || r === '.claude/settings.local.json' ||
      (r === '' && !allowRoot && claudeExists(base));
  }
  // プロジェクトの上位フォルダ(丸ごと移動・削除)
  return !allowRoot && claudeExists(base) && base.rootC.startsWith(lc(info.abs) + '/');
}
const COPY_CMDS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'rsync', 'robocopy']);

// ---------------------------------------------------------------- スキル、エージェント、MCP の登録の保護(0.3.0。0.4.0 で守る相手を AI司令部の4体だけに狭めた)
// .claude/skills/、.claude/agents/、.mcp.json。unit は命令書にはっきり書かれたときだけ、ほかのサブエージェントは不可、メインセッションは止めない
function regKind(relC) {
  if (relC === '.mcp.json') return 'mcp';
  if (relC === '.claude/skills' || relC.startsWith('.claude/skills/')) return 'skills';
  if (relC === '.claude/agents' || relC.startsWith('.claude/agents/')) return 'agents';
  return null;
}
// シェルの語(グロブを含みうる)が、資源の登録を指しているか。グロブは、記号より前の部分で見る
function hitsRegistry(arg, base) {
  let a = arg;
  if (a.startsWith('-')) { const k = a.indexOf(':'); if (k < 0) return false; a = a.slice(k + 1); }
  if (!a || (WIN && /^\/[a-z?]$/i.test(a))) return false;
  const info = resolvePath(a, base);
  if (!info.inside) return false;
  const r = info.relC.replace(/\/+$/, '');
  const lit = r.split(/[*?]/)[0];
  if (lit !== r) return regKind(lit.replace(/\/+$/, '')) !== null || ['.claude/skills', '.claude/agents', '.mcp.json'].some((c) => globPath(compileGlob(r), c.split('/'), false));
  return regKind(r) !== null;
}
// 命令書の項目が、その種類の資源の登録を「はっきり」指しているか(グロブの記号より前の部分で判断する)
function explicitEntry(p, kind) {
  const lit = p.split(/[*?]/)[0];
  if (kind === 'mcp') return p === '.mcp.json';
  const dir = `.claude/${kind}`;
  return p === dir || lit.startsWith(`${dir}/`);
}

// プラグインと MCP の状態を変える claude のコマンド(0.3.0)。照合したときは、その説明を返す
const PLUGIN_READ = new Set(['list', 'details', 'validate', 'help']);
const MARKET_READ = new Set(['list', 'help']);
const MCP_READ = new Set(['list', 'get', 'help']);
const NEST_OPTS = ['--plugin-dir', '--mcp-config', '--dangerously-skip-permissions'];
function claudeLabel(name, args) {
  if (name !== 'claude') return null;
  const nest = args.find((a) => NEST_OPTS.some((o) => a.toLowerCase() === o || a.toLowerCase().startsWith(`${o}=`)));
  if (nest) return `claude の入れ子の起動(${nest.split('=')[0]})`;
  const i = args.findIndex((a) => ['plugin', 'plugins', 'mcp'].includes(a.toLowerCase()));
  if (i < 0) return null;
  const group = args[i].toLowerCase();
  const rest = args.slice(i + 1).filter((a) => !a.startsWith('-'));
  const sub = (rest[0] || '').toLowerCase();
  if (!sub) return null;
  if (group === 'mcp') return MCP_READ.has(sub) ? null : `claude mcp ${sub}`;
  if (sub === 'marketplace') {
    const ms = (rest[1] || '').toLowerCase();
    return !ms || MARKET_READ.has(ms) ? null : `claude plugin marketplace ${ms}`;
  }
  return PLUGIN_READ.has(sub) ? null : `claude plugin ${sub}`;
}

// 丸ごと上書きされるファイル(の候補)を返す
function overwriteTargets(name, args) {
  const nonOpt = args.filter((a) => !(a.startsWith('-') || (WIN && /^\/[a-z?]$/i.test(a))));
  const append = args.some((a) => /^-a(?:p(?:p(?:e(?:n(?:d)?)?)?)?)?$/i.test(a.split(':')[0]) || a === '--append');
  if (['set-content', 'sc', 'clear-content', 'clc'].includes(name)) return nonOpt;
  if (['out-file', 'tee', 'tee-object'].includes(name)) return append ? [] : nonOpt;
  if (name === 'sed' && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) return nonOpt;
  if (['cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'xcopy'].includes(name)) return nonOpt.length ? [nonOpt[nonOpt.length - 1]] : [];
  return [];
}

// ---------------------------------------------------------------- 共通のシェル検査

const READONLY_CMDS = new Set(['cat', 'type', 'ls', 'dir', 'head', 'tail', 'grep', 'rg', 'findstr', 'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'wc', 'test-path', 'stat', 'less', 'more', 'jq']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'add']);
const CD_CMDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl']);

function isReadOnly(name, args) {
  if (READONLY_CMDS.has(name)) return true;
  if (name === 'git') {
    const { sub } = gitSub(args);
    return GIT_READ.has(sub) && !args.some((a) => a.startsWith('--output'));
  }
  return false;
}

function handleEff(eff, st, base, ctx, v, seg, depth) {
  const { name, args } = eff;
  if (CD_CMDS.has(name)) {
    if (name === 'popd') st.unknown = true;
    else {
      const a = args.find((x) => !x.startsWith('-') && !/^\/d$/i.test(x));
      if (a === undefined || a === '-' || /[$%~`*?(]/.test(a)) st.unknown = true;
      else st.cwd = resolvePath(a, base).abs;
    }
  }
  const label = destructiveLabel(name, args);
  if (label) v.denyOrAsk(`破壊的なコマンド(${label})です。`);
  const cl = claudeLabel(name, args);
  if (cl) v.denyOrAsk(`プラグインや MCP の状態を変えるコマンド(${cl})です。入れたものの Hooks や MCP サーバーは利用者の権限で動き、作戦の途中で統制が変わります。入れるかどうかは指揮官が決めます。`);
  let targets = null;
  if (DELMOVE.has(name)) targets = args;
  else if (name === 'git') {
    const { sub, rest } = gitSub(args);
    if (['rm', 'mv', 'clean'].includes(sub)) targets = rest;
    if (sub === 'clean') {
      const letters = rest.filter((w) => /^-[A-Za-z]+$/.test(w)).join('').replace(/-/g, '');
      const dry = rest.includes('--dry-run') || /n/.test(letters);
      if (!dry && /[dxX]/.test(letters) && opsExists(base)) {
        const specs = rest.filter((w) => !w.startsWith('-'));
        if (!specs.length || specs.some((p) => hitsAhqProtected(p, base, st.unknown))) {
          v.deny('git clean -d / -x は、作戦記録(.ai-headquarters/operations/)を消してしまうため、メインセッションを含めて止めています。消す場所を指定するか、指揮官が自分で行ってください。');
        }
      }
    }
  }
  if (targets) {
    for (const a of targets) {
      if (hitsAhqProtected(a, base, st.unknown)) {
        v.deny(`作戦記録・設定・状態(${a})、またはその上位フォルダの削除・移動は、メインセッションを含めて止めています。削除は指揮官が自分で行ってください。`);
        break;
      }
    }
  }
  // ZIP 版の .claude/ の保護: .claude/ の3つの親フォルダを対象にした削除・移動・復元・コピー
  {
    let cand = [];
    let allowRoot = false;
    if (DELMOVE.has(name)) cand = args;
    else if (COPY_CMDS.has(name)) {
      const nonOpt = args.filter((a) => !(a.startsWith('-') || (WIN && /^\/[a-z?]$/i.test(a))));
      cand = nonOpt.length ? [nonOpt[nonOpt.length - 1]] : [];
      allowRoot = true;
    } else if (name === 'git') {
      const { sub, rest } = gitSub(args);
      const stagedOnly = (rest.includes('--staged') || rest.includes('-S')) && !rest.includes('--worktree') && !rest.includes('-W');
      if ((sub === 'checkout' || sub === 'restore') && !stagedOnly) cand = rest.filter((w) => !w.startsWith('-'));
    }
    const hit = cand.find((a) => hitsClaudeProtected(a, base, allowRoot));
    if (hit !== undefined) {
      v.denyOrAsk(`統制のスクリプトと登録(.claude/settings.json、.claude/hooks/ai-headquarters/ など)、またはその親フォルダ(${hit})を書き換える・消す・動かすコマンドです。`);
    }
  }
  for (const t of overwriteTargets(name, args)) {
    const info = resolvePath(t, base);
    if (ahqKind(info) === 'ops' && info.relC !== `${AHQ}/operations`) {
      let isFile = false;
      try { isFile = fs.statSync(info.abs).isFile(); } catch { /* 無い */ }
      if (isFile) {
        v.deny(`既存の作戦記録(${t})をコマンドで丸ごと上書きすることは止めています。追記(>>、Add-Content、tee -a)にしてください。`);
        break;
      }
    }
  }
  if (name === 'find') {
    for (let k = 0; k < eff.words.length; k++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(eff.words[k].raw)) {
        const sub = resolveWords(seg, eff.words.slice(k + 1));
        if (sub && sub.inner !== undefined) checkCmd(sub.inner, { ...st }, ctx, v, depth + 1);
        else if (sub) handleEff(sub, st, base, ctx, v, seg, depth + 1);
      }
    }
  }
}

function checkCmd(cmd, st, ctx, v, depth) {
  if (depth > 6) return;
  for (const seg of splitSegments(cmd)) {
    const base = { ...ctx.base, cwd: st.cwd };
    const eff = resolveWords(seg, splitWordsPos(seg));
    const tokens = tokenizeSeg(seg);
    const writeRedir = tokens.some((t) => t.redir === '>' || t.redir === '>>');
    const readOnly = !writeRedir && !!eff && eff.inner === undefined && isReadOnly(eff.name, eff.args);
    for (const tk of tokens) {
      if (!tk.t || tk.t.length > 1024) continue;
      const info = resolvePath(tk.t, base);
      let kind = ahqKind(info);
      if (!kind && st.unknown) kind = looseKind(tk.t);
      if (kind) {
        const exempt = readOnly || tk.redir === '<';
        if ((kind === 'config' || kind === 'state') && !exempt) {
          v.deny(`設定ファイル・状態ファイル(${tk.t})は、メインセッションを含めて、コマンドからの書き込みを止めています。`);
        } else if (ctx.isSub && !exempt) {
          v.deny(`サブエージェントは .ai-headquarters/ の中(${tk.t})を書き換えられません。`);
        }
        if (tk.redir === '>' && kind === 'ops' && fs.existsSync(info.abs)) {
          v.deny(`作戦記録(${tk.t})を丸ごと上書きするリダイレクトは止めています。追記(>>)にしてください。`);
        }
      }
      if (ctx.protectedPath(info, readOnly || tk.redir === '<')) {
        v.denyOrAsk(`保護対象のファイル(${tk.t})を含むコマンドです。`);
      }
      if (ctx.role && !readOnly && tk.redir !== '<' && hitsRegistry(tk.t, base)) {
        v.deny(`AI司令部のサブエージェントは、シェルのコマンドで .claude/skills/、.claude/agents/、.mcp.json(${tk.t})を書き換えられません。unit は、命令書の【変更してよいファイル】にはっきり書かれたときに、Edit か Write で書いてください。`);
      }
    }
    if (!eff) continue;
    if (eff.inner !== undefined) checkCmd(eff.inner, { ...st }, ctx, v, depth + 1);
    else handleEff(eff, st, base, ctx, v, seg, depth);
  }
}

function commonShellChecks(cmd, ctx, v) {
  checkCmd(cmd, { cwd: ctx.base.cwd, unknown: false }, ctx, v, 0);
}

// ---------------------------------------------------------------- inspector の許可リスト

const DEFAULT_TEST_COMMANDS = ['npm test', 'pnpm test', 'yarn test', 'node --test', 'pytest', 'go test', 'cargo test'];
const GIT_OPTIONS = {
  diff: ['--stat', '--name-only', '--name-status', '--cached', '--staged'],
  status: ['-s', '--short', '--porcelain'],
  log: ['--oneline', '-n', '--stat', '--format'],
  show: ['--stat', '--name-only'],
  'ls-files': ['--cached', '--deleted', '--modified', '--others', '--exclude-standard'],
};
// 読み取りだけの ls(0.5.0 の第3段。実地で inspector が止まった理由のうち、一番多かったため)。付けてよいオプションはこれだけ
const LS_OPTIONS = new Set(['-l', '-a', '-la', '-al', '-1', '-R']);
const GIT_SAFE_EXTRA = ['--no-ext-diff', '--no-textconv'];

// 戻り値: { deny: 理由 } / { update: 新しいコマンド } / null(通す)
function inspectorCheck(cmd, cfg) {
  if (/&&|\|\||[;|&<>`$(){}\n\r]/.test(cmd)) {
    return { deny: 'inspector には、コマンドをつないだり入出力を切り替えたりする記号(&&、||、;、|、&、>、<、$、(、)、{、}、バッククォート、改行。$ ( ) { } は、それぞれ単独でも止めます)を含むコマンドを許していません(引用符の中も同じ)。' };
  }
  const raw = cmd.trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return { deny: 'inspector には空のコマンドを許していません。' };
  const tokens = raw.map(stripQuotes);
  if (tokens.some((t) => /^\\+-/.test(t))) return { deny: 'inspector では、エスケープを使ったオプションの指定を許していません。' };

  if (raw[0] === 'git') {
    const sub = raw[1];
    if (!sub || !Object.prototype.hasOwnProperty.call(GIT_OPTIONS, sub)) {
      return { deny: 'inspector に許す git は、git diff / status / log / show / ls-files だけです(git の直後にサブコマンドが必要で、-c や -C などのオプションは置けません)。' };
    }
    const allowed = new Set(GIT_OPTIONS[sub]);
    if (sub !== 'status') GIT_SAFE_EXTRA.forEach((o) => allowed.add(o));
    for (const t of tokens.slice(2)) {
      if (!t.startsWith('-') || t === '--') continue;
      const name = t.split('=')[0];
      if (allowed.has(name)) continue;
      if (sub === 'log' && /^-n\d+$/.test(t)) continue;
      return { deny: `inspector の git ${sub} に許していないオプション(${t})です。` };
    }
    if (sub === 'status' || sub === 'ls-files') return null;
    const updated = cmd.replace(/^(\s*git\s+(?:diff|log|show))(?=\s|$)/, '$1 --no-ext-diff --no-textconv');
    if (updated === cmd) return { deny: 'inspector の git コマンドの形を解釈できませんでした。' };
    return { update: updated };
  }

  if (raw[0] === 'ls') {
    for (const t of tokens.slice(1)) {
      if (t.startsWith('-') && !LS_OPTIONS.has(t)) return { deny: `inspector の ls に許していないオプション(${t})です。使えるのは ${[...LS_OPTIONS].join('、')} だけです。` };
      // PowerShell の ls は Get-ChildItem なので、env: や HKCU: のようなドライブで、環境変数やレジストリが読める(T16 の点検の指摘)。
      // ドライブ文字のパス(C: や C:/)のほかに「:」を含む引数と、ネットワークのパスは止める
      if ((t.includes(':') && !/^[A-Za-z]:[\\/]/.test(t)) || /^(?:\\\\|\/\/)/.test(t)) return { deny: `inspector の ls には、ファイルとフォルダのパスだけを渡せます(${t} は止めます。環境変数やレジストリ、ネットワークのパスは読めません)。` };
    }
    return null;
  }
  const allowedOpts = new Set(cfg.allowedOptions);
  const prefixes = DEFAULT_TEST_COMMANDS.concat(cfg.testCommands).map((c) => c.trim().split(/\s+/));
  const matched = prefixes.find((p) => p.length <= tokens.length && p.every((w, i) => tokens[i] === w));
  if (!matched) {
    return { deny: 'inspector に許すのは、テストのコマンド(npm test、pytest など)と、読み取り専用の git(diff、status、log、show、ls-files)と ls だけです。' };
  }
  for (const t of tokens.slice(matched.length)) {
    if (t === '--') continue;
    if (t.startsWith('-') && !allowedOpts.has(t)) {
      return { deny: `inspector のテストコマンドに許していないオプション(${t})です。必要なら設定ファイルの inspector.allowedOptions に足してください。` };
    }
  }
  return null;
}

// ---------------------------------------------------------------- unit の関門・予約・範囲

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

// 最新の作戦記録の本文。読めないときは null
function readOperation(root, num) {
  try {
    const dir = path.join(root, AHQ, 'operations');
    const f = fs.readdirSync(dir).find((n) => { const x = /^OP-(\d+)\.md$/i.exec(n); return x && parseInt(x[1], 10) === num; });
    return f ? fs.readFileSync(path.join(dir, f), 'utf8') : null;
  } catch { return null; }
}

function latestOperation(root) {
  try {
    const nums = fs.readdirSync(path.join(root, AHQ, 'operations'))
      .map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean).map((m) => parseInt(m[1], 10));
    return nums.length ? Math.max(...nums) : null;
  } catch { return null; }
}

function opNumber(x) {
  const m = /OP-(\d+)/i.exec(String(x == null ? '' : x));
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------- 作戦中の見分け方(起動の数え上げに使う。0.4.0)
// 最新の作戦記録の「## 結果」の次の行(空行を除く)が「未完了」で始まるか。欄が無い・読み取れないときは未完了とみなす
function resultPending(root, num) {
  try {
    const dir = path.join(root, AHQ, 'operations');
    const f = fs.readdirSync(dir).find((n) => { const x = /^OP-(\d+)\.md$/i.exec(n); return x && parseInt(x[1], 10) === num; });
    if (!f) return true;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '').split(/\r?\n/);
    const i = lines.findIndex((l) => /^##\s*結果\s*$/.test(l.trim()));
    if (i < 0) return true;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].trim();
      if (!t) continue;
      if (/^#/.test(t)) return true;
      return t.startsWith('未完了');
    }
    return true;
  } catch { return true; }
}
function tryCreateExclusive(p, obj) {
  let fd;
  try {
    fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, JSON.stringify(obj));
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 無視 */ } }
  }
}

// 実行中の記録が無効か。別のセッションの記録も、期限までは有効とみなす(0.4.0)。
// 「実行中」は、30分のあいだ unit が書き込みもコマンドもしていなければ無効(touched_at は、SubagentStart と unit の操作のたびに新しくなる)
function lockIsStale(raw, mtimeMs, now) {
  let lock = null;
  try { lock = JSON.parse(raw); } catch { /* 下で扱う */ }
  if (!lock || typeof lock !== 'object') return now - mtimeMs > RESERVE_TTL_MS;
  if (lock.status === 'reserved') return now - (Number(lock.created_at) || mtimeMs) > RESERVE_TTL_MS;
  if (lock.status === 'running') return now - (Number(lock.touched_at) || Number(lock.started_at) || Number(lock.created_at) || mtimeMs) > RUNNING_TTL_MS;
  return now - mtimeMs > RESERVE_TTL_MS;
}
// unit が起動できないときの対処(README と同じ)
const LOCK_REMEDY = '動いている unit が終わるまで待ってください。セッションが異常に終わったときは、その unit の記録が、書き込みもコマンドも無いまま30分たつと無効になります(長くて30分)。動いている unit がもう無いと分かっているなら、指揮官が自分で .ai-headquarters/state/unit-lock.json を消してください(Claude には消せません)。';

// 予約を取る。取れたら true
function reserveUnit(stateDir, sessionId, toolUseId) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, 'unit-lock.json');
  const now = Date.now();
  const lock = { session_id: sessionId, status: 'reserved', created_at: now, ts: new Date(now).toISOString(), tool_use_id: toolUseId || null };
  if (tryCreateExclusive(lockPath, lock)) return true;
  let raw; let mtime;
  try { raw = fs.readFileSync(lockPath, 'utf8'); mtime = fs.statSync(lockPath).mtimeMs; } catch (e) {
    if (e && e.code === 'ENOENT') return tryCreateExclusive(lockPath, lock);
    throw e;
  }
  if (!lockIsStale(raw, mtime, now)) return false;
  // 古い記録を、一意な名前へ移して取り除く(移せるのは1つのプロセスだけ)
  const stale = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try { fs.renameSync(lockPath, stale); } catch { return tryCreateExclusive(lockPath, lock); }
  let moved = null;
  try { moved = fs.readFileSync(stale, 'utf8'); } catch { /* 無視 */ }
  if (moved !== raw) {
    // 移したのが新しい記録だった(競合)。戻して、自分は断る
    try { if (!fs.existsSync(lockPath)) fs.renameSync(stale, lockPath); else fs.unlinkSync(stale); } catch { /* 無視 */ }
    return false;
  }
  try { fs.unlinkSync(stale); } catch { /* 無視 */ }
  return tryCreateExclusive(lockPath, lock);
}

function splitList(t) {
  const out = [];
  let cur = ''; let d = 0;
  for (const c of t) {
    if (c === '{') d++; else if (c === '}' && d > 0) d--;
    if (d === 0 && (c === ',' || c === '、' || c === '，')) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// 1行から、箇条書きの印・括弧の注記・「: 説明」「 - 説明」「 — 説明」を取り除き、カンマ区切りを分けて、パスの一覧にする
function scopeLine(l) {
  let t = l.trim();
  if (!t) return [];
  t = t.replace(/^(?:[-*+]\s+|\d+[.)]\s+|[・●○▪■]\s*)/, '').trim();
  t = t.replace(/[`"']/g, '');
  // 括弧の注記は、行末にあるものだけ取り除く(パスの中の括弧、例: app/(auth)/** は残す)。全角の「（」は空白が無くても注記とみなす
  // 半角の括弧は、前に空白があるか、中に ASCII 以外の文字があるときだけ注記とみなす(app/(auth) のような ASCII だけで前に空白の無いものは残す)
  t = t.replace(/(?:\s+[（(][^)）]*[)）]|\s*（[^)）]*[)）]|\([^)）]*[^\x00-\x7F][^)）]*[)）])\s*$/, '');
  let cut = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '：') { cut = i; break; }
    if (c === ':' && !(i === 1 && /[A-Za-z]/.test(t[0]))) { cut = i; break; }
    if ((c === '-' || c === '—' || c === '–') && i > 0 && /\s/.test(t[i - 1]) && /\s/.test(t[i + 1] || '')) { cut = i; break; }
  }
  if (cut >= 0) t = t.slice(0, cut);
  return splitList(t).map((x) => x.trim()).filter(Boolean);
}

function parseScope(prompt) {
  const lines = String(prompt || '').split(/\r?\n/);
  const header = '【変更してよいファイル】';
  const entries = [];
  // 見出しは行の先頭(前の空白は可)にあるときだけ欄の始まり。行の途中のものは無視する。2つ以上あれば読み取れないものとして扱う
  const starts = [];
  lines.forEach((l, i) => { if (l.trimStart().startsWith(header)) starts.push(i); });
  if (starts.length !== 1) return { valid: false };
  let idx = starts[0];
  entries.push(...scopeLine(lines[idx].slice(lines[idx].indexOf(header) + header.length)));
  for (idx++; idx < lines.length; idx++) {
    if (/^\s*【[^】]*】/.test(lines[idx])) break;
    entries.push(...scopeLine(lines[idx]));
  }
  // 句点を含む項目は、型の説明文を写したものとみなして読み取れないものとする
  if (entries.some((e) => e.includes('。'))) return { valid: false };
  return entries.length ? { valid: true, entries } : { valid: false };
}

function normalizeScopeEntries(entries, base) {
  const out = [];
  for (let e of entries) {
    e = toPosix(e);
    if (/^[a-zA-Z]:\//.test(e) || e.startsWith('/')) {
      const info = resolvePath(e, base);
      if (!info.inside) continue;
      e = info.relC + (/\/$/.test(e) ? '/' : '');
    }
    e = e.replace(/^\.\//, '');
    if (e) out.push(e);
  }
  return out;
}

const SCOPE_GUIDE = '【変更してよいファイル】は、見出しの行には何も書かず、次の行から1行に1つ、プロジェクトの最上位からの相対パス(例: src/a.js、src/**)で書いてください。';

function unitGate(input, ctx, v) {
  const root = ctx.base.rootNative;
  const latest = latestOperation(root);
  const v5text = latest === null ? null : readOperation(root, latest);
  if (hasTimetable(v5text)) {
    const c = unitGateV5(input, v, root, latest, v5text);
    if (!c) return;
    unitTail(input, ctx, v, root, latest, { step: c.step, minutes: c.minutes });
    const r = v.result();
    // 止めたときと、起動の上限の確認(ask)を出したときは、引き継ぎの記録を足さない(断られて起動しなかったときに、承認が移らないように。T16 の点検の指摘)
    if (r && (r.d === 'deny' || r.d === 'ask')) return;
    const op = `OP-${String(latest).padStart(3, '0')}`;
    if (c.accept) {
      apAppend(root, c.accept);
      v.context(`AI司令部: ${op} の承認を引き継ぎました(指揮官の前の「承認」は数え直しません)。最初の報告で、計画と任務の要点を指揮官に示してください。作戦記録の「### 引き継ぎ」に「引き継ぎ済み: 日時」を書いてください。`);
    } else if (c.cancel) apAppend(root, { session_id: input.session_id, operation: op, kind: 'cancel' });
    return;
  }
  if (latest === null) {
    v.deny('作戦記録(.ai-headquarters/operations/OP-NNN.md)がまだありません。中規模以上の作戦では、先に作戦記録を作り、指揮官に計画を示して「承認」とだけ入力してもらってから、unit を起動してください。');
    return;
  }
  const approval = readJsonSafe(path.join(root, AHQ, 'state', 'approval.json'));
  const ok = approval && typeof approval === 'object' && typeof approval.session_id === 'string' && approval.session_id !== '' && approval.session_id === input.session_id &&
    opNumber(approval.operation) !== null && opNumber(approval.operation) === latest;
  // unit の起動に要るのは計画の決心(2026-11-22)。目標の決心だけ、または段階の無い古い記録では止める
  if (ok && !(typeof approval.plan === 'string' && approval.plan !== '')) {
    const op = `OP-${String(latest).padStart(3, '0')}`;
    v.deny(typeof approval.goals === 'string' && approval.goals !== ''
      ? `作戦記録 ${op} には目標の決心の記録しかありません。目標の決心だけでは unit を起動できません。指揮官に計画を示し、「承認」とだけ入力してもらってから(計画の決心)、unit を起動してください。`
      : `作戦記録 ${op} に対する計画の決心の記録がありません。指揮官に計画を示し、「承認」とだけ入力してもらってから、unit を起動してください。`);
    return;
  }
  if (!ok) {
    v.deny(`作戦記録 OP-${String(latest).padStart(3, '0')} に対する指揮官の承認がありません(別のセッションや古い作戦番号の承認は無効です)。指揮官に計画を示し、「承認」とだけ入力してもらってから、unit を起動してください。`);
    return;
  }
  // 承認した目標と計画を、指紋で照らす(0.4.0)。指紋の無い記録(0.3.0 で承認した作戦)も止める
  const op = `OP-${String(latest).padStart(3, '0')}`;
  if (typeof approval.fingerprint !== 'string' || approval.fingerprint === '') {
    v.deny(`作戦記録 ${op} の承認の記録に、指紋がありません(0.4.0 より前の版で承認した作戦です)。指揮官に、作戦記録の計画を示し、改めて「承認」とだけ入力してもらってから、unit を起動してください。`);
    return;
  }
  const now = fingerprintOf(readOperation(root, latest));
  if (now !== approval.fingerprint) {
    v.deny(`作戦記録 ${op} の目標(必成目標、点検の物差し、起動の上限)か計画が、承認のあとで書き換えられています(承認の指紋 ${approval.fingerprint}、今の指紋 ${now})。書き換えた点を指揮官に示し、改めて「承認」とだけ入力してもらってから、unit を起動してください。計画を組み直したときは、組み直す前の計画を「## 途中修正」に「取り消した計画(指紋 ${approval.fingerprint})」として残してください。`);
    return;
  }
  // 大規模の節目の承認の下限(0.4.0。2026-11-23 指揮官の決定)。前の「承認」のあと unit を3回起動したら、4回目の前に止める
  if (operationScale(readOperation(root, latest)) === '大' && resultPending(root, latest)) {
    const since = Date.parse(approval.plan);
    const n = countLaunches(root, op, { only: UNIT_RE, sinceMs: Number.isNaN(since) ? 0 : since });
    if (n >= MILESTONE_UNITS) {
      v.deny(`作戦 ${op} は大規模で、前の「承認」のあと unit を${n}回起動しました(節目の承認の下限は、unit の起動3回ごとです。同じ任務を命じ直した起動も1回と数えます)。次の unit を起動する前に、指揮官に中間報告をして、「承認」とだけ入力してもらってください。「続けて」「進めて」などの返事は承認になりません。そのことも指揮官に伝えてください。`);
      return;
    }
  }
  unitTail(input, ctx, v, root, latest, {});
}

// unit の起動の後半(範囲の読み取り、起動の上限、予約)。0.4.1 の道と 0.5.0 の道で共通。extra は範囲の記録に足す欄(0.5.0 の手順と持ち時間)
function unitTail(input, ctx, v, root, latest, extra) {
  // 範囲は予約より先に読む。読み取れなければ、予約も範囲の記録も残さずに起動を止める(実行中の unit の記録を壊さないため)
  const ti = input.tool_input || {};
  const scope = parseScope(ti.prompt);
  if (!scope.valid) {
    v.deny(`命令書の【変更してよいファイル】を読み取れないため、unit を起動できません。mission-order スキルを読み込み、型の見出しどおりに命令書を書き直してください。${SCOPE_GUIDE}`);
    return;
  }
  const stateDir = path.join(root, AHQ, 'state');
  const lockDenied = () => {
    const held = readJsonSafe(path.join(stateDir, 'unit-lock.json'));
    v.deny(held && typeof held === 'object' && held.session_id !== input.session_id
      ? `別のセッションの unit が実行中(または起動の予約中)です。unit は、プロジェクトの中で同時に1体までです。${LOCK_REMEDY}`
      : `unit は同時に1体までです。実行中の unit(または予約中の起動)が終わってから起動してください。${LOCK_REMEDY}`);
  };
  const writeScope = () => atomicWrite(path.join(stateDir, 'unit-scope.json'),
    { valid: true, entries: normalizeScopeEntries(scope.entries, ctx.base), session_id: input.session_id, ts: new Date().toISOString(), ...extra });
  // 起動の上限の確認を出すときは、予約を取らない(点検の軽2)。確認が断られたときに予約が2分残り、次の unit が止まるのを防ぐ。
  // 予約の代わりに、実行中の unit が無いことだけを確かめる。許されて起動したら、起動の知らせ(SubagentStart)で実行中の記録を作る
  const lim = launchLimitState(root, latest);
  if (lim && lim.count >= lim.limit) {
    // 実行中の unit が無いことを確かめ、無効になった古い記録(異常に終わった unit のもの)は、ここで取り除く(確かめの指摘の新1)。
    // 残すと、許されて起動した unit の書き込みが「持ち主が、この unit ではありません」で止まるため。
    // 確かめと取り除きは、clearStaleLock の中で同じ読みについて行う(あいだに作られた有効な予約を取り除かない。0.4.1)
    if (!clearStaleLock(stateDir)) { lockDenied(); return; }
    fs.mkdirSync(stateDir, { recursive: true });
    writeScope();
    v.ask(limitReason(lim));
    return;
  }
  if (!reserveUnit(stateDir, input.session_id, input.tool_use_id)) { lockDenied(); return; }
  writeScope();
  if (lim) limitNotice(lim, v);
}

// ---------------------------------------------------------------- 起動の数え上げ(0.4.0)
// 4体の起動の知らせ(SubagentStart)のたびに、最新の作戦記録の「## 結果」が「未完了」なら、state/launches.jsonl に1行足す。
// 1行に1回の追記にするのは、並列に起動したときに数え漏らさないため。同じ agent_id は1回と数える。
// 上限は、approval.js が「承認」を記録するときに控えた値(approval.json の launch_limit)。欄を書き換えても次の「承認」までは変わらない
function launchesPath(root) { return path.join(root, AHQ, 'state', 'launches.jsonl'); }
// only: 役の名前を絞る正規表現。sinceMs: その時刻より後(同じ時刻を含む)の起動だけを数える
function countLaunches(root, op, { only = null, sinceMs = null } = {}) {
  let raw = '';
  try { raw = fs.readFileSync(launchesPath(root), 'utf8'); } catch { return 0; }
  const seen = new Set();
  let n = 0;
  for (const line of raw.split(/\r?\n/)) {
    let r = null;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object' || r.operation !== op) continue;
    if (only && !(typeof r.agent_type === 'string' && only.test(r.agent_type))) continue;
    if (sinceMs !== null) { const t = Date.parse(r.ts); if (Number.isNaN(t) || t < sinceMs) continue; }
    if (typeof r.agent_id === 'string' && r.agent_id !== '') {
      if (seen.has(r.agent_id)) continue;
      seen.add(r.agent_id);
    }
    n++;
  }
  return n;
}
function recordLaunch(input, root) {
  const latest = latestOperation(root);
  if (latest === null || !resultPending(root, latest)) return;
  const op = `OP-${String(latest).padStart(3, '0')}`;
  fs.mkdirSync(path.join(root, AHQ, 'state'), { recursive: true });
  fs.appendFileSync(launchesPath(root), `${JSON.stringify({ operation: op, agent_type: input.agent_type, agent_id: input.agent_id || null, session_id: input.session_id || null, ts: new Date().toISOString() })}\n`);
}
// 最新の作戦の起動の回数と、控えた上限。数えないとき(作戦記録が無い、結果を書き終えた、控えた値が無い)は null
function launchLimitState(root, latest) {
  if (latest === null || !resultPending(root, latest)) return null;
  const op = `OP-${String(latest).padStart(3, '0')}`;
  let limit;
  if (hasTimetable(readOperation(root, latest))) {
    const h = lastKind(apRows(root, op), HOLD_KINDS);
    limit = Number(h && h.copy && h.copy.launch_limit);
  } else {
    const approval = readJsonSafe(path.join(root, AHQ, 'state', 'approval.json'));
    if (!approval || typeof approval !== 'object' || opNumber(approval.operation) !== latest) return null;
    limit = Number(approval.launch_limit);
  }
  if (!Number.isInteger(limit) || limit <= 0) return null;
  return { op, limit, count: countLaunches(root, op) };
}
// 確認の画面で指揮官が読む文(点検の軽8)。bypassPermissions などで拒否になったときは、メインセッションが読む
function limitReason({ op, limit, count }) {
  return `AI司令部: 作戦 ${op} の起動の上限 ${limit} 回に達しています(4体の起動 ${count} 回)。許すと、上限を超えて起動します。残りの見込みと、上限を上げる案、作戦を止める案をまだ聞いていなければ、断ってください。(メインセッションへ: 断られたら、それらを指揮官に示して伺ってください。)`;
}
function limitNotice({ op, limit, count }, v) {
  if (count + 1 >= Math.ceil(limit * 0.8)) v.notice(`AI司令部: 作戦 ${op} の起動 ${count + 1}/${limit} 回(上限の8割に達しました)`);
}
// intel、plans、inspector の起動の前の上限の確認と知らせ。unit は unitGate の中で、予約の前に行う
function launchLimitGate(input, ctx, v) {
  const lim = launchLimitState(ctx.base.rootNative, latestOperation(ctx.base.rootNative));
  if (!lim) return;
  if (lim.count >= lim.limit) { v.ask(limitReason(lim)); return; }
  limitNotice(lim, v);
}

// ---------------------------------------------------------------- 大規模の見分け方(節目の承認の下限に使う。0.4.0)
// 作戦記録の「## 規模と編成」の最初の行(空行を除く)の初めの字。前の「規模」「:」「*」と空白は飛ばす。大、中、小のどれでもなければ、
// 大規模だけが足す節(「## 行動方針の比較と結論」「## 状況の特質」)があれば '大'。それも無ければ null(止めない側)
const MILESTONE_UNITS = 3;
function operationScale(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s*規模と編成\s*$/.test(l.trim()));
  if (i >= 0) {
    const first = lines.slice(i + 1).find((l) => l.trim() !== '');
    if (first !== undefined && !/^\s*#/.test(first)) {
      const m = /^[\s*]*(?:規模\s*[:：]?)?[\s*]*([大中小])/.exec(first);
      if (m) return m[1];
    }
  }
  return lines.some((l) => /^##\s*(行動方針の比較と結論|状況の特質)\s*$/.test(l.trim())) ? '大' : null;
}
// 無効になった記録を、一意な名前へ移して取り除く(reserveUnit と同じやり方。移せるのは1つのプロセスだけ)。
// 記録が無い、または取り除けたら true。読んだ記録が有効なとき、移した記録が新しいもの(競合)だったときは、取り除かずに false。
// 無効かの確かめは、ここで読んだ記録について行う(確かめてから読み直すあいだに作られた有効な予約を取り除かないため。0.4.1)
function clearStaleLock(stateDir) {
  const lockPath = path.join(stateDir, 'unit-lock.json');
  let raw; let mtime;
  try { raw = fs.readFileSync(lockPath, 'utf8'); mtime = fs.statSync(lockPath).mtimeMs; } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    throw e;
  }
  if (!lockIsStale(raw, mtime, Date.now())) return false;
  const stale = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try { fs.renameSync(lockPath, stale); } catch { return !fs.existsSync(lockPath); }
  let moved = null;
  try { moved = fs.readFileSync(stale, 'utf8'); } catch { /* 無視 */ }
  if (moved !== raw) {
    try { if (!fs.existsSync(lockPath)) fs.renameSync(stale, lockPath); else fs.unlinkSync(stale); } catch { /* 無視 */ }
    return false;
  }
  try { fs.unlinkSync(stale); } catch { /* 無視 */ }
  return true;
}

// unit の書き込みを、範囲の記録のセッションと、実行中の記録の持ち主と照らす(0.4.0)。問題があれば理由を返す。
// 持ち主(agent_id)の照らし合わせは、記録に持ち主が書かれているときだけ行う(SubagentStart が届かないことがあるため)
function unitOwnerProblem(input, root) {
  const scope = readJsonSafe(path.join(root, AHQ, 'state', 'unit-scope.json'));
  if (scope && typeof scope === 'object' && typeof scope.session_id === 'string' && scope.session_id !== input.session_id) {
    return 'この unit の範囲の記録は、別のセッションの unit のものです。別のセッションの unit の範囲には書けません。';
  }
  const lock = readJsonSafe(path.join(root, AHQ, 'state', 'unit-lock.json'));
  if (lock && typeof lock === 'object' && lock.status === 'running' && typeof lock.agent_id === 'string' && lock.agent_id !== '' && lock.agent_id !== input.agent_id) {
    return '実行中の unit の記録の持ち主が、この unit ではありません。ほかの unit の範囲には書けません。';
  }
  return null;
}
// unit が書き込みかコマンドを使ったら、実行中の記録の時刻を新しくする(0.4.0)。同じセッションで、持ち主が違わないときだけ。
// 同じセッションの予約のままなら(起動の知らせ SubagentStart が届いていない)、ここで実行中の記録に切り替え、持ち主を書く(点検の軽3)。
// 予約は2分で無効になるので、最初の2分を読むだけで過ごす unit では、その前に2体目の予約が取られることがある(README の限界)
function touchUnitLock(input, root) {
  try {
    const p = path.join(root, AHQ, 'state', 'unit-lock.json');
    const lock = readJsonSafe(p);
    if (!lock || typeof lock !== 'object' || lock.session_id !== input.session_id) return;
    if (lock.status === 'reserved') {
      const now = Date.now();
      atomicWrite(p, { ...lock, status: 'running', agent_id: input.agent_id || null, started_at: now, touched_at: now });
      return;
    }
    if (lock.status !== 'running') return;
    if (typeof lock.agent_id === 'string' && lock.agent_id !== '' && lock.agent_id !== input.agent_id) return;
    atomicWrite(p, { ...lock, touched_at: Date.now() });
  } catch { /* 記録できなくても、操作そのものは妨げない */ }
}

// regKind を渡したときは、その種類の資源の登録をはっきり指す項目だけで照合する(0.3.0)
function unitScopeAllows(info, root, regKindOnly = null) {
  const scope = readJsonSafe(path.join(root, AHQ, 'state', 'unit-scope.json'));
  if (!scope || scope.valid !== true || !Array.isArray(scope.entries) || !scope.entries.length) return false;
  if (!info.inside || info.relC === '') return false;
  for (const e of scope.entries) {
    if (typeof e !== 'string') continue;
    let p = e.trim();
    const dir = p.endsWith('/');
    p = lc(p.replace(/^\//, '').replace(/\/+$/, ''));
    if (!p) continue;
    if (regKindOnly && !explicitEntry(p, regKindOnly)) continue;
    // フォルダ(末尾 /)と、グロブを含まない項目は、その中のすべてにも当てる
    if (globPath(compileGlob(p), info.segs, dir || !/[*?]/.test(p))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 0.5.0 の道(作戦記録に「### 時程」の欄がある作戦)
// 承認は state/approvals.jsonl(approval.js が goals、plan、milestone を、ここが offer、accept、cancel、claim を足す)。
// 関門と時計は、作戦記録の本文ではなく、承認を持つ行の控え(copy)を読む。「### 時程」の無い作戦は、0.4.1 の道のまま
const HOLD_KINDS = ['plan', 'milestone', 'accept'];
function hasTimetable(text) {
  return typeof text === 'string' && fpLines(text).some((l) => l.trim() === '### 時程');
}
function jsonlRows(p, op) {
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    try { const r = JSON.parse(line); if (r && typeof r === 'object' && r.operation === op) out.push(r); } catch { /* 壊れた行は飛ばす */ }
  }
  return out;
}
const apRows = (root, op) => jsonlRows(path.join(root, AHQ, 'state', 'approvals.jsonl'), op);
function apAppend(root, rec) {
  fs.mkdirSync(path.join(root, AHQ, 'state'), { recursive: true });
  fs.appendFileSync(path.join(root, AHQ, 'state', 'approvals.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
}
const lastKind = (rows, kinds) => { for (let i = rows.length - 1; i >= 0; i--) if (kinds.includes(rows[i].kind)) return rows[i]; return null; };
// 開いた引き継ぎ待ち(あとに accept も cancel も無い offer)
function openOffer(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === 'offer') return rows[i];
    if (rows[i].kind === 'accept' || rows[i].kind === 'cancel') return null;
  }
  return null;
}
// 命令書の【統制】の1行目(手順の番号、点検の単位、持ち時間)。clock.js と同じ読み方
function readControl(prompt) {
  const s = String(prompt || '');
  const m = /^\s*【統制】(.*)$/m.exec(s);
  if (!m) return null;
  const first = m[1].trim() || (s.slice(m.index + m[0].length).split(/\r?\n/).find((l) => l.trim()) || '');
  const step = /手順\s*(\d+(?:\s*の\s*\d+)?)/.exec(first);
  const unit = /単\s*(\d+)/.exec(first);
  const min = /持ち時間\s*[:：]\s*(\d+)\s*分/.exec(first);
  const risk = /危険度\s*[:：]\s*(高|中|低)/.exec(first);
  return {
    risk: risk ? risk[1] : null,
    step: step ? step[1].replace(/\s+/g, '') : null,
    unit: unit ? `単${unit[1]}` : (/(^|[^\S\r\n]|。)なし/.test(first) ? 'なし' : null),
    minutes: min ? parseInt(min[1], 10) : null,
  };
}
const CONTROL_GUIDE = 'mission-order スキルを読み込み、【統制】の1行目に、手順の番号(unit)、点検の単位(inspector。「単2」か「なし」)、持ち時間(「持ち時間: 20分。」)を書いてから起動してください。';
// unit の起動の関門(承認、引き継ぎ、指紋、【統制】、第1段の節目の下限)。通すときは【統制】を返す
function unitGateV5(input, v, root, latest, text) {
  const op = `OP-${String(latest).padStart(3, '0')}`;
  const me = input.session_id;
  if (typeof me !== 'string' || me === '') { v.deny('セッションを見分けられないため、unit の起動を止めます。'); return null; }
  const rows = apRows(root, op);
  let holder = lastKind(rows, HOLD_KINDS);
  const fpNow = fingerprintOf(text);
  const offer = openOffer(rows);
  let accept = null;
  if (holder && holder.session_id !== me && offer && offer.session_id !== me && offer.fingerprint === fpNow) {
    accept = { session_id: me, operation: op, kind: 'accept', fingerprint: offer.fingerprint, copy: holder.copy };
    holder = accept;
  }
  if (!holder || holder.session_id !== me) {
    v.deny(rows.some((r) => r.kind === 'goals' && r.session_id === me)
      ? `作戦記録 ${op} には目標の決心の記録しかありません。目標の決心だけでは unit を起動できません。指揮官に計画を示し、「承認」とだけ入力してもらってから(計画の決心)、unit を起動してください。`
      : `作戦記録 ${op} に対する指揮官の承認がありません(別のセッションや古い作戦番号の承認は無効です)。指揮官に計画を示し、「承認」とだけ入力してもらってから、unit を起動してください。別のセッションで続けている作戦なら、作戦記録の「### 引き継ぎ」に「受け継ぎの申し出: 」の行を書いてから、「承認」を1回受けてください。`);
    return null;
  }
  if (holder.fingerprint !== fpNow) {
    v.deny(`作戦記録 ${op} の目標(必成目標、点検の物差し、起動の上限)か計画が、承認のあとで書き換えられています(承認の指紋 ${holder.fingerprint}、今の指紋 ${fpNow})。書き換えた点を指揮官に示し、改めて「承認」とだけ入力してもらってから、unit を起動してください。計画を組み直したときは、組み直す前の計画を「## 途中修正」に「取り消した計画(指紋 ${holder.fingerprint})」として残してください。`);
    return null;
  }
  const c = readControl((input.tool_input || {}).prompt);
  if (!c || !c.step || !c.minutes) {
    v.deny(`unit の命令書の【統制】に、手順の番号か持ち時間がありません。${CONTROL_GUIDE}`);
    return null;
  }
  const known = ((holder.copy && holder.copy.steps) || []).map((s) => String(s.step).split('の')[0]);
  if (!known.includes(c.step.split('の')[0])) {
    v.deny(`【統制】の手順${c.step} は、承認した計画の控えにありません(控えの手順: ${known.join('、') || 'なし'})。分け直した手順は「手順3 の1」のように、もとの番号を頭に書いてください。計画に無い手順なら、計画を直して指揮官に示し、「承認」を受けてください。`);
    return null;
  }
  // 第2段: 危険度、節目、節目の下限は、承認の控えから読む(12.10)
  const copy = holder.copy || {};
  const base = c.step.split('の')[0];
  const info = (copy.steps || []).find((st) => String(st.step).split('の')[0] === base) || {};
  if (c.risk && info.risk && c.risk !== info.risk) {
    v.deny(`【統制】の危険度(${c.risk})が、承認した計画の手順${base} の危険度(${info.risk})と違います。命令書の危険度を計画と同じにしてください。危険度を変えるなら、計画を直して指揮官に示し、「承認」を受けてください。`);
    return null;
  }
  if (resultPending(root, latest)) {
    const prev = lastKind(rows, ['plan', 'milestone']);
    const since = prev ? Date.parse(prev.ts) : NaN;
    const n = countLaunches(root, op, { only: UNIT_RE, sinceMs: Number.isNaN(since) ? 0 : since });
    const high = info.risk === '高';
    const mile = (copy.milestones || []).map(String).includes(base);
    const STOP = `次の unit を起動する前に、指揮官に中間報告をして${high ? '(この手順は危険度が高なので、戻し方と確かめ方を示して)' : ''}、「承認」とだけ入力してもらってください。「続けて」「進めて」などの返事は承認になりません。そのことも指揮官に伝えてください。`;
    if ((high || mile) && n > 0) {
      const doneOnce = !high && jsonlRows(path.join(root, AHQ, 'state', 'clock.jsonl'), op).some((r) => r.ev === 'agent_end' && r.role === 'unit' && String(r.step || '').split('の')[0] === base);
      if (!doneOnce) {
        v.deny(`手順${base} は、計画の${high ? '危険度が高の手順' : '節目'}です。前の「承認」のあと unit を${n}回起動しているので、この手順の前に節目の承認が要ります。${STOP}`);
        return null;
      }
    }
    const unitSteps = (copy.steps || []).filter((st) => !st.role || st.role === 'unit').length;
    const compared = fpLines(text).some((l) => /^##\s*(行動方針の比較と結論|状況の特質)\s*$/.test(l.trim()));
    const floor = Number.isInteger(copy.floor) ? copy.floor : MILESTONE_UNITS;
    if (((copy.milestones || []).length || unitSteps >= 5 || compared) && n >= floor) {
      v.deny(`作戦 ${op} は、前の「承認」のあと unit を${n}回起動しました(節目の下限は unit ${floor}回です。同じ任務を命じ直した起動も1回と数えます)。${STOP}`);
      return null;
    }
  }
  return { ...c, accept, cancel: !!(offer && offer.session_id === me) };
}
// intel、plans、inspector の【統制】と、点検の単位の数え。止めたら true
function staffGateV5(input, v, root, role) {
  const latest = latestOperation(root);
  if (latest === null || !resultPending(root, latest)) return false;
  const text = readOperation(root, latest);
  if (!hasTimetable(text)) return false;
  const c = readControl((input.tool_input || {}).prompt);
  if (!c || !c.minutes || (role === 'inspector' && !c.unit)) {
    v.deny(`${role} の命令書の【統制】に、${role === 'inspector' ? '点検の単位か' : ''}持ち時間がありません。${CONTROL_GUIDE}`);
    return true;
  }
  if (role !== 'inspector' || c.unit === 'なし') return false;
  const op = `OP-${String(latest).padStart(3, '0')}`;
  const h = lastKind(apRows(root, op), HOLD_KINDS);
  const lim = Number(h && h.copy && h.copy.inspect_limit);
  if (!Number.isInteger(lim) || lim <= 0) return false;
  const done = jsonlRows(path.join(root, AHQ, 'state', 'clock.jsonl'), op).filter((r) => r.ev === 'agent_end' && r.role === 'inspector' && r.unit === c.unit).length;
  if (done >= lim) {
    const t = `AI司令部: ${c.unit} の点検は${done + 1}回目です(上限 ${lim}回)。指揮官の決心を受けていなければ、起動せず、残った指摘を示して伺ってください。`;
    v.notice(t);
    v.context(t);
  }
  return false;
}
// unit の持ち時間の知らせ(止めない。1回だけ)
function holdNotice(input, root, v) {
  const sp = path.join(root, AHQ, 'state', 'unit-scope.json');
  const scope = readJsonSafe(sp);
  if (!scope || typeof scope !== 'object' || scope.notified || !(Number(scope.minutes) > 0) || scope.session_id !== input.session_id) return;
  const lock = readJsonSafe(path.join(root, AHQ, 'state', 'unit-lock.json'));
  const own = lock && typeof lock === 'object' && lock.status === 'running' && (!lock.agent_id || lock.agent_id === input.agent_id);
  const start = own && Number(lock.started_at) ? Number(lock.started_at) : Date.parse(scope.ts);
  if (Number.isNaN(start)) return;
  // 分に切り捨ててから比べると、持ち時間 1分の任務は2分を過ぎるまで知らせない(第3段の実地で、1.8分の unit に出なかった)。ミリ秒で比べる
  const ms = Date.now() - start;
  if (ms <= scope.minutes * 60000) return;
  const elapsed = ms < 600000 ? Math.round(ms / 6000) / 10 : Math.round(ms / 60000);
  atomicWrite(sp, { ...scope, notified: true });
  v.context(`持ち時間 ${scope.minutes}分を超えました(いま ${elapsed}分)。区切りのよい所で止め、終わった分、残り、残りの見込みを【引き継ぎ】に書いて報告してください。あと数分で必成が終わる見込みなら、続けてかまいません。`);
}
// 作戦記録への「引き継ぎ待ち: 」「受け継ぎの申し出: 」の書き込み(offer、claim)は、書き込みが済んだあとに approval.js(post)が記録する

// ---------------------------------------------------------------- PreToolUse

function makeCtx(input) {
  const base = makeBase(input);
  const isSub = !!input.agent_id;
  const m = isSub && typeof input.agent_type === 'string' ? ROLE_RE.exec(input.agent_type) : null;
  const cfg = loadConfig(base.rootNative);
  return { base, isSub, bypass: !isSub && input.permission_mode === 'bypassPermissions', role: m ? m[2] : null, cfg, protectedPath: makeProtector(cfg) };
}

function evalEdit(input, ctx, v) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const role = ctx.role;
  if (role === 'intel' || role === 'plans' || role === 'inspector') {
    v.deny(`${role} は読み取り専用の役です。ファイルを変更できません。`);
    return;
  }
  const p = ti.file_path || ti.notebook_path || ti.path;
  if (typeof p !== 'string' || !p) {
    if (role === 'unit') v.deny('書き込み先のパスを確認できないため、unit の書き込みを止めます。');
    return;
  }
  const info = resolvePath(p, ctx.base);
  const kind = ahqKind(info);
  if (kind === 'config' || kind === 'state') {
    v.deny('設定ファイル(.ai-headquarters/config.json)と状態ファイル(.ai-headquarters/state/)への書き込みは、メインセッションを含めて止めています。指揮官が自分で編集してください。');
  } else if (kind && ctx.isSub) {
    v.deny('サブエージェントは .ai-headquarters/ の中を書き換えられません。');
  } else if (kind === 'ops' && input.tool_name === 'Write' && info.relC !== `${AHQ}/operations` && fs.existsSync(info.abs)) {
    v.deny('既存の作戦記録を Write で丸ごと上書きすることは止めています。部分的な更新(Edit)を使ってください。');
  }
  if (ctx.protectedPath(info)) {
    v.denyOrAsk(`保護対象のファイル(${p})への書き込みです。`);
  }
  if (role === 'unit') {
    const why = unitOwnerProblem(input, ctx.base.rootNative);
    if (why) { v.deny(`${why}(${p})`); return; }
  }
  // .claude/skills/、.claude/agents/、.mcp.json は、AI司令部の4体だけを守る相手にする(0.4.0)。
  // intel、plans、inspector は上で拒否済み。4体以外のサブエージェントとメインセッションは止めない
  const reg = info.inside ? regKind(info.relC) : null;
  if (reg && role === 'unit') {
    if (!unitScopeAllows(info, ctx.base.rootNative, reg)) {
      v.deny(`${p} は、命令書の【変更してよいファイル】にはっきり書かれていないため、書き換えられません。.claude/skills/、.claude/agents/、.mcp.json は、\`.claude/skills/**\` や \`.mcp.json\` のように、そのパスを書いたときだけ書けます(\`**\` や \`.claude/**\` では書けません)。`);
    }
    return;
  }
  if (role === 'unit' && !unitScopeAllows(info, ctx.base.rootNative)) {
    const rec = readJsonSafe(path.join(ctx.base.rootNative, AHQ, 'state', 'unit-scope.json'));
    if (!rec || rec.valid !== true || !Array.isArray(rec.entries) || !rec.entries.length) {
      v.deny(`命令書の【変更してよいファイル】を読み取れないため、unit は何も書き換えられません(${p})。${SCOPE_GUIDE}`);
    } else {
      v.deny(`命令書の【変更してよいファイル】に含まれていないため、${p} は書き換えられません。${SCOPE_GUIDE}`);
    }
  }
}

function evalShell(input, ctx, v) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cmd = typeof ti.command === 'string' ? ti.command : '';
  const role = ctx.role;
  if (role === 'intel' || role === 'plans') {
    v.deny(`${role} は読み取り専用の役です。シェルのコマンドを実行できません。`);
    return;
  }
  if (role === 'inspector') {
    const r = inspectorCheck(cmd, ctx.cfg);
    if (r && r.deny) v.deny(r.deny);
    else if (r && r.update) v.allowUpdate({ ...ti, command: r.update });
  }
  commonShellChecks(cmd, ctx, v);
}

function evalAgent(input, ctx, v) {
  if (ctx.role) {
    v.deny('サブエージェントは、別のサブエージェントを起動できません。');
    return;
  }
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (typeof ti.subagent_type === 'string' && UNIT_RE.test(ti.subagent_type)) {
    unitGate(input, ctx, v);
  } else if (typeof ti.subagent_type === 'string' && ROLE_RE.test(ti.subagent_type)) {
    if (staffGateV5(input, v, ctx.base.rootNative, ROLE_RE.exec(ti.subagent_type)[2])) return;
    launchLimitGate(input, ctx, v);
  }
}

function handlePreToolUse(input) {
  const ctx = makeCtx(input);
  const v = new Verdict(ctx);
  const tool = input.tool_name;
  if (ctx.role === 'unit' && (EDIT_TOOLS.has(tool) || SHELL_TOOLS.has(tool))) touchUnitLock(input, ctx.base.rootNative);
  if (EDIT_TOOLS.has(tool)) evalEdit(input, ctx, v);
  else if (SHELL_TOOLS.has(tool)) evalShell(input, ctx, v);
  else if (AGENT_TOOLS.has(tool)) evalAgent(input, ctx, v);
  let r = v.result();
  // 持ち時間の知らせ(0.5.0)。止める操作には出さない(知らせ済みの印を付けずに、次の操作で出す)
  if (ctx.role === 'unit' && (EDIT_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) && !(r && r.d === 'deny')) {
    try { holdNotice(input, ctx.base.rootNative, v); } catch { /* 知らせられなくても、操作は妨げない */ }
    r = v.result();
  }
  // 知らせは、止めないときだけ出す(止める起動に回数を知らせても意味が無いため)
  const denied = !!(r && r.d === 'deny');
  const msg = v.notices.length && !denied ? v.notices.join('\n') : null;
  const add = v.contexts.length && !denied ? v.contexts.join('\n') : null;
  if (!r && !msg && !add) return;
  const o = {};
  if (msg) o.systemMessage = msg;
  if (r || add) {
    const out = { hookEventName: 'PreToolUse' };
    if (r) out.permissionDecision = r.d;
    if (r && r.d === 'allow') out.updatedInput = r.updatedInput;
    else if (r) out.permissionDecisionReason = r.reason;
    if (add) out.additionalContext = add;
    o.hookSpecificOutput = out;
  }
  process.stdout.write(JSON.stringify(o));
}

// ---------------------------------------------------------------- SubagentStart

function handleSubagentStart(input) {
  try {
    if (typeof input.agent_type !== 'string' || !ROLE_RE.test(input.agent_type)) return;
    try { recordLaunch(input, makeBase(input).rootNative); } catch { /* 数えられなくても、起動を妨げない */ }
    if (!UNIT_RE.test(input.agent_type)) return;
    const base = makeBase(input);
    const lockPath = path.join(base.rootNative, AHQ, 'state', 'unit-lock.json');
    const now = Date.now();
    // 起動の上限の確認を許されて起動した unit には予約が無い(点検の軽2)。作戦中で記録が無ければ、ここで実行中の記録を作る。
    // 作戦記録が無いプロジェクトでは、.ai-headquarters/ を作らない
    if (!fs.existsSync(lockPath)) {
      const latest = latestOperation(base.rootNative);
      if (latest === null || !resultPending(base.rootNative, latest)) return;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      tryCreateExclusive(lockPath, { session_id: input.session_id, status: 'running', created_at: now, ts: new Date(now).toISOString(), tool_use_id: null, agent_id: input.agent_id || null, started_at: now, touched_at: now });
      return;
    }
    const lock = readJsonSafe(lockPath);
    if (lock && lock.status === 'reserved' && lock.session_id === input.session_id) {
      atomicWrite(lockPath, { ...lock, status: 'running', agent_id: input.agent_id || null, started_at: now, touched_at: now });
      return;
    }
    // 無効になった古い記録が残っていれば、この unit の実行中の記録に置き換える(確かめの指摘の新1)。有効な記録は変えない
    let raw; let mtime;
    try { raw = fs.readFileSync(lockPath, 'utf8'); mtime = fs.statSync(lockPath).mtimeMs; } catch { return; }
    if (!lockIsStale(raw, mtime, now)) return;
    const latest = latestOperation(base.rootNative);
    if (latest === null || !resultPending(base.rootNative, latest)) return;
    if (!clearStaleLock(path.dirname(lockPath))) return;
    tryCreateExclusive(lockPath, { session_id: input.session_id, status: 'running', created_at: now, ts: new Date(now).toISOString(), tool_use_id: null, agent_id: input.agent_id || null, started_at: now, touched_at: now });
  } catch { /* 起動を妨げない */ }
}

// ---------------------------------------------------------------- 入口

function main() {
  // hooks.json の SubagentStart は第1引数 subagent-start で呼ばれる。このモードは何があっても exit 0
  const startMode = process.argv[2] === 'subagent-start';
  let input;
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^﻿/, '');
    input = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('入力がJSONのオブジェクトではありません');
  } catch (e) {
    if (startMode) return;
    process.stderr.write(`guard.js: 標準入力を解釈できないため操作を止めます: ${e.message}
`);
    process.exitCode = 2;
    return;
  }
  if (startMode) { handleSubagentStart(input); return; }
  const ev = input.hook_event_name;
  if (ev === 'SubagentStart') { handleSubagentStart(input); return; }
  if (ev === 'PreToolUse') {
    try { handlePreToolUse(input); } catch (e) {
      process.stderr.write(`guard.js: 内部エラーのため操作を止めます: ${e && e.stack ? e.stack : e}
`);
      process.exitCode = 2;
    }
  }
}

main();
