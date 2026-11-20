#!/usr/bin/env node
'use strict';
// AI司令部プラグイン: 統制(Hooks)のうち PreToolUse と SubagentStart を受け持つ単体ファイル。
// Node.js 22 以上、外部パッケージなし。イベント名(hook_event_name)で振り分ける。
//   PreToolUse   : 役割ごとの制限、保護パス、破壊的コマンド、作戦記録・設定・状態の保護、承認の関門、unit の予約と範囲
//   SubagentStart: unit の予約を「実行中」に切り替える(失敗しない)
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
  constructor(ctx) { this.ctx = ctx; this.items = []; }
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
};
const GIT_SAFE_EXTRA = ['--no-ext-diff', '--no-textconv'];

// 戻り値: { deny: 理由 } / { update: 新しいコマンド } / null(通す)
function inspectorCheck(cmd, cfg) {
  if (/&&|\|\||[;|&<>`$(){}\n\r]/.test(cmd)) {
    return { deny: 'inspector には、コマンドをつないだり入出力を切り替えたりする記号(&& || ; | & > < $( バッククォート 改行 など)を含むコマンドを許していません(引用符の中も同じ)。' };
  }
  const raw = cmd.trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return { deny: 'inspector には空のコマンドを許していません。' };
  const tokens = raw.map(stripQuotes);
  if (tokens.some((t) => /^\\+-/.test(t))) return { deny: 'inspector では、エスケープを使ったオプションの指定を許していません。' };

  if (raw[0] === 'git') {
    const sub = raw[1];
    if (!sub || !Object.prototype.hasOwnProperty.call(GIT_OPTIONS, sub)) {
      return { deny: 'inspector に許す git は、git diff / status / log / show だけです(git の直後にサブコマンドが必要で、-c や -C などのオプションは置けません)。' };
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
    if (sub === 'status') return null;
    const updated = cmd.replace(/^(\s*git\s+(?:diff|log|show))(?=\s|$)/, '$1 --no-ext-diff --no-textconv');
    if (updated === cmd) return { deny: 'inspector の git コマンドの形を解釈できませんでした。' };
    return { update: updated };
  }

  const allowedOpts = new Set(cfg.allowedOptions);
  const prefixes = DEFAULT_TEST_COMMANDS.concat(cfg.testCommands).map((c) => c.trim().split(/\s+/));
  const matched = prefixes.find((p) => p.length <= tokens.length && p.every((w, i) => tokens[i] === w));
  if (!matched) {
    return { deny: 'inspector に許すのは、テストのコマンド(npm test、pytest など)と、読み取り専用の git(diff、status、log、show)だけです。' };
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

function lockIsStale(raw, mtimeMs, sessionId, now) {
  let lock = null;
  try { lock = JSON.parse(raw); } catch { /* 下で扱う */ }
  if (!lock || typeof lock !== 'object') return now - mtimeMs > RESERVE_TTL_MS;
  if (lock.session_id !== sessionId) return true;
  if (lock.status === 'reserved') return now - (Number(lock.created_at) || mtimeMs) > RESERVE_TTL_MS;
  if (lock.status === 'running') return now - (Number(lock.started_at) || Number(lock.created_at) || mtimeMs) > RUNNING_TTL_MS;
  return now - mtimeMs > RESERVE_TTL_MS;
}

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
  if (!lockIsStale(raw, mtime, sessionId, now)) return false;
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

function unitGate(input, ctx, v) {
  const root = ctx.base.rootNative;
  const latest = latestOperation(root);
  if (latest === null) {
    v.deny('作戦記録(.ai-headquarters/operations/OP-NNN.md)がまだありません。中規模以上の作戦では、先に作戦記録を作り、指揮官に計画を示して「承認」とだけ入力してもらってから、unit を起動してください。');
    return;
  }
  const approval = readJsonSafe(path.join(root, AHQ, 'state', 'approval.json'));
  const ok = approval && typeof approval === 'object' && typeof approval.session_id === 'string' && approval.session_id !== '' && approval.session_id === input.session_id &&
    opNumber(approval.operation) !== null && opNumber(approval.operation) === latest;
  if (!ok) {
    v.deny(`作戦記録 OP-${String(latest).padStart(3, '0')} に対する指揮官の承認がありません(別のセッションや古い作戦番号の承認は無効です)。指揮官に計画を示し、「承認」とだけ入力してもらってから、unit を起動してください。`);
    return;
  }
  const stateDir = path.join(root, AHQ, 'state');
  if (!reserveUnit(stateDir, input.session_id, input.tool_use_id)) {
    v.deny('unit は同時に1体までです。実行中の unit(または予約中の起動)が終わってから起動してください。');
    return;
  }
  const ti = input.tool_input || {};
  const scope = parseScope(ti.prompt);
  const rec = scope.valid
    ? { valid: true, entries: normalizeScopeEntries(scope.entries, ctx.base), session_id: input.session_id, ts: new Date().toISOString() }
    : { valid: false };
  atomicWrite(path.join(stateDir, 'unit-scope.json'), rec);
}

function unitScopeAllows(info, root) {
  const scope = readJsonSafe(path.join(root, AHQ, 'state', 'unit-scope.json'));
  if (!scope || scope.valid !== true || !Array.isArray(scope.entries) || !scope.entries.length) return false;
  if (!info.inside || info.relC === '') return false;
  for (const e of scope.entries) {
    if (typeof e !== 'string') continue;
    let p = e.trim();
    const dir = p.endsWith('/');
    p = lc(p.replace(/^\//, '').replace(/\/+$/, ''));
    if (!p) continue;
    // フォルダ(末尾 /)と、グロブを含まない項目は、その中のすべてにも当てる
    if (globPath(compileGlob(p), info.segs, dir || !/[*?]/.test(p))) return true;
  }
  return false;
}

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
  if (role === 'unit' && !unitScopeAllows(info, ctx.base.rootNative)) {
    const rec = readJsonSafe(path.join(ctx.base.rootNative, AHQ, 'state', 'unit-scope.json'));
    const guide = '【変更してよいファイル】は、見出しの行には何も書かず、次の行から1行に1つ、プロジェクトの最上位からの相対パス(例: src/a.js、src/**)で書いてください。';
    if (!rec || rec.valid !== true || !Array.isArray(rec.entries) || !rec.entries.length) {
      v.deny(`命令書の【変更してよいファイル】を読み取れないため、unit は何も書き換えられません(${p})。${guide}`);
    } else {
      v.deny(`命令書の【変更してよいファイル】に含まれていないため、${p} は書き換えられません。${guide}`);
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
  }
}

function handlePreToolUse(input) {
  const ctx = makeCtx(input);
  const v = new Verdict(ctx);
  const tool = input.tool_name;
  if (EDIT_TOOLS.has(tool)) evalEdit(input, ctx, v);
  else if (SHELL_TOOLS.has(tool)) evalShell(input, ctx, v);
  else if (AGENT_TOOLS.has(tool)) evalAgent(input, ctx, v);
  const r = v.result();
  if (!r) return;
  const out = { hookEventName: 'PreToolUse', permissionDecision: r.d };
  if (r.d === 'allow') out.updatedInput = r.updatedInput;
  else out.permissionDecisionReason = r.reason;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

// ---------------------------------------------------------------- SubagentStart

function handleSubagentStart(input) {
  try {
    if (typeof input.agent_type !== 'string' || !UNIT_RE.test(input.agent_type)) return;
    const base = makeBase(input);
    const lockPath = path.join(base.rootNative, AHQ, 'state', 'unit-lock.json');
    const lock = readJsonSafe(lockPath);
    if (!lock || lock.status !== 'reserved' || lock.session_id !== input.session_id) return;
    atomicWrite(lockPath, { ...lock, status: 'running', agent_id: input.agent_id || null, started_at: Date.now() });
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
