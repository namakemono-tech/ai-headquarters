'use strict';
// unit の実行中の記録の直し(0.4.0)。
// 1. 30分を超えて動く unit: 書き込みかコマンドを使うたびに時刻を新しくし、「30分のあいだ何もしていなければ無効」にする
// 2. 2つのセッション: 別のセッションの記録も期限までは有効。unit の書き込みを、範囲の記録のセッションと、実行中の記録の持ち主と照らす
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'ul-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

const OP = '# OP-001 作戦記録\n\n## 目標\n### 必成目標\nx\n\n## 計画\n手順1: unit\n\n## 結果\n未完了\n';
const MIN = 60 * 1000;
let seq = 0;
const st = (root, n) => path.join(root, '.ai-headquarters', 'state', n);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function fix({ lock, scope } = {}) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-001.md'), OP);
  fs.writeFileSync(st(root, 'approval.json'), JSON.stringify({ session_id: 'S1', operation: 'OP-001', plan: '2026-11-23T00:00:00Z', fingerprint: FP.fingerprintOf(OP) }));
  if (lock) fs.writeFileSync(st(root, 'unit-lock.json'), JSON.stringify(lock));
  if (scope) fs.writeFileSync(st(root, 'unit-scope.json'), JSON.stringify({ valid: true, entries: ['src/**'], session_id: 'S1', ts: new Date().toISOString(), ...scope }));
  return root;
}
function run(root, o) {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: root, permission_mode: 'default', ...o }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
  const h = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return h ? { d: h.permissionDecision, reason: h.permissionDecisionReason || '' } : { d: null, reason: '' };
}
const launch = (root, session = 'S1') => run(root, {
  session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `tu${++seq}`,
  tool_input: { subagent_type: 'ai-headquarters:unit', prompt: '【変更してよいファイル】\n- src/**' },
});
const edit = (root, { session = 'S1', agent = 'agA', rel = 'src/a.js', type = 'ai-headquarters:unit' } = {}) => run(root, {
  session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Edit', agent_id: agent, agent_type: type,
  tool_input: { file_path: path.join(root, rel), old_string: 'a', new_string: 'b' },
});
const bash = (root, { session = 'S1', agent = 'agA', type = 'ai-headquarters:unit', command = 'npm test' } = {}) => run(root, {
  session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: agent, agent_type: type, tool_input: { command },
});
const running = (session, { started, touched, agent = 'agA' } = {}) => {
  const l = { session_id: session, status: 'running', created_at: Date.now() - started * MIN, started_at: Date.now() - started * MIN, agent_id: agent };
  if (touched !== undefined) l.touched_at = Date.now() - touched * MIN;
  return l;
};
const REMEDY = (reason) => {
  assert.match(reason, /30分/);
  assert.match(reason, /unit-lock\.json/);
  assert.match(reason, /指揮官が自分で/);
};

describe('30分を超えて動く unit', () => {
  test('起動から31分でも、直前に書き込みかコマンドをした unit がいれば、2体目の起動は止まる', () => {
    const r = launch(fix({ lock: running('S1', { started: 31, touched: 1 }) }));
    assert.equal(r.d, 'deny');
    REMEDY(r.reason);
  });
  test('30分のあいだ何もしていない unit の記録は無効とみなし、2体目は通る', () => {
    assert.equal(launch(fix({ lock: running('S1', { started: 40, touched: 31 }) })).d, null);
    assert.equal(launch(fix({ lock: running('S1', { started: 31 }) })).d, null, '時刻の記録の無い古い形');
  });
  test('SubagentStart で、実行中の記録に時刻(touched_at)を書く', () => {
    const root = fix();
    assert.equal(launch(root).d, null);
    run(root, { session_id: 'S1', hook_event_name: 'SubagentStart', agent_id: 'agA', agent_type: 'ai-headquarters:unit' });
    const l = readJson(st(root, 'unit-lock.json'));
    assert.equal(l.status, 'running');
    assert.ok(Date.now() - l.touched_at < MIN);
  });
  test('unit の Edit と Bash のたびに、時刻が新しくなる', () => {
    for (const act of [(root) => edit(root), (root) => bash(root)]) {
      const root = fix({ lock: running('S1', { started: 25, touched: 25 }), scope: {} });
      assert.equal(act(root).d, null);
      assert.ok(Date.now() - readJson(st(root, 'unit-lock.json')).touched_at < MIN);
    }
  });
  test('ほかのサブエージェントやメインセッションの操作、持ち主の違う unit では、時刻を新しくしない', () => {
    const lock = running('S1', { started: 25, touched: 25 });
    const root = fix({ lock, scope: {} });
    bash(root, { agent: 'ins', type: 'ai-headquarters:inspector', command: 'npm test' });
    run(root, { session_id: 'S1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    bash(root, { agent: 'other-unit' });
    bash(root, { session: 'S2' });
    assert.equal(readJson(st(root, 'unit-lock.json')).touched_at, lock.touched_at);
  });
  // 点検の軽3(2026-11-23 指揮官の決定。案1): SubagentStart が届かなくても、unit が最初に書き込むかコマンドを使ったときに、
  // 同じセッションの予約を実行中の記録に切り替える(持ち主と時刻を書く)。2分で予約が無効になって2体目を起動できる穴を、ほぼ塞ぐ
  for (const [name, op] of [['Edit', edit], ['Bash', bash]]) {
    test(`予約中の記録は、同じセッションの unit の最初の ${name} で、実行中の記録に切り替わる`, () => {
      const lock = { session_id: 'S1', status: 'reserved', created_at: Date.now() - 30000, tool_use_id: 'tu1' };
      const root = fix({ lock, scope: {} });
      assert.equal(op(root).d, null);
      const l = readJson(st(root, 'unit-lock.json'));
      assert.equal(l.status, 'running');
      assert.equal(l.agent_id, 'agA');
      assert.ok(Date.now() - l.touched_at < MIN);
      assert.ok(Date.now() - l.started_at < MIN);
    });
  }
  test('切り替わったあとは、予約から2分を過ぎても(SubagentStart が届かなくても)、2体目の起動は止まる', () => {
    const root = fix({ lock: { session_id: 'S1', status: 'reserved', created_at: Date.now() - 60000 }, scope: {} });
    edit(root);
    const l = readJson(st(root, 'unit-lock.json'));
    fs.writeFileSync(st(root, 'unit-lock.json'), JSON.stringify({ ...l, created_at: Date.now() - 3 * MIN }));
    const r = launch(root);
    assert.equal(r.d, 'deny');
    REMEDY(r.reason);
  });
  test('切り替わったあとは、持ち主でない unit は書けない', () => {
    const root = fix({ lock: { session_id: 'S1', status: 'reserved', created_at: Date.now() - 30000 }, scope: {} });
    edit(root);
    assert.equal(edit(root, { agent: 'agB' }).d, 'deny');
    assert.equal(edit(root).d, null);
  });
  test('別のセッションの予約、ほかのサブエージェント、メインセッションの操作では、切り替えない', () => {
    const lock = { session_id: 'S2', status: 'reserved', created_at: Date.now() - 30000 };
    const r1 = fix({ lock, scope: {} });
    edit(r1);
    assert.deepEqual(readJson(st(r1, 'unit-lock.json')), lock, '別のセッションの予約');
    const own = { session_id: 'S1', status: 'reserved', created_at: Date.now() - 30000 };
    const r2 = fix({ lock: own, scope: {} });
    bash(r2, { type: 'ai-headquarters:inspector', agent: 'agI', command: 'git status' });
    bash(r2, { type: 'general-purpose', agent: 'agG', command: 'npm test' });
    run(r2, { session_id: 'S1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(r2, 'src', 'a.js'), old_string: 'a', new_string: 'b' } });
    assert.deepEqual(readJson(st(r2, 'unit-lock.json')), own, 'inspector、4体以外、メインセッション');
  });
  test('限界: 最初の2分を読むだけで過ごす unit は防げない(予約が無効になり、2体目を起動できる。README の限界に書く)', () => {
    const root = fix({ lock: { session_id: 'S1', status: 'reserved', created_at: Date.now() - 3 * MIN }, scope: {} });
    assert.equal(launch(root).d, null);
  });
});

describe('2つのセッション', () => {
  test('別のセッションの unit が実行中なら、unit の起動は止まり、理由文に対処がある', () => {
    const root = fix({ lock: running('S2', { started: 5, touched: 5 }) });
    const r = launch(root);
    assert.equal(r.d, 'deny');
    assert.match(r.reason, /別のセッション/);
    REMEDY(r.reason);
    assert.equal(readJson(st(root, 'unit-lock.json')).session_id, 'S2', '別のセッションの記録を置き換えない');
  });
  test('別のセッションの予約(2分以内)も有効', () => {
    assert.equal(launch(fix({ lock: { session_id: 'S2', status: 'reserved', created_at: Date.now() - 30000 } })).d, 'deny');
  });
  test('別のセッションの記録も、期限を過ぎれば無効', () => {
    assert.equal(launch(fix({ lock: running('S2', { started: 40, touched: 31 }) })).d, null);
    assert.equal(launch(fix({ lock: { session_id: 'S2', status: 'reserved', created_at: Date.now() - 3 * MIN } })).d, null);
  });
  test('範囲の記録のセッションと違うセッションの unit が書くと止まる', () => {
    const root = fix({ scope: { session_id: 'S2' } });
    assert.equal(edit(root).d, 'deny');
    assert.equal(edit(root, { session: 'S2' }).d, null);
  });
  test('実行中の記録に持ち主が書かれていて、自分でない unit が書くと止まる', () => {
    const root = fix({ lock: running('S1', { started: 1, touched: 1, agent: 'agA' }), scope: {} });
    assert.equal(edit(root, { agent: 'agB' }).d, 'deny');
    assert.equal(edit(root, { agent: 'agA' }).d, null);
  });
  test('持ち主の記録が無いときは、範囲だけで判定する', () => {
    const lock = running('S1', { started: 1, touched: 1 });
    delete lock.agent_id;
    const root = fix({ lock, scope: {} });
    assert.equal(edit(root, { agent: 'agB' }).d, null);
    assert.equal(edit(root, { agent: 'agB', rel: 'docs/x.md' }).d, 'deny');
    assert.equal(edit(fix({ scope: {} }), { agent: 'agZ' }).d, null, '実行中の記録が無いとき');
  });
});

describe('verify-suspects.js(2026-11-23 の評価で確かめた不具合)で、直したものが止まる', () => {
  const script = path.join(__dirname, '..', 'docs', 'work', 'revision-040', 'verify', 'verify-suspects.js');
  test('A5、A7、B4、B7、B9、C3、C5 が止まる', { skip: !fs.existsSync(script) }, () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const id of ['A5', 'A7', 'B4', 'B7', 'B9', 'C3', 'C5']) {
      const m = new RegExp(`\\[${id}\\][^\\n]*\\n\\s*=> ([^\\n]*)`).exec(r.stdout);
      assert.ok(m, id);
      assert.match(m[1], /^deny/, `${id}: ${m[1]}`);
    }
  });
});
