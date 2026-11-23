'use strict';
// 承認と計画の結び付き(指紋。0.4.0)。approval.js が計画の決心で指紋を取り、guard.js が unit の起動で照らす。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

const APPROVAL = path.join(__dirname, '..', 'hooks', 'approval.js');
const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'fp-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

const GOALS = '## 目標\n### 指揮官の指定\nなし\n### 必成目標\n必成1: 金額の表示を直す\n### 望成目標\n望成1(優先1、損耗限度: 試行1回): README に1行足す\n### 点検の物差し\n物1: cart.js の金額が「1,234円」の形になっている\n物2: 命令書の【制約】を守った\n物3: 既存の動作を壊していない\n点検の上限: 同じ成果物につき3回\n### 起動の上限\n6回(見込み 4回)\n';
const DECIDE = (goals = '省略: 企図の完了条件がそのまま点検できる形のため') => `## 承認\n### 目標の決心\n${goals}\n### 計画の決心\n未決心\n`;
const PLAN = '## 計画\n【目標】必成1: 金額の表示を直す\n【手順】\n手順1: unit。src/cart.js。物1\n### 手順の注\n点検: 手順1 のあと。物1\n【リスク】なし\n';
const OP = ({ goals = GOALS, decide = DECIDE(), plan = PLAN, tail = '## 結果\n未完了\n' } = {}) =>
  `# OP-001 作戦記録\n\n${goals}\n${decide}\n${plan === null ? '' : `${plan}\n`}${tail}`;

let seq = 0;
function fix(body = OP()) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(opPath(root), body);
  return root;
}
const opPath = (root) => path.join(root, '.ai-headquarters', 'operations', 'OP-001.md');
const run = (script, o, root) => spawnSync(process.execPath, [script], { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
function approve(root, session = 'S1') {
  const r = run(APPROVAL, { session_id: session, cwd: root, hook_event_name: 'UserPromptSubmit', prompt: '承認' }, root);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}
function launch(root, session = 'S1') {
  // 前の起動の予約を消す(このテストは指紋だけを見る)
  try { fs.unlinkSync(path.join(root, '.ai-headquarters', 'state', 'unit-lock.json')); } catch { /* 無ければよい */ }
  const r = run(GUARD, {
    session_id: session, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `tu${++seq}`, permission_mode: 'default',
    tool_input: { subagent_type: 'ai-headquarters:unit', prompt: '【変更してよいファイル】\n- src/cart.js' },
  }, root);
  assert.equal(r.status, 0, r.stderr);
  const h = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return h ? { d: h.permissionDecision, reason: h.permissionDecisionReason || '' } : { d: null, reason: '' };
}
const readApp = (root) => JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters', 'state', 'approval.json'), 'utf8'));
const edit = (root, from, to) => {
  const t = fs.readFileSync(opPath(root), 'utf8');
  assert.ok(t.includes(from), from);
  fs.writeFileSync(opPath(root), t.replace(from, to));
};

describe('指紋の計算は approval.js と guard.js で同じ', () => {
  test('2つのファイルの指紋の印のあいだが、一字も違わない', () => {
    assert.equal(FP.fpBlock(GUARD), FP.fpBlock(APPROVAL));
  });
  test('指紋は16進の12文字', () => {
    assert.match(FP.fingerprintOf(OP()), /^[0-9a-f]{12}$/);
  });
});

describe('計画の決心で指紋を取り、unit の起動で照らす', () => {
  test('承認の案内と記録に指紋が入り、起動は通る', () => {
    const root = fix();
    const msg = approve(root);
    const fp = FP.fingerprintFile(opPath(root));
    assert.match(msg, /計画の決心/);
    assert.ok(msg.includes(`指紋 ${fp}`), msg);
    assert.equal(readApp(root).fingerprint, fp);
    assert.equal(launch(root).d, null);
  });
  const changes = [
    ['計画の節', '手順1: unit。src/cart.js。物1', '手順1: unit。src/other.js。物1'],
    ['計画の節の中の ### の行', '### 手順の注', '### 手順の注(改)'],
    ['必成目標', '必成1: 金額の表示を直す', '必成1: 金額の表示を消す'],
    ['点検の物差し', '物2: 命令書の【制約】を守った', '物2: なし'],
    ['点検の上限', '点検の上限: 同じ成果物につき3回', '点検の上限: 同じ成果物につき9回'],
    ['起動の上限', '6回(見込み 4回)', '60回(見込み 4回)'],
  ];
  for (const [label, from, to] of changes) {
    test(`承認のあとに${label}を書き換えると止まり、「承認」を入れ直すと通る`, () => {
      const root = fix();
      approve(root);
      edit(root, from, to);
      const r = launch(root);
      assert.equal(r.d, 'deny');
      assert.match(r.reason, /書き換えられています/);
      assert.match(r.reason, /承認/);
      approve(root);
      assert.equal(launch(root).d, null);
    });
  }
  test('望成目標や任務の節など、指紋の外を書き換えても止まらない', () => {
    const root = fix(OP({ tail: '## 任務\nなし\n\n## 途中修正\nなし\n\n## 結果\n未完了\n' }));
    approve(root);
    edit(root, '望成1(優先1、損耗限度: 試行1回): README に1行足す', '望成1(優先1、損耗限度: 試行2回): README に2行足す');
    edit(root, '## 任務\nなし', '## 任務\nOP-001-1 手順1 unit\n監督: 命令どおり');
    edit(root, '## 途中修正\nなし', '## 途中修正\n手順1 を2つに分けた');
    edit(root, '### 計画の決心\n未決心', '### 計画の決心\n承認: 2026-11-23 10:00(指紋 ab12cd34ef56)');
    assert.equal(launch(root).d, null);
  });
});

describe('指紋の書式', () => {
  const base = FP.fingerprintOf(OP());
  test('節の前後の空行、行末の空白、改行の種類だけの違いでは、指紋が変わらない', () => {
    assert.equal(FP.fingerprintOf(OP().replace(/\n/g, '\r\n')), base, 'CRLF');
    assert.equal(FP.fingerprintOf(OP().replace(/\n/g, '\r')), base, 'CR');
    assert.equal(FP.fingerprintOf(OP().replace('## 計画\n', '## 計画\n\n\n').replace('【リスク】なし\n', '【リスク】なし\n\n\n')), base, '前後の空行');
    assert.equal(FP.fingerprintOf(OP().replace('【リスク】なし', '【リスク】なし   \t').replace('6回(見込み 4回)', '6回(見込み 4回)　')), base, '行末の空白');
    assert.equal(FP.fingerprintOf(OP().replace('### 起動の上限\n', '### 起動の上限\n\n')), base, '欄の前の空行');
    assert.equal(FP.fingerprintOf(`﻿${OP()}`), base, 'BOM');
  });
  test('見出しの前後の空白は許す', () => {
    assert.equal(FP.fingerprintOf(OP().replace('## 計画\n', '  ## 計画  \n').replace('### 必成目標\n', '### 必成目標 \n')), base);
  });
  test('本文の中の違い(行の途中の空白、空行の数)では、指紋が変わる', () => {
    assert.notEqual(FP.fingerprintOf(OP().replace('【手順】\n', '【手順】\n\n')), base);
    assert.notEqual(FP.fingerprintOf(OP().replace('src/cart.js。物1', 'src/cart.js。 物1')), base);
  });
  test('「### 」の行は計画の本文に含まれる。次の「## 」の行の前までが計画の節', () => {
    const p1 = FP.fingerprintOf(OP({ plan: `${PLAN}### 追記\nx\n` }));
    assert.notEqual(p1, base);
    const tail = FP.fingerprintOf(OP({ tail: '## 結果\n必成目標を達成した\n' }));
    assert.equal(tail, base, '「## 結果」は計画の節に入らない');
  });
  test('行の全体が「## 計画」でない見出しは、計画の節とみなさない', () => {
    const t = OP({ plan: PLAN.replace('## 計画', '## 計画(改訂)') });
    assert.equal(FP.planWritten(t), false);
    assert.equal(FP.planWritten(OP()), true);
  });
  test('欄が無いときは空として計算し、異常終了しない', () => {
    assert.match(FP.fingerprintOf('# OP-001\n\n## 計画\nx\n'), /^[0-9a-f]{12}$/);
    assert.match(FP.fingerprintOf(''), /^[0-9a-f]{12}$/);
  });
  test('起動の上限は、欄の最初の行の先頭の半角の数字から読む', () => {
    assert.equal(FP.launchLimitOf(OP()), 6);
    assert.equal(FP.launchLimitOf(OP({ goals: GOALS.replace('6回(見込み 4回)', '\n12回') })), 12);
    assert.equal(FP.launchLimitOf(OP({ goals: GOALS.replace('6回(見込み 4回)', '１２回') })), null, '全角の数字は読まない');
    assert.equal(FP.launchLimitOf(OP({ goals: GOALS.replace('6回(見込み 4回)', '未定') })), null);
    assert.equal(FP.launchLimitOf(OP({ goals: GOALS.replace('6回(見込み 4回)', '0回') })), null);
    assert.equal(FP.launchLimitOf('# OP-001\n'), null);
  });
});

describe('計画が無いときの「承認」', () => {
  const cases = [
    ['「未作成」のまま', '## 計画\n未作成\n'],
    ['「未作成(計画の決心を求める前に全文を書く)」', '## 計画\n未作成(計画の決心を求める前に全文を書く)\n'],
    ['空のまま', '## 計画\n\n'],
    ['節が無い', null],
    ['見出しが「## 計画(改訂)」', '## 計画(改訂)\nx\n'],
  ];
  for (const [label, plan] of cases) {
    test(`${label}: 計画の決心として記録されず、案内が出る`, () => {
      const root = fix(OP({ plan }));
      const msg = approve(root);
      assert.match(msg, /計画を作戦記録に書いてから、もう一度『承認』と入力してもらってください/);
      assert.ok(!fs.existsSync(path.join(root, '.ai-headquarters', 'state', 'approval.json')) || !readApp(root).plan);
      assert.equal(launch(root).d, 'deny');
    });
  }
  test('目標の決心のあとで計画が無いときも、記録は変えず、案内が出る', () => {
    const root = fix(OP({ decide: DECIDE('未決心'), plan: '## 計画\n未作成\n' }));
    assert.match(approve(root), /目標の決心/);
    const before = readApp(root);
    assert.equal(before.fingerprint, undefined, '目標の決心では指紋を取らない');
    assert.match(approve(root), /計画を作戦記録に書いてから/);
    assert.deepEqual(readApp(root), before);
  });
  for (const g of ['修正: 望成1 を外す', '修正：望成1 を外す', '省略: 理由']) {
    test(`「### 目標の決心」が「${g}」で始まるとき: 計画の決心として記録され、指紋が付く`, () => {
      const root = fix(OP({ decide: DECIDE(g) }));
      assert.match(approve(root), /計画の決心/);
      assert.equal(readApp(root).fingerprint, FP.fingerprintFile(opPath(root)));
      assert.equal(launch(root).d, null);
    });
  }
  test('目標の決心と計画の決心の2回の「承認」で、2回目に指紋が付く', () => {
    const root = fix(OP({ decide: DECIDE('未決心') }));
    approve(root);
    assert.equal(launch(root).d, 'deny');
    approve(root);
    assert.match(readApp(root).fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(launch(root).d, null);
  });
});

describe('古い作戦記録と、指紋の無い承認の記録', () => {
  const OLD = '# OP-001 作戦記録\n\n## 目標\n### 指揮官の指定\nなし\n### 区分を改めた点\nなし\n### 必成目標\nx\n\n## 承認\n### 目標の決心\n承認: 2026-11-22\n### 計画の決心\n承認: 2026-11-22\n\n## 計画\n計画書の要約\n\n## 結果\n未完了\n';
  function oldRoot() {
    const root = fix(OLD);
    fs.mkdirSync(path.join(root, '.ai-headquarters', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'state', 'approval.json'),
      JSON.stringify({ session_id: 'S1', operation: 'OP-001', goals: '2026-11-22T00:00:00Z', plan: '2026-11-22T01:00:00Z', ts: '2026-11-22T01:00:00Z' }));
    return root;
  }
  test('0.3.0 の承認の記録(指紋なし)では、unit の起動が止まり、異常終了しない', () => {
    const r = launch(oldRoot());
    assert.equal(r.d, 'deny');
    assert.match(r.reason, /承認/);
  });
  test('同じセッションなら「承認」1回で通る(物差しと上限の欄が無くても)', () => {
    const root = oldRoot();
    assert.match(approve(root), /計画の決心/);
    assert.equal(launch(root).d, null);
  });
  test('セッションが変わっていれば、「承認」2回(目標、計画)で通る', () => {
    const root = oldRoot();
    approve(root, 'S2');
    assert.equal(launch(root, 'S2').d, 'deny');
    approve(root, 'S2');
    assert.equal(launch(root, 'S2').d, null);
  });
});
