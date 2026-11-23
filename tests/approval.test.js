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
// 既定の作戦記録は「目標の決心を省いた」形(最初の「承認」が計画の決心になる)。段階の見分けは下の「目標の決心と計画の決心」で確かめる(2026-11-22)
// 0.4.0 から、計画の決心は「## 計画」に計画書が書かれているときだけ記録される(fingerprint.test.js)。そのため既定の作戦記録に計画の節を置く
const PLAN = '\n## 計画\n手順1: unit。src/a.js\n';
const SKIPPED = `## 承認\n### 目標の決心\n省略: 指揮官が企図で目標をすべて示したため\n### 計画の決心\n未決心\n${PLAN}`;
function fix(ops = [], body = SKIPPED) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  for (const n of ops) {
    fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', `${n}.md`), body);
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
const launchR = (root, session) => {
  const r = run(GUARD, JSON.stringify({
    session_id: session, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu1',
    tool_input: { subagent_type: 'unit', prompt: '【変更してよいファイル】\n- src/a.js' },
  }), root);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
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
      assert.match(out.hookSpecificOutput.additionalContext, /OP-001 に記録しました/);
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
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-002.md'), SKIPPED);
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

describe('目標の決心と計画の決心(2026-11-22)', () => {
  const body = (line) => `# OP-001 作戦記録\n\n## 承認\n### 目標の決心\n${line}\n### 計画の決心\n未決心\n${PLAN}`;
  const lockOff = (root) => fs.rmSync(path.join(root, '.ai-headquarters', 'state', 'unit-lock.json'), { force: true });
  test('「未決心」の作戦記録での最初の「承認」は目標の決心。unit は起動できない', () => {
    const root = fix(['OP-001'], body('未決心'));
    const r = submit(root, '承認');
    const c = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(c, /目標の決心として OP-001 に記録しました/);
    assert.match(c, /unit はまだ起動できません/);
    assert.ok(c.includes('計画を作戦記録の「## 計画」に書いて示し、改めて「承認」とだけ入力してもらってください'), c);
    assert.match(c, /欄の無い古い作戦記録/);
    const a = readApp(root);
    assert.equal(typeof a.goals, 'string');
    assert.equal(a.plan, null);
    const g = launchR(root, 'S1');
    assert.equal(g.permissionDecision, 'deny');
    assert.match(g.permissionDecisionReason, /目標の決心だけでは unit を起動できません/);
  });
  test('2回目の「承認」は計画の決心。目標の決心の記録も残り、unit を起動できる', () => {
    const root = fix(['OP-001'], body('未決心'));
    submit(root, '承認');
    const c = JSON.parse(submit(root, '承認').stdout).hookSpecificOutput.additionalContext;
    assert.match(c, /計画の決心として OP-001 に記録しました/);
    const a = readApp(root);
    assert.equal(typeof a.goals, 'string');
    assert.equal(typeof a.plan, 'string');
    assert.equal(launch(root, 'S1'), null);
  });
  test('中間報告のあとの節目の「承認」も計画の決心のまま', () => {
    const root = fix(['OP-001'], body('未決心'));
    submit(root, '承認'); submit(root, '承認');
    lockOff(root);
    submit(root, '承認');
    assert.equal(typeof readApp(root).goals, 'string');
    assert.equal(launch(root, 'S1'), null);
  });
  for (const line of ['修正: 望成2を外す', '修正：望成2を外す', '省略: 指揮官が企図で目標をすべて示したため', '省略：企図ですべて示された']) {
    test(`欄が「${line.slice(0, 3)}」で始まれば、最初の「承認」が計画の決心`, () => {
      const root = fix(['OP-001'], body(line));
      submit(root, '承認');
      assert.equal(typeof readApp(root).plan, 'string');
      assert.equal(launch(root, 'S1'), null);
    });
  }
  test('見出しの次の空行は飛ばして、最初の行で見分ける', () => {
    const root = fix(['OP-001'], `## 承認\n### 目標の決心\n\n修正: 損耗限度を2回に\n${PLAN}`);
    submit(root, '承認');
    assert.equal(launch(root, 'S1'), null);
  });
  // 迷ったら止める側(目標の決心)に倒す
  const goalsCases = {
    '未決心(回答待ち)': body('未決心(回答待ち)'),
    '未': body('未'),
    '状態に目標の決心が無いのに「承認:」': body('承認: 2026-11-22 10:00'),
    'コロンの無い「修正」': body('修正 望成2を外す'),
    '行の途中の「省略:」': body('目標は 省略: しない'),
    '見出しの次が空': '## 承認\n### 目標の決心\n\n### 計画の決心\n未決心\n',
    '欄の無い古い作戦記録': '# OP-001\n## 承認\nなし\n',
    '本文の別の場所にある「省略:」': '## 目標\n省略: x\n## 承認\n### 目標の決心\n未決心\n',
  };
  for (const [label, b] of Object.entries(goalsCases)) {
    test(`${label}:最初の「承認」は目標の決心で、unit は止まる`, () => {
      const root = fix(['OP-001'], b);
      submit(root, '承認');
      assert.equal(readApp(root).plan, null);
      assert.equal(launch(root, 'S1'), 'deny');
    });
  }
  test('別のセッションの目標の決心は数えない(S2 の最初の「承認」は目標の決心)', () => {
    const root = fix(['OP-001'], body('未決心'));
    submit(root, '承認', 'S1');
    submit(root, '承認', 'S2');
    const a = readApp(root);
    assert.equal(a.session_id, 'S2');
    assert.equal(a.plan, null);
    assert.equal(launch(root, 'S2'), 'deny');
  });
  test('新しい作戦記録では、目標の決心からやり直す', () => {
    const root = fix(['OP-001'], body('未決心'));
    submit(root, '承認'); submit(root, '承認');
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-002.md'), body('未決心'));
    submit(root, '承認');
    const a = readApp(root);
    assert.equal(a.operation, 'OP-002');
    assert.equal(a.plan, null);
    assert.equal(launch(root, 'S1'), 'deny');
  });
  test('段階の無い古い承認の記録では、unit は止まる', () => {
    const root = fix(['OP-001']);
    fs.mkdirSync(path.dirname(appPath(root)), { recursive: true });
    fs.writeFileSync(appPath(root), JSON.stringify({ session_id: 'S1', operation: 'OP-001', ts: new Date().toISOString() }));
    const g = launchR(root, 'S1');
    assert.equal(g.permissionDecision, 'deny');
    assert.match(g.permissionDecisionReason, /計画の決心/);
  });
});
