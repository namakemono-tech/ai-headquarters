'use strict';
// 起動の上限(0.4.0)。4体の起動を SubagentStart で数え、起動の前(PreToolUse の Agent)に、8割で知らせ、上限で確認を出す。
// 画面での確かめ(2026-11-23): PreToolUse の確認と systemMessage は画面に出た。SubagentStart の systemMessage は出なかった。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APPROVAL = path.join(__dirname, '..', 'hooks', 'approval.js');
const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
const HOOKS = path.join(__dirname, '..', 'hooks', 'hooks.json');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'll-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

const OP = (limit = '2回(見込み 2回)', result = '未完了') => `# OP-001 作戦記録\n\n## 目標\n### 必成目標\nx\n### 点検の物差し\n物1: x\n点検の上限: 同じ成果物につき3回\n### 起動の上限\n${limit}\n\n## 承認\n### 目標の決心\n省略: 理由\n### 計画の決心\n未決心\n\n## 計画\n手順1: unit\n\n## 結果\n${result}\n`;
let seq = 0;
const opFile = (root, n = 'OP-001') => path.join(root, '.ai-headquarters', 'operations', `${n}.md`);
function fix(body = OP()) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
  fs.writeFileSync(opFile(root), body);
  return root;
}
const env = (root) => ({ ...process.env, CLAUDE_PROJECT_DIR: root });
function approve(root, session = 'S1') {
  const r = spawnSync(process.execPath, [APPROVAL], { input: JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'UserPromptSubmit', prompt: '承認' }), encoding: 'utf8', env: env(root) });
  assert.equal(r.status, 0, r.stderr);
}
let agentSeq = 0;
function started(root, type = 'ai-headquarters:intel', session = 'S1') {
  const r = spawnSync(process.execPath, [GUARD, 'subagent-start'], { input: JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'SubagentStart', agent_type: type, agent_id: `ag${++agentSeq}` }), encoding: 'utf8', env: env(root) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', 'SubagentStart の知らせは画面に出ないので、何も出さない');
}
function before(root, type = 'ai-headquarters:intel', mode = 'default') {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `tu${++seq}`, permission_mode: mode,
      tool_input: { subagent_type: type, prompt: '【変更してよいファイル】\n- src/a.js', description: 'd' } }),
    encoding: 'utf8', env: env(root),
  });
  assert.equal(r.status, 0, r.stderr);
  const o = r.stdout.trim() ? JSON.parse(r.stdout) : {};
  const h = o.hookSpecificOutput || {};
  return { d: h.permissionDecision || null, reason: h.permissionDecisionReason || '', msg: o.systemMessage || '' };
}
const rmLock = (root) => { try { fs.unlinkSync(path.join(root, '.ai-headquarters', 'state', 'unit-lock.json')); } catch { /* 無い */ } };

describe('起動の数え上げ', () => {
  test('hooks.json の SubagentStart の matcher は4体に当たり、ほかには当たらない', () => {
    const h = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
    const ss = h.hooks.SubagentStart;
    assert.equal(ss.length, 1);
    const re = new RegExp(ss[0].matcher);
    for (const n of ['intel', 'plans', 'unit', 'inspector', 'ai-headquarters:intel', 'ai-headquarters:unit']) assert.ok(re.test(n), n);
    for (const n of ['general-purpose', 'Explore', 'other:unit', 'units']) assert.ok(!re.test(n), n);
    assert.deepEqual(ss[0].hooks[0].args.slice(-1), ['subagent-start']);
  });
  test('上限2回: 2回目の起動の前に知らせ、3回目の起動の前に確認', () => {
    const root = fix();
    approve(root);
    assert.deepEqual(before(root), { d: null, reason: '', msg: '' }, '1回目の前(0回)');
    started(root);
    const b2 = before(root, 'ai-headquarters:plans');
    assert.equal(b2.d, null);
    assert.match(b2.msg, /起動 2\/2 回/);
    started(root, 'plans');
    const b3 = before(root, 'inspector');
    assert.equal(b3.d, 'ask');
    assert.match(b3.reason, /起動の上限 2 回/);
    assert.match(b3.reason, /伺/);
    assert.equal(before(root, 'inspector', 'bypassPermissions').d, 'deny', 'bypassPermissions では拒否');
  });
  test('8割は端数を切り上げる(上限10回: 8回目の起動の前から知らせる)', () => {
    const root = fix(OP('10回(見込み 7回)'));
    approve(root);
    for (let i = 0; i < 6; i++) started(root);
    assert.equal(before(root).msg, '', '7回目の前');
    started(root);
    assert.match(before(root).msg, /起動 8\/10 回/);
    started(root);
    assert.match(before(root).msg, /起動 9\/10 回/);
  });
  test('unit の起動も、上限に達していれば確認(承認と範囲の関門を通ったうえで)', () => {
    const root = fix();
    approve(root);
    started(root); started(root, 'unit');
    rmLock(root);
    const r = before(root, 'ai-headquarters:unit');
    assert.equal(r.d, 'ask');
    assert.match(r.reason, /起動の上限/);
  });
  // 軽2(点検の指摘): 確認を出すときは、unit の予約を取らない。断られたときに予約が2分残り、次の unit が止まるのを防ぐ
  test('上限の確認を出すときは、unit の予約を取らない(断られても予約が残らない)', () => {
    const root = fix();
    approve(root);
    started(root); started(root, 'unit');
    rmLock(root);
    const lock = path.join(root, '.ai-headquarters', 'state', 'unit-lock.json');
    assert.equal(before(root, 'ai-headquarters:unit').d, 'ask');
    assert.ok(!fs.existsSync(lock), '確認を出した時点で、予約が無い');
    assert.ok(fs.existsSync(path.join(root, '.ai-headquarters', 'state', 'unit-scope.json')), '範囲は記録する(許されたときに unit が書けるように)');
    assert.equal(before(root, 'ai-headquarters:unit').d, 'ask', '断られたあと、すぐにもう一度起動しようとしても「同時に1体」では止まらない');
  });
  test('上限の確認が許されて unit が起動したら、起動の知らせで実行中の記録を作る', () => {
    const root = fix();
    approve(root);
    started(root); started(root, 'unit');
    rmLock(root);
    assert.equal(before(root, 'ai-headquarters:unit').d, 'ask');
    started(root, 'unit');
    const l = JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters', 'state', 'unit-lock.json'), 'utf8'));
    assert.equal(l.status, 'running');
    assert.equal(l.session_id, 'S1');
    assert.match(String(l.agent_id), /^ag\d+$/);
    const r = before(root, 'ai-headquarters:unit');
    assert.equal(r.d, 'deny', '実行中の unit があれば、上限の確認より先に「同時に1体」で止める');
    assert.match(r.reason, /同時に1体/);
  });
  test('上限に達していても、実行中の unit があれば、確認ではなく止める', () => {
    const root = fix();
    approve(root);
    started(root); started(root, 'unit');
    const r = before(root, 'ai-headquarters:unit');
    assert.equal(r.d, 'deny');
    assert.match(r.reason, /同時に1体/);
  });
  // 新1(直したあとの確かめの指摘): 無効になった古い「実行中」の記録が残っていても、上限の確認を通った unit が持ち主になり、書ける
  const lockFile = (root) => path.join(root, '.ai-headquarters', 'state', 'unit-lock.json');
  const staleRunning = () => ({ session_id: 'S0', status: 'running', created_at: Date.now() - 60 * 60000, started_at: Date.now() - 60 * 60000, touched_at: Date.now() - 31 * 60000, agent_id: 'old' });
  function startUnit(root, id) {
    const r = spawnSync(process.execPath, [GUARD, 'subagent-start'], { input: JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'SubagentStart', agent_type: 'ai-headquarters:unit', agent_id: id }), encoding: 'utf8', env: env(root) });
    assert.equal(r.status, 0, r.stderr);
  }
  function unitEdit(root, id) {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit', agent_id: id, agent_type: 'ai-headquarters:unit', permission_mode: 'default',
        tool_input: { file_path: path.join(root, 'src', 'a.js'), old_string: 'a', new_string: 'b' } }),
      encoding: 'utf8', env: env(root),
    });
    assert.equal(r.status, 0, r.stderr);
    const h = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput || {} : {};
    return { d: h.permissionDecision || null, reason: h.permissionDecisionReason || '' };
  }
  test('無効な「実行中」の記録が残っていても、上限の確認を通った unit が、起動の知らせで持ち主になり、書ける', () => {
    const root = fix();
    approve(root);
    started(root); started(root, 'unit');
    fs.writeFileSync(lockFile(root), JSON.stringify(staleRunning()));
    assert.equal(before(root, 'ai-headquarters:unit').d, 'ask');
    startUnit(root, 'agNew');
    const l = JSON.parse(fs.readFileSync(lockFile(root), 'utf8'));
    assert.equal(l.status, 'running');
    assert.equal(l.agent_id, 'agNew');
    assert.equal(l.session_id, 'S1');
    const w = unitEdit(root, 'agNew');
    assert.notEqual(w.d, 'deny', w.reason);
    assert.equal(unitEdit(root, 'agOther').d, 'deny', '持ち主でない unit は書けない');
  });
  test('無効な「実行中」の記録が残っていても、起動の知らせが届かないまま、上限の確認を通った unit が書ける', () => {
    const root = fix();
    approve(root);
    started(root); started(root, 'unit');
    fs.writeFileSync(lockFile(root), JSON.stringify(staleRunning()));
    assert.equal(before(root, 'ai-headquarters:unit').d, 'ask');
    const w = unitEdit(root, 'agNew');
    assert.notEqual(w.d, 'deny', w.reason);
  });
  test('有効な「実行中」の記録(別の unit が動いている)は、上限の確認の前に止め、記録を変えない', () => {
    const root = fix();
    approve(root);
    started(root); started(root, 'unit');
    const live = { ...staleRunning(), session_id: 'S1', touched_at: Date.now() - 60000 };
    fs.writeFileSync(lockFile(root), JSON.stringify(live));
    assert.equal(before(root, 'ai-headquarters:unit').d, 'deny');
    startUnit(root, 'agNew');
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile(root), 'utf8')), live, '起動の知らせでも、有効な記録は書き換えない');
  });
  // 軽8(点検の指摘): 確認の理由文は、確認の画面で指揮官が読む
  test('上限の確認の理由文は、指揮官に向けて、許すとどうなるかと、断ってよいときを書く', () => {
    const root = fix();
    approve(root);
    started(root); started(root);
    const r = before(root, 'inspector');
    assert.equal(r.d, 'ask');
    assert.match(r.reason, /許すと/);
    assert.match(r.reason, /断ってください/);
    assert.match(r.reason, /メインセッションへ/);
  });
  test('作戦記録の欄を書き換えても、「承認」のときに控えた値で数える', () => {
    const root = fix();
    approve(root);
    fs.writeFileSync(opFile(root), OP('99回'));
    started(root); started(root);
    assert.equal(before(root).d, 'ask');
  });
  test('「承認」の前は、数えるだけで止めない。承認のあとは、それまでの回数も数える', () => {
    const root = fix();
    started(root); started(root); started(root);
    assert.equal(before(root).d, null);
    approve(root);
    assert.equal(before(root).d, 'ask');
  });
  test('控えた値が無い(欄が無い、数字を読めない)ときは止めない', () => {
    for (const body of [OP('未定'), OP().replace(/### 起動の上限\n.*\n/, '')]) {
      const root = fix(body);
      approve(root);
      for (let i = 0; i < 5; i++) started(root);
      const r = before(root);
      assert.equal(r.d, null);
      assert.equal(r.msg, '');
    }
  });
  test('結果を書き終えた作戦では、数えず、止めない', () => {
    const root = fix();
    approve(root);
    started(root); started(root);
    fs.writeFileSync(opFile(root), OP('2回', '必成目標を達成した'));
    started(root);
    assert.equal(before(root).d, null);
    fs.writeFileSync(opFile(root), OP('2回'));
    assert.equal(before(root).d, 'ask', '結果を書き終えたあとの起動は数えていない(2回のまま)');
  });
  test('作戦記録が無いときは、何も作らない', () => {
    const root = path.join(TMP, `none${++seq}`);
    fs.mkdirSync(root, { recursive: true });
    started(root);
    assert.equal(before(root).d, null);
    assert.ok(!fs.existsSync(path.join(root, '.ai-headquarters')));
  });
  test('4体以外のサブエージェントは数えない', () => {
    const root = fix();
    approve(root);
    for (const t of ['general-purpose', 'Explore', 'other:unit']) started(root, t);
    assert.equal(before(root).msg, '');
    assert.equal(before(root, 'general-purpose').d, null, '4体以外の起動の前には何も出さない');
  });
  test('作戦ごとに数える(新しい作戦記録では0から)', () => {
    const root = fix();
    approve(root);
    started(root); started(root);
    fs.writeFileSync(opFile(root, 'OP-002'), OP('2回'));
    approve(root);
    assert.equal(before(root).d, null);
  });
  test('並列に起動した3体を、取りこぼさずに数える', async () => {
    const root = fix(OP('3回'));
    approve(root);
    await Promise.all([1, 2, 3].map((i) => new Promise((resolve) => {
      const c = spawn(process.execPath, [GUARD, 'subagent-start'], { env: env(root) });
      c.on('close', resolve);
      c.stdin.end(JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'SubagentStart', agent_type: 'intel', agent_id: `par${i}` }));
    })));
    assert.equal(before(root).d, 'ask');
  });
  test('状態ファイルが壊れていても、異常終了しない', () => {
    const root = fix();
    approve(root);
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'state', 'launches.jsonl'), '{bad\n\nnull\n');
    started(root);
    assert.equal(before(root).d, null);
    assert.match(before(root).msg, /起動 2\/2 回/);
  });
});
