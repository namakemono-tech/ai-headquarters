'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APPROVAL = path.join(__dirname, '..', 'hooks', 'approval.js');
const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'ap-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

let seq = 0;
function fix(ops = []) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  for (const n of ops) {
    fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', `${n}.md`), 'x');
  }
  return root;
}
function run(script, stdin, root) {
  return spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
}
const submit = (root, prompt, session = 'S1') =>
  run(APPROVAL, JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'UserPromptSubmit', prompt }), root);
const appPath = (root) => path.join(root, '.ai-headquarters', 'state', 'approval.json');
const readApp = (root) => JSON.parse(fs.readFileSync(appPath(root), 'utf8'));
const launch = (root, session) => {
  const r = run(GUARD, JSON.stringify({
    session_id: session, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu1',
    tool_input: { subagent_type: 'unit', prompt: '【変更してよいファイル】\n- src/a.js' },
  }), root);
  const o = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return o && o.hookSpecificOutput ? o.hookSpecificOutput.permissionDecision : null;
};

describe('approval.js: 一致の規則', () => {
  for (const p of ['承認', ' 承認 ', '　承認　', '承認。', '承認!', '承認！', '承認！！', '承認。！!', ' 　承認。　\n']) {
    test(`一致: ${JSON.stringify(p)}`, () => {
      const root = fix(['OP-001']);
      const r = submit(root, p);
      assert.equal(r.status, 0);
      assert.ok(fs.existsSync(appPath(root)));
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(out.hookSpecificOutput.additionalContext, /指揮官の承認を OP-001 に記録しました/);
    });
  }
  const bad = ['承認します', '承認。続けて', '承認 お願い', '承認承認', '未承認', '承 認', 'approve', '', '<task-notification>\n<result>承認</result>\n</task-notification>', '承認\n承認', '承認?', 5, null];
  for (const p of bad) {
    test(`不一致: ${JSON.stringify(p)}`, () => {
      const root = fix(['OP-001']);
      const r = submit(root, p);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(fs.existsSync(appPath(root)), false);
    });
  }
});

describe('approval.js: 記録', () => {
  test('作戦記録が無ければ何も作らない(.ai-headquarters も)', () => {
    const root = fix();
    const r = submit(root, '承認');
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(path.join(root, '.ai-headquarters')), false);
    const c = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(c.hookEventName, 'UserPromptSubmit');
    assert.match(c.additionalContext, /作戦記録が無いため、承認は記録していません/);
    assert.match(c.additionalContext, /小規模の作業ならこのまま進めてください/);
    assert.match(c.additionalContext, /作戦記録を作ってから、もう一度「承認」と入力/);
  });
  test('operations が空のフォルダでも記録しない', () => {
    const root = fix();
    fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
    const r = submit(root, '承認');
    assert.equal(fs.existsSync(appPath(root)), false);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /記録していません/);
  });
  test('最大の番号に結び付き、形が正しい', () => {
    const root = fix(['OP-001', 'OP-003', 'OP-002']);
    submit(root, '承認', 'SX');
    const a = readApp(root);
    assert.equal(a.operation, 'OP-003');
    assert.equal(a.session_id, 'SX');
    assert.ok(!Number.isNaN(Date.parse(a.ts)));
    assert.deepEqual(fs.readdirSync(path.dirname(appPath(root))), ['approval.json']);
  });
  test('CLAUDE_PROJECT_DIR が無ければ cwd で最上位を決める', () => {
    const root = fix(['OP-004']);
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, [APPROVAL], { input: JSON.stringify({ session_id: 'S1', cwd: root, prompt: '承認' }), encoding: 'utf8', env });
    assert.equal(r.status, 0);
    assert.equal(readApp(root).operation, 'OP-004');
  });
  for (const b of ['', 'not json', '[]', 'null', '{"prompt":', '"承認"']) {
    test(`壊れた入力 ${JSON.stringify(b)} でも exit 0・出力なし`, () => {
      const root = fix(['OP-001']);
      const r = run(APPROVAL, b, root);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(fs.existsSync(appPath(root)), false);
    });
  }
  test('state が書けない(同名のファイルがある)ときも exit 0・出力なし', () => {
    const root = fix(['OP-001']);
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'state'), 'file');
    const r = submit(root, '承認');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('approval.js と guard.js の連携', () => {
  test('承認前は止まり、承認後は通る', () => {
    const root = fix(['OP-001']);
    assert.equal(launch(root, 'S1'), 'deny');
    submit(root, '承認', 'S1');
    assert.equal(launch(root, 'S1'), null);
  });
  test('別のセッションでは通らない', () => {
    const root = fix(['OP-001']);
    submit(root, '承認', 'S1');
    assert.equal(launch(root, 'S2'), 'deny');
  });
  test('新しい作戦記録を作ると通らなくなり、承認し直すと通る', () => {
    const root = fix(['OP-001']);
    submit(root, '承認', 'S1');
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-002.md'), 'x');
    assert.equal(launch(root, 'S1'), 'deny');
    submit(root, '承認。', 'S1');
    assert.equal(readApp(root).operation, 'OP-002');
    assert.equal(launch(root, 'S1'), null);
  });
});

describe('approval.js: session_id と番号の揺れ', () => {
  const run2 = (root, obj) => run(APPROVAL, JSON.stringify(obj), root);
  for (const [label, sid] of [['無い', undefined], ['空文字', ''], ['数値', 5], ['null', null]]) {
    test(`session_id が${label}ときは記録しない`, () => {
      const root = fix(['OP-001']);
      const o = { hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '承認' };
      if (sid !== undefined) o.session_id = sid;
      const r = run2(root, o);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(fs.existsSync(appPath(root)), false);
    });
  }
  test('guard は session_id が空の approval.json を通さない(入力にも無い場合も)', () => {
    const root = fix(['OP-001']);
    fs.mkdirSync(path.dirname(appPath(root)), { recursive: true });
    fs.writeFileSync(appPath(root), JSON.stringify({ session_id: '', operation: 'OP-001' }));
    assert.equal(launch(root, ''), 'deny');
    assert.equal(launch(root, undefined), 'deny');
    fs.writeFileSync(appPath(root), JSON.stringify({ operation: 'OP-001' }));
    assert.equal(launch(root, undefined), 'deny');
  });
  test('op-010.md と OP-9.md が混ざっても最大(10)に結び付き、guard が通す', () => {
    const root = fix(['op-010', 'OP-9', 'OP-002']);
    submit(root, '承認', 'S1');
    assert.equal(readApp(root).operation, 'OP-010');
    assert.equal(launch(root, 'S1'), null);
  });
  test('4桁の番号でも結び付き、guard が通す', () => {
    const root = fix(['OP-999', 'OP-1000']);
    submit(root, '承認', 'S1');
    assert.equal(readApp(root).operation, 'OP-1000');
    assert.equal(launch(root, 'S1'), null);
  });
  test('別セッション S2 の承認が S1 の承認を上書きし、S1 の unit は止まる', () => {
    const root = fix(['OP-001']);
    submit(root, '承認', 'S1');
    assert.equal(launch(root, 'S1'), null);
    fs.rmSync(path.join(root, '.ai-headquarters', 'state', 'unit-lock.json'), { force: true });
    submit(root, '承認', 'S2');
    assert.equal(readApp(root).session_id, 'S2');
    assert.equal(launch(root, 'S1'), 'deny');
    assert.equal(launch(root, 'S2'), null);
  });
  test('approval.js と guard.js の latestOperation の本文が一致する', () => {
    const grab = (f) => {
      const s = fs.readFileSync(f, 'utf8');
      const i = s.indexOf('function latestOperation');
      assert.ok(i >= 0);
      let depth = 0; let j = s.indexOf('{', i);
      const start = j;
      for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}' && --depth === 0) break; }
      return s.slice(start, j + 1).replace(/\s+/g, ' ');
    };
    assert.equal(grab(APPROVAL), grab(GUARD));
  });
});
