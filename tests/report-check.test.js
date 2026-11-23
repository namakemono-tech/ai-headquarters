'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

const RC = path.join(__dirname, '..', 'hooks', 'report-check.js');
const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
const HOOKS = path.join(__dirname, '..', 'hooks', 'hooks.json');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'rc-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

let seq = 0;
function fix({ ahq = true } = {}) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  if (ahq) fs.mkdirSync(path.join(root, '.ai-headquarters', 'state'), { recursive: true });
  return root;
}
const stateDir = (root) => path.join(root, '.ai-headquarters', 'state');
const retriesPath = (root) => path.join(stateDir(root), 'report-retries.json');
const lockPath = (root) => path.join(stateDir(root), 'unit-lock.json');
const readRetries = (root) => JSON.parse(fs.readFileSync(retriesPath(root), 'utf8'));

function runRaw(script, stdin, root) {
  return spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
}
const run = (root, input) => runRaw(RC, JSON.stringify({ cwd: root, session_id: 'S1', ...input }), root);

const GOOD = {
  intel: '【任務番号】OP-001-1\n【結論】x\n【根拠】y\n【未解決・懸念】なし\n【推測】なし',
  plans: '【任務番号】OP-001-1\n【結論】x\n【根拠】y\n【未解決・懸念】なし\n【推測】なし',
  inspector: '【任務番号】OP-001-3\n【結論】x\n【根拠】y\n【目標の達成】なし\n【未解決・懸念】なし\n【物差しの外の指摘】なし\n【推測】なし',
  unit: '【任務番号】OP-001-2\n【結論】x\n【根拠】y\n【実施内容】a.js を変更\n【目標の達成】なし\n【未解決・懸念】なし\n【推測】なし',
};
const BAD = '【任務番号】OP-009-1\n【結論】x\n【根拠】y\n【推測】なし'; // 【未解決・懸念】が欠け(unit では【実施内容】も)

const handback = (root, type, message, id = 'A1') =>
  run(root, { hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', agent_id: id, agent_type: type, tool_input: { message } });
const stop = (root, type, msg, id = 'A1', extra = {}) =>
  run(root, { hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, last_assistant_message: msg, stop_hook_active: false, ...extra });
const json = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);
const isDeny = (r) => { const o = json(r); return !!o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'; };
const isBlock = (r) => { const o = json(r); return !!o && o.decision === 'block'; };
const silent = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout, ''); };

describe('hooks.json の登録', () => {
  const h = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
  test('PreToolUse(SubagentHandback)', () => {
    const e = h.PreToolUse.find((x) => x.matcher === 'SubagentHandback');
    assert.ok(e);
    assert.deepEqual(e.hooks[0], { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/report-check.js'], timeout: 10 });
    assert.equal(e.hooks[0].onFailure, undefined);
  });
  test('SubagentStop は4体の matcher(SubagentStart と同じ書き方)・onFailure なし', () => {
    assert.equal(h.SubagentStop.length, 1);
    assert.equal(h.SubagentStop[0].matcher, '^(ai-headquarters:)?(intel|plans|unit|inspector)$');
    assert.deepEqual(h.SubagentStop[0].hooks[0], { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/report-check.js'], timeout: 10 });
  });
  test('既存の登録は変わらない', () => {
    assert.equal(h.PreToolUse[0].hooks[0].onFailure, 'block');
    assert.deepEqual(h.PreToolUse[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/guard.js']);
    assert.deepEqual(h.SubagentStart[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/guard.js', 'subagent-start']);
  });
});

describe('4体ごとの確認(Handback と SubagentStop)', () => {
  for (const role of ['intel', 'plans', 'unit', 'inspector']) {
    for (const prefix of ['', 'ai-headquarters:']) {
      const t = prefix + role;
      test(`${t}: そろっていれば通る`, () => {
        const root = fix();
        silent(handback(root, t, GOOD[role]));
        silent(stop(root, t, GOOD[role], 'B1'));
      });
    }
    test(`${role}: Handback は1回目に差し戻し、2回目は警告付きで通る`, () => {
      const root = fix();
      const r1 = handback(root, role, BAD);
      assert.equal(r1.status, 0);
      assert.ok(isDeny(r1));
      const reason = json(r1).hookSpecificOutput.permissionDecisionReason;
      assert.match(reason, /【未解決・懸念】/);
      assert.match(reason, /mission-order スキルの報告の型で書き直してください/);
      assert.equal(readRetries(root).A1.count, 1);
      const r2 = handback(root, role, BAD);
      assert.equal(r2.status, 0);
      assert.ok(!isDeny(r2));
      const o = json(r2);
      assert.deepEqual(Object.keys(o), ['systemMessage']);
      assert.ok(o.systemMessage.includes(`OP-009-1(${role})の報告に`), o.systemMessage);
      assert.match(o.systemMessage, /【未解決・懸念】.*が欠けています/);
      // 3回目以降も通る
      assert.ok(!isDeny(handback(root, role, BAD)));
    });
    test(`${role}: SubagentStop は1回目に差し戻し、2回目は警告付きで通る`, () => {
      const root = fix();
      const r1 = stop(root, role, BAD);
      assert.equal(r1.status, 0);
      assert.ok(isBlock(r1));
      assert.match(json(r1).reason, /【未解決・懸念】/);
      assert.match(json(r1).reason, /mission-order スキルの報告の型で書き直してください/);
      const r2 = stop(root, role, BAD, 'A1', { stop_hook_active: true });
      assert.ok(!isBlock(r2));
      assert.deepEqual(Object.keys(json(r2)), ['systemMessage']);
      assert.ok(json(r2).systemMessage.includes(`OP-009-1(${role})の報告に`), json(r2).systemMessage);
      assert.match(json(r2).systemMessage, /が欠けています/);
    });
  }
  test('差し戻しの回数は agent_id ごと', () => {
    const root = fix();
    assert.ok(isBlock(stop(root, 'inspector', BAD, 'A1')));
    assert.ok(isBlock(stop(root, 'inspector', BAD, 'A2')));
    assert.ok(!isBlock(stop(root, 'inspector', BAD, 'A1')));
  });
  test('Handback で1回、SubagentStop で1回の合算でも2回目は通る', () => {
    const root = fix();
    assert.ok(isDeny(handback(root, 'intel', BAD)));
    assert.ok(!isBlock(stop(root, 'intel', BAD)));
  });
});

describe('見出しの判定', () => {
  test('unit だけ【実施内容】が必須', () => {
    const noWork = GOOD.unit.replace(/【実施内容】.*\n/, '');
    const root = fix();
    const r = stop(root, 'unit', noWork);
    assert.ok(isBlock(r));
    assert.match(json(r).reason, /【実施内容】/);
    // 他の役は【実施内容】が無くても通る
    for (const role of ['intel', 'plans', 'inspector']) silent(stop(fix(), role, GOOD[role]));
  });
  test('unit と inspector だけ【目標の達成】が必須(0.2.0)', () => {
    for (const role of ['unit', 'inspector']) {
      const r = stop(fix(), role, GOOD[role].replace(/【目標の達成】.*\n/, ''));
      assert.ok(isBlock(r), role);
      assert.match(json(r).reason, /【目標の達成】/);
      const h = handback(fix(), role, GOOD[role].replace(/【目標の達成】.*\n/, ''));
      assert.ok(isDeny(h), role);
      assert.match(json(h).hookSpecificOutput.permissionDecisionReason, /【目標の達成】/);
    }
    // intel と plans は【目標の達成】が無くても通る
    for (const role of ['intel', 'plans']) silent(stop(fix(), role, GOOD[role]));
  });
  test('inspector だけ【物差しの外の指摘】が必須で、欠けていれば1回だけ差し戻す(0.4.0)', () => {
    const noOut = GOOD.inspector.replace('【物差しの外の指摘】なし\n', '');
    const root = fix();
    const r = stop(root, 'inspector', noOut, 'A1');
    assert.ok(isBlock(r));
    assert.match(json(r).reason, /【物差しの外の指摘】/);
    assert.ok(!isBlock(stop(root, 'inspector', noOut, 'A1')), '2回目は警告を付けて通す');
    const h = handback(fix(), 'inspector', noOut);
    assert.ok(isDeny(h));
    assert.match(json(h).hookSpecificOutput.permissionDecisionReason, /【物差しの外の指摘】/);
    // unit、intel、plans には求めない
    silent(stop(fix(), 'unit', GOOD.unit));
    assert.ok(!GOOD.unit.includes('物差しの外'));
    for (const role of ['intel', 'plans']) silent(stop(fix(), role, GOOD[role]));
  });
  test('【物差しの外の指摘】の中身(重さと根拠)は問わない', () => {
    const t = GOOD.inspector.replace('【物差しの外の指摘】なし', '【物差しの外の指摘】\n中: 変数名がそろっていない(src/a.js 12行)');
    silent(stop(fix(), 'inspector', t));
  });
  test('【目標の達成】の中身(必成と望成の行)は問わない', () => {
    const t = GOOD.unit.replace('【目標の達成】なし', '【目標の達成】\n必成: 達成\n望成1: 捨てた(損耗限度の試行1回に達したため)');
    silent(stop(fix(), 'unit', t));
  });
  test('計画書の見出しが入った plans の報告(記入例)が通る', () => {
    const plan = [
      '【任務番号】OP-003-1', '【結論】ログイン画面の入力チェックは、共通関数に寄せる案を勧めます。以下が計画書です。',
      '【目標】入力チェックを validate に統一する', '【手順】', '1. 担当: unit', '   完了条件: npm test が通る',
      '【リスク】x', '【代替案】y', '【切り替える条件】z', '【切り替えられる最後の時点】w',
      '【根拠】src/auth/login.js 12〜30行', '【未解決・懸念】なし', '【推測】未確認です',
    ].join('\n');
    silent(handback(fix(), 'plans', plan));
    silent(stop(fix(), 'plans', plan));
  });
  test('欄が空・見出しが重複していても通る', () => {
    const t = '【任務番号】\n【結論】\n【結論】\n【根拠】\n【未解決・懸念】\n【推測】';
    silent(stop(fix(), 'intel', t));
  });
  test('行頭の空白(全角を含む)は許す', () => {
    const t = '  【任務番号】a\n\t【結論】b\n　【根拠】c\n　 【目標の達成】なし\n【未解決・懸念】d\n 【物差しの外の指摘】なし\n   【推測】e';
    silent(stop(fix(), 'inspector', t));
  });
  test('見出しが行の途中にしか無ければ欠け', () => {
    const t = '【任務番号】a\n【結論】b\n【根拠】c\n【未解決・懸念】d\n要するに【推測】なし';
    const r = stop(fix(), 'intel', t);
    assert.ok(isBlock(r));
    assert.match(json(r).reason, /【推測】/);
  });
  test('欠けている見出しがすべて理由に入る', () => {
    const r = stop(fix(), 'unit', '【結論】x');
    for (const h of ['任務番号', '根拠', '実施内容', '目標の達成', '未解決・懸念', '推測']) assert.match(json(r).reason, new RegExp(`【${h}】`));
  });
});

describe('対象外', () => {
  test('4体以外のエージェントは何もしない', () => {
    for (const type of ['Explore', 'general-purpose', 'other:unit', 'units', '']) {
      const root = fix();
      silent(handback(root, type, BAD));
      silent(stop(root, type, BAD));
      assert.equal(fs.existsSync(retriesPath(root)), false);
    }
  });
  test('メインセッション(agent_id なし)は何もしない', () => {
    const root = fix();
    silent(run(root, { hook_event_name: 'SubagentStop', agent_type: 'unit', last_assistant_message: BAD }));
    silent(run(root, { hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', agent_type: 'unit', tool_input: { message: BAD } }));
    silent(run(root, { hook_event_name: 'SubagentStop', last_assistant_message: BAD }));
    assert.equal(fs.existsSync(retriesPath(root)), false);
  });
  test('Handback 以外の PreToolUse と他のイベントは何もしない', () => {
    const root = fix();
    silent(run(root, { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'A1', agent_type: 'unit', tool_input: { message: BAD } }));
    silent(run(root, { hook_event_name: 'SubagentStart', agent_id: 'A1', agent_type: 'unit', last_assistant_message: BAD }));
  });
});

describe('Handback を通過したあとの SubagentStop', () => {
  test('通過済みなら、欠けた最後の応答でも確かめない', () => {
    const root = fix();
    silent(handback(root, 'inspector', GOOD.inspector));
    assert.equal(readRetries(root).A1.passed, true);
    silent(stop(root, 'inspector', 'ありがとうございました'));
  });
  test('警告付きで通した後も確かめない', () => {
    const root = fix();
    handback(root, 'intel', BAD);
    handback(root, 'intel', BAD);
    silent(stop(root, 'intel', 'closing text'));
  });
  test('別の agent_id には効かない', () => {
    const root = fix();
    handback(root, 'inspector', GOOD.inspector, 'A1');
    assert.ok(isBlock(stop(root, 'inspector', 'closing text', 'A2')));
  });
  test('last_assistant_message が無く通過済みの記録も無ければ通す', () => {
    const root = fix();
    silent(run(root, { hook_event_name: 'SubagentStop', agent_id: 'A1', agent_type: 'intel' }));
    silent(stop(root, 'intel', '   '));
    assert.equal(fs.existsSync(retriesPath(root)), false);
  });
});

describe('unit の予約の解除', () => {
  const lock = (root, o) => fs.writeFileSync(lockPath(root), JSON.stringify({ created_at: Date.now(), ...o }));
  test('合格・2回目の通過・確かめずに通す場合に消える(agent_id 一致)', () => {
    let root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: 'A1', started_at: Date.now() });
    silent(stop(root, 'unit', GOOD.unit));
    assert.equal(fs.existsSync(lockPath(root)), false);
    root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: 'A1', started_at: Date.now() });
    stop(root, 'unit', BAD); assert.equal(fs.existsSync(lockPath(root)), true);
    stop(root, 'unit', BAD, 'A1', { stop_hook_active: true });
    assert.equal(fs.existsSync(lockPath(root)), false);
    root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: 'A1', started_at: Date.now() });
    run(root, { hook_event_name: 'SubagentStop', agent_id: 'A1', agent_type: 'ai-headquarters:unit' });
    assert.equal(fs.existsSync(lockPath(root)), false);
  });
  test('Handback 通過後の SubagentStop でも消える', () => {
    const root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: 'A1', started_at: Date.now() });
    handback(root, 'unit', GOOD.unit);
    assert.equal(fs.existsSync(lockPath(root)), true); // Handback の時点では消さない
    silent(stop(root, 'unit', 'closing'));
    assert.equal(fs.existsSync(lockPath(root)), false);
  });
  test('予約(reserved)と agent_id が null の記録は消さない(別の unit の予約を消さないため)', () => {
    const root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: null });
    stop(root, 'unit', GOOD.unit);
    assert.equal(fs.existsSync(lockPath(root)), true);
    const r2 = fix(); lock(r2, { session_id: 'S1', status: 'reserved' });
    stop(r2, 'unit', GOOD.unit);
    assert.equal(fs.existsSync(lockPath(r2)), true);
    const r3 = fix(); lock(r3, { session_id: 'S1', status: 'reserved', agent_id: 'A1' });
    stop(r3, 'unit', GOOD.unit);
    assert.equal(fs.existsSync(lockPath(r3)), true);
  });
  test('前の unit の SubagentStop で、次の unit の予約は消えない', () => {
    const root = fix();
    lock(root, { session_id: 'S1', status: 'running', agent_id: 'A1', started_at: Date.now() });
    stop(root, 'unit', GOOD.unit, 'A1');
    assert.equal(fs.existsSync(lockPath(root)), false);
    lock(root, { session_id: 'S1', status: 'reserved' }); // 次の unit の予約
    stop(root, 'unit', GOOD.unit, 'A1'); // 前の unit の SubagentStop がもう一度来ても
    assert.equal(fs.existsSync(lockPath(root)), true);
  });
  test('差し戻すときは消さない', () => {
    const root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: 'A1' });
    assert.ok(isBlock(stop(root, 'unit', BAD)));
    assert.equal(fs.existsSync(lockPath(root)), true);
  });
  test('別のセッション・別の agent_id のロックは消さない', () => {
    let root = fix(); lock(root, { session_id: 'S2', status: 'running', agent_id: 'A1' });
    stop(root, 'unit', GOOD.unit);
    assert.equal(fs.existsSync(lockPath(root)), true);
    root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: 'A9' });
    stop(root, 'unit', GOOD.unit);
    assert.equal(fs.existsSync(lockPath(root)), true);
  });
  test('unit 以外の SubagentStop では消さない。unit-scope.json は消さない', () => {
    const root = fix(); lock(root, { session_id: 'S1', status: 'running', agent_id: 'A1' });
    fs.writeFileSync(path.join(stateDir(root), 'unit-scope.json'), '{"valid":false}');
    stop(root, 'inspector', GOOD.inspector);
    assert.equal(fs.existsSync(lockPath(root)), true);
    stop(root, 'unit', GOOD.unit);
    assert.equal(fs.existsSync(path.join(stateDir(root), 'unit-scope.json')), true);
  });
  test('guard.js: 解除後に次の unit を起動できる', () => {
    const root = fix();
    fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-001.md'), 'x');
    fs.writeFileSync(path.join(stateDir(root), 'approval.json'), JSON.stringify({ session_id: 'S1', operation: 'OP-001', ts: new Date().toISOString(), plan: '2026-11-22T00:00:00Z', fingerprint: FP.fingerprintOf('x') }));
    const launch = () => {
      const r = runRaw(GUARD, JSON.stringify({
        session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu1',
        tool_input: { subagent_type: 'unit', prompt: '【変更してよいファイル】\n- src/a.js' },
      }), root);
      const o = r.stdout.trim() ? JSON.parse(r.stdout) : null;
      return o && o.hookSpecificOutput ? o.hookSpecificOutput.permissionDecision : null;
    };
    assert.equal(launch(), null);
    assert.equal(launch(), 'deny'); // 予約が残っている
    runRaw(GUARD, JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'SubagentStart', agent_type: 'unit', agent_id: 'A1' }), root);
    assert.equal(JSON.parse(fs.readFileSync(lockPath(root), 'utf8')).status, 'running');
    assert.equal(launch(), 'deny');
    silent(stop(root, 'unit', GOOD.unit));
    assert.equal(launch(), null);
  });
});

describe('.ai-headquarters が無い場合', () => {
  test('ファイルもフォルダも作らない', () => {
    const root = fix({ ahq: false });
    handback(root, 'intel', BAD);
    handback(root, 'unit', GOOD.unit);
    stop(root, 'intel', BAD);
    stop(root, 'unit', GOOD.unit);
    assert.deepEqual(fs.readdirSync(root), []);
  });
  test('SubagentStop は差し戻すが、stop_hook_active が true なら警告付きで通す', () => {
    const root = fix({ ahq: false });
    assert.ok(isBlock(stop(root, 'intel', BAD)));
    assert.ok(isBlock(stop(root, 'intel', BAD))); // 記録できないので毎回差し戻す(Claude Code 側の目印が頼り)
    const r = stop(root, 'intel', BAD, 'A1', { stop_hook_active: true });
    assert.ok(!isBlock(r));
    assert.match(json(r).systemMessage, /欠けています/);
  });
  test('Handback は回数を記録できないので通す(警告付き)', () => {
    const root = fix({ ahq: false });
    const r = handback(root, 'intel', BAD);
    assert.ok(!isDeny(r));
    assert.match(json(r).systemMessage, /欠けています/);
  });
});

describe('異常な入力と古い記録', () => {
  test('壊れた入力でも exit 0 で何も出さない', () => {
    const root = fix();
    for (const raw of ['{bad', '', 'null', '[]', '"x"', '{"hook_event_name":"SubagentStop","agent_id":5,"agent_type":{}}',
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', agent_id: 'A', agent_type: 'unit', tool_input: null }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', agent_id: 'A', agent_type: 'unit', tool_input: { message: 5 } }),
      JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'A', agent_type: 'unit', last_assistant_message: 5 })]) {
      const r = runRaw(RC, raw, root);
      assert.equal(r.status, 0, raw);
      assert.equal(r.stdout, '', raw);
    }
  });
  test('状態ファイルが壊れていても動く', () => {
    const root = fix();
    fs.writeFileSync(retriesPath(root), '{broken');
    assert.ok(isBlock(stop(root, 'intel', BAD)));
    assert.equal(readRetries(root).A1.count, 1);
  });
  test('24時間より古い記録は書くたびに捨てる', () => {
    const root = fix();
    const now = Date.now();
    fs.writeFileSync(retriesPath(root), JSON.stringify({
      OLD: { count: 1, ts: now - 25 * 3600 * 1000 }, NEW: { count: 1, ts: now - 23 * 3600 * 1000 },
    }));
    assert.ok(isBlock(stop(root, 'intel', BAD, 'A1')));
    const s = readRetries(root);
    assert.equal(s.OLD, undefined);
    assert.equal(s.NEW.count, 1);
    assert.equal(s.A1.count, 1);
  });
  test('古い記録は、別の agent_id の書き込みでも捨てられる', () => {
    const root = fix();
    fs.writeFileSync(retriesPath(root), JSON.stringify({ A1: { count: 1, ts: Date.now() - 25 * 3600 * 1000 } }));
    stop(root, 'intel', GOOD.intel, 'A2');
    handback(root, 'intel', GOOD.intel, 'A3');
    const s = readRetries(root);
    assert.equal(s.A1, undefined);
    assert.equal(s.A3.passed, true);
    assert.equal(s.A2, undefined);
  });
});

describe('auto モード(権限モード auto)の SubagentStop', () => {
  const CLOSING = '報告を渡しました。';
  for (const ahq of [false, true]) {
    test(`締めの文は確かめない(.ai-headquarters ${ahq ? 'あり' : 'なし'})`, () => {
      const root = fix({ ahq });
      silent(handback(root, 'inspector', GOOD.inspector));
      silent(stop(root, 'inspector', CLOSING, 'A1', { permission_mode: 'auto' }));
      silent(stop(root, 'intel', CLOSING, 'A2', { permission_mode: 'auto' }));
      silent(stop(root, 'unit', BAD, 'A3', { permission_mode: 'auto' }));
    });
  }
  test('auto でも unit の予約は解除する', () => {
    const root = fix();
    fs.writeFileSync(lockPath(root), JSON.stringify({ session_id: 'S1', status: 'running', agent_id: 'A1', created_at: Date.now() }));
    silent(stop(root, 'unit', CLOSING, 'A1', { permission_mode: 'auto' }));
    assert.equal(fs.existsSync(lockPath(root)), false);
  });
  test('auto 以外では、締めの文は欠けとみなす(通過済みの記録が無い場合)', () => {
    assert.ok(isBlock(stop(fix(), 'intel', CLOSING, 'A1', { permission_mode: 'default' })));
  });
  test('auto の Handback の確認は、これまでどおり行う', () => {
    assert.ok(isDeny(run(fix(), { hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', agent_id: 'A1', agent_type: 'intel', permission_mode: 'auto', tool_input: { message: BAD } })));
  });
});

describe('並列で動いても記録が消えない', () => {
  const { spawn } = require('node:child_process');
  const N = 6; // 同時の数。負荷で1秒以内にロックを取れず記録を諦めること(J44)があるため、多くしすぎない
  // 諦めた分は設計どおりの振る舞い。全件が残る場面を最大3回まで試し、1回でも全件残れば合格とする
  const attempt = async (mk, ok) => {
    let last = '';
    for (let k = 0; k < 3; k++) {
      const root = fix();
      await many(root, mk);
      const s = readRetries(root);
      last = '';
      for (let i = 0; i < N; i++) if (!ok(s[`P${i}`])) last += ` P${i}`;
      if (!last && fs.existsSync(path.join(stateDir(root), 'report-retries.lock'))) last = ' lock残り';
      if (!last) return;
    }
    assert.fail('3回とも記録が欠けた:' + last);
  };
  const many = (root, mk) => Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [RC], { env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify({ cwd: root, session_id: 'S1', agent_id: `P${i}`, agent_type: 'intel', ...mk(i) }));
  })));
  test('並列の SubagentStop の回数がすべて残る', async () => {
    await attempt(() => ({ hook_event_name: 'SubagentStop', last_assistant_message: BAD, stop_hook_active: false }), (r) => r && r.count === 1);
  });
  test('並列の Handback の通過がすべて残る', async () => {
    await attempt(() => ({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: GOOD.intel } }), (r) => r && r.passed === true);
  });
  test('5秒より古いロックは捨てて記録する', () => {
    const root = fix();
    const lp = path.join(stateDir(root), 'report-retries.lock');
    fs.writeFileSync(lp, '');
    const old = new Date(Date.now() - 10000);
    fs.utimesSync(lp, old, old);
    assert.ok(isBlock(stop(root, 'intel', BAD)));
    assert.equal(readRetries(root).A1.count, 1);
  });
  test('ロックが取れないときは記録を諦めて通す(差し戻さない)', () => {
    const root = fix();
    fs.writeFileSync(path.join(stateDir(root), 'report-retries.lock'), '');
    const t0 = Date.now();
    const r = stop(root, 'intel', BAD);
    assert.equal(r.status, 0);
    assert.ok(!isBlock(r));
    assert.ok(Date.now() - t0 < 8000);
    const lk = path.join(stateDir(root), 'report-retries.lock'); fs.utimesSync(lk, new Date(), new Date()); // 待ち時間(3秒)の間に古いロックとみなされないよう、時刻を新しくする
    assert.ok(!isDeny(handback(root, 'intel', BAD)));
    assert.equal(fs.existsSync(retriesPath(root)), false);
  });
});

describe('見出しの飾り', () => {
  const names = ['任務番号', '結論', '根拠', '未解決・懸念', '推測'];
  const build = (forms) => names.map((n, i) => forms[i % forms.length].replace('X', `【${n}】`)).join('\n');
  for (const [name, forms] of [
    ['太字', ['**X** a']], ['見出し記法', ['## X', '# X', '###### X']], ['箇条書き', ['- X a', '* X a', '  - X']],
    ['引用', ['> X a', '>X']], ['組み合わせ', ['> - **X** a', '- ## X']],
  ]) {
    test(name, () => silent(stop(fix(), 'intel', build(forms))));
  }
  test('行の途中の見出しは欠けのまま', () => {
    for (const bad of ['要点: **【推測】** なし', 'a - 【推測】なし', 'x# 【推測】']) {
      const t = '【任務番号】a\n【結論】b\n【根拠】c\n【未解決・懸念】d\n' + bad;
      assert.ok(isBlock(stop(fix(), 'intel', t)), bad);
    }
  });
});

describe('SKILL.md と plans.md の記入例', () => {
  // plans の報告の記入例は、0.4.0 で agents/plans.md に移した
  const md = fs.readFileSync(path.join(__dirname, '..', 'skills', 'mission-order', 'SKILL.md'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'agents', 'plans.md'), 'utf8');
  const block = (re) => { const m = re.exec(md); assert.ok(m, String(re)); return m[1]; };
  for (const [role, re] of [
    ['unit', /報告\(unit\)[^\n]*\n\n```text\n([\s\S]*?)```/],
    ['plans', /## 記入例\(報告\)[\s\S]*?```text\n([\s\S]*?)```/],
    ['unit', /## 報告\(各エージェント → メインセッション\)\n\n```text\n([\s\S]*?)```/],
  ]) {
    test(`${role} の記入例が通る: ${String(re).slice(1, 14)}`, () => {
      const ex = block(re);
      assert.match(ex, /【任務番号】/);
      silent(handback(fix(), role, ex));
      silent(stop(fix(), role, ex));
    });
  }
});

describe('再点検の指摘 A〜D と timeout', () => {
  test('A: state/ が無くても1回目は差し戻す(Handback と SubagentStop)', () => {
    for (const mode of ['stop', 'handback']) {
      const root = fix({ ahq: false });
      fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
      const r = mode === 'stop' ? stop(root, 'intel', BAD) : handback(root, 'plans', BAD);
      assert.ok(mode === 'stop' ? isBlock(r) : isDeny(r), mode);
      assert.equal(readRetries(root).A1.count, 1);
    }
  });
  test('B: 行頭の記号が長くても1秒以内に判定する', () => {
    for (const line of ['#'.repeat(40) + 'x', '*'.repeat(40) + 'x', '#'.repeat(30) + '*'.repeat(30) + ' - > x']) {
      const t = BAD + '\n' + line + '【未解決・懸念】';
      const t0 = Date.now();
      const r = stop(fix(), 'intel', t);
      assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
      assert.ok(isBlock(r)); // 行の途中の見出しは欠けのまま
    }
  });
  test('C: ロックの名前でフォルダがあっても、約3秒で通って終わる', () => {
    const root = fix();
    fs.mkdirSync(path.join(stateDir(root), 'report-retries.lock'));
    fs.utimesSync(path.join(stateDir(root), 'report-retries.lock'), new Date(Date.now() - 20000), new Date(Date.now() - 20000));
    const t0 = Date.now();
    const r = stop(root, 'intel', BAD);
    assert.equal(r.status, 0);
    assert.ok(!isBlock(r));
    assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0}ms`);
  });
  test('D: 他人のロックは、自分のものでなければ解除しない(古いロックを捨てても残らない)', () => {
    // 負荷で1秒以内に取れず記録を諦めた場合(J44)は設計どおり。その回は失敗とせず、最大3回までやり直す
    let blocked = false; let left = true;
    for (let k = 0; k < 3 && !blocked; k++) {
      const root = fix();
      const lp = path.join(stateDir(root), 'report-retries.lock');
      fs.writeFileSync(lp, 'other-owner');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(lp, old, old);
      blocked = isBlock(stop(root, 'intel', BAD));
      left = fs.existsSync(lp);
      if (blocked) assert.equal(left, false); // 古いロックは捨て、自分のロックも解除済み
    }
    assert.ok(blocked, '3回とも諦めた');
  });
  test('timeout: report-check・approval・session-start の登録に 10、guard には付けない', () => {
    const h = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
    const to = (e) => e.hooks[0].timeout;
    assert.equal(to(h.PreToolUse.find((x) => x.matcher === 'SubagentHandback')), 10);
    assert.equal(to(h.SubagentStop[0]), 10);
    assert.equal(to(h.UserPromptSubmit[0]), 10);
    assert.equal(to(h.SessionStart[0]), 10);
    assert.equal(to(h.PreToolUse[0]), undefined);
    assert.equal(to(h.SubagentStart[0]), undefined);
  });
});
