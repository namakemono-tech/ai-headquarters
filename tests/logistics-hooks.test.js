'use strict';
// 0.3.0 資源の手配(第4部)の Hooks: プラグインと MCP の状態を変えるコマンド、.claude/skills/・.claude/agents/・.mcp.json への書き込み
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'lg-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

let seq = 0;
// 作戦の始まりの記録(OS の一時フォルダ)を、プロジェクトごとの一時フォルダに分ける(テストどうしが混ざらないように)
function tmpEnv(root) {
  const t = `${root}-tmp`;
  fs.mkdirSync(t, { recursive: true });
  return { TMP: t, TEMP: t, TMPDIR: t };
}
// entries を渡すと、unit に許したファイルの記録(state/unit-scope.json)を置く
function fix(entries) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  const w = (rel, v) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof v === 'string' ? v : JSON.stringify(v));
  };
  w('src/a.js', 'x');
  w('.claude/skills/a/SKILL.md', 'x');
  w('.claude/agents/x.md', 'x');
  w('.mcp.json', '{}');
  w('.ai-headquarters/operations/OP-001.md', 'x');
  w('.ai-headquarters/state/approval.json', { session_id: 'S1', operation: 'OP-001', plan: '2026-11-22T00:00:00Z' });
  if (entries) w('.ai-headquarters/state/unit-scope.json', { valid: true, entries, session_id: 'S1', ts: new Date().toISOString() });
  return root;
}
function run(root, { agent, tool, input, mode = 'default' }) {
  const o = {
    session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', permission_mode: mode,
    tool_name: tool, tool_input: input, tool_use_id: 't1',
  };
  if (agent) { o.agent_id = 'a1'; o.agent_type = agent; }
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, ...tmpEnv(root), CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
  const h = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return h ? h.permissionDecision : null;
}
const sh = (root, agent, command, tool = 'Bash', mode) => run(root, { agent, tool, input: { command }, mode });
const edit = (root, agent, rel, tool = 'Edit') => run(root, { agent, tool, input: { file_path: path.join(root, rel), old_string: 'x', new_string: 'y', content: 'y' } });
const UNIT = 'ai-headquarters:unit';
const OTHER = 'other-plugin:writer';

describe('プラグインと MCP の状態を変えるコマンド: サブエージェントは拒否、メインセッションは確認(0.3.0)', () => {
  const guarded = [
    'claude plugin install foo@bar', 'claude plugins i foo', 'claude plugin uninstall ai-headquarters', 'claude plugin remove x',
    'claude plugin disable ai-headquarters@ai-headquarters', 'claude plugin enable x', 'claude plugin update x',
    'claude plugin init myskill', 'claude plugin new myskill', 'claude plugin eval x', 'claude plugin configure x', 'claude plugin prune',
    'claude plugin test .', 'claude plugin tag .',
    'claude plugin marketplace add owner/repo', 'claude plugin marketplace update', 'claude plugin marketplace remove x', 'claude plugin marketplace rm x',
    'claude mcp add srv node s.js', 'claude mcp add-json srv {}', 'claude mcp add-from-claude-desktop', 'claude mcp remove srv', 'claude mcp login srv',
    'claude --debug plugin install x', 'claude.exe plugin install x', 'CLAUDE plugin install x',
    'claude --plugin-dir ./evil -p hi', 'claude --plugin-dir=./evil -p hi', 'claude --mcp-config m.json -p hi', 'claude --dangerously-skip-permissions -p hi',
    'bash -c "claude plugin install x"', 'cd src && claude plugin install y', 'env A=1 claude mcp add s c',
  ];
  for (const cmd of guarded) {
    test(`照合する: ${cmd}`, () => {
      const root = fix();
      assert.equal(sh(root, null, cmd), 'ask', 'メインセッションは確認');
      assert.equal(sh(root, UNIT, cmd), 'deny', 'unit は拒否');
      assert.equal(sh(root, OTHER, cmd), 'deny', 'ほかのプラグインのエージェントも拒否');
      assert.equal(sh(root, null, cmd, 'Bash', 'bypassPermissions'), 'deny', 'bypassPermissions では拒否');
    });
  }
  test('PowerShell でも照合する', () => {
    const root = fix();
    assert.equal(sh(root, null, 'claude plugin install x', 'PowerShell'), 'ask');
    assert.equal(sh(root, UNIT, 'claude mcp add s c', 'PowerShell'), 'deny');
  });
  const passes = [
    'claude plugin list', 'claude plugins list --json', 'claude plugin details x', 'claude plugin validate .', 'claude plugin --help', 'claude plugin',
    'claude plugin marketplace list', 'claude mcp list', 'claude mcp get srv', 'claude --version', 'claude -p "install the plugin"', 'claude auth status',
    'echo claude plugin install x',
  ];
  for (const cmd of passes) {
    test(`照合しない: ${cmd}`, () => {
      const root = fix();
      assert.equal(sh(root, null, cmd), null);
      assert.equal(sh(root, UNIT, cmd), null);
    });
  }
});

describe('.claude/skills/・.claude/agents/・.mcp.json への unit の書き込みは、【変更してよいファイル】にはっきり書かれたときだけ(0.3.0)', () => {
  const allow = [
    ['.claude/skills/a/SKILL.md', ['.claude/skills/**']],
    ['.claude/skills/a/SKILL.md', ['.claude/skills/a/SKILL.md']],
    ['.claude/skills/a/SKILL.md', ['.claude/skills']],
    ['.claude/skills/a/SKILL.md', ['.claude/skills/']],
    ['.claude/skills/a/SKILL.md', ['src/**', '.claude/skills/a/*.md']],
    ['.claude/agents/x.md', ['.claude/agents/*.md']],
    ['.mcp.json', ['.mcp.json']],
  ];
  for (const [rel, entries] of allow) {
    test(`通す: ${rel} ← ${entries.join(', ')}`, () => {
      const root = fix(entries);
      assert.equal(edit(root, UNIT, rel), null);
      assert.equal(edit(root, UNIT, rel, 'Write'), null);
    });
  }
  const deny = [
    ['.claude/skills/a/SKILL.md', ['**']],
    ['.claude/skills/a/SKILL.md', ['.claude/**']],
    ['.claude/skills/a/SKILL.md', ['.claude/']],
    ['.claude/skills/a/SKILL.md', ['.claude/skills*']],
    ['.claude/skills/a/SKILL.md', ['src/**']],
    ['.claude/skills/a/SKILL.md', ['.claude/agents/**']],
    ['.claude/agents/x.md', ['.claude/skills/**']],
    ['.claude/agents/x.md', ['*.md', '**/*.md']],
    ['.mcp.json', ['*.json']],
    ['.mcp.json', ['**']],
  ];
  for (const [rel, entries] of deny) {
    test(`止める: ${rel} ← ${entries.join(', ')}`, () => {
      const root = fix(entries);
      assert.equal(edit(root, UNIT, rel), 'deny');
      assert.equal(edit(root, UNIT, rel, 'Write'), 'deny');
    });
  }
  test('ほかのファイルは、今までどおり広いグロブで書ける', () => {
    assert.equal(edit(fix(['**']), UNIT, 'src/a.js'), null);
    assert.equal(edit(fix(['**']), UNIT, 'docs/new.md', 'Write'), null);
  });
  test('ほかのサブエージェントは止める', () => {
    const root = fix(['.claude/skills/**', '.mcp.json']);
    assert.equal(edit(root, OTHER, '.claude/skills/a/SKILL.md'), 'deny');
    assert.equal(edit(root, 'general-purpose', '.claude/agents/x.md', 'Write'), 'deny');
    assert.equal(edit(root, OTHER, '.mcp.json'), 'deny');
  });
  test('メインセッションは止めず、確認も出さない', () => {
    const root = fix();
    assert.equal(edit(root, null, '.claude/skills/a/SKILL.md'), null);
    assert.equal(edit(root, null, '.claude/agents/new.md', 'Write'), null);
    assert.equal(edit(root, null, '.mcp.json'), null);
  });
});

describe('シェルのコマンドで .claude/skills/ などを書き換えるものは、サブエージェントでは拒否(0.3.0)', () => {
  const hits = [
    ['rm .claude/skills/a/SKILL.md', 'Bash'], ['mv .claude/agents/x.md y.md', 'Bash'], ['cp evil.md .claude/skills/a/SKILL.md', 'Bash'],
    ['echo x > .mcp.json', 'Bash'], ['echo x >> .claude/agents/x.md', 'Bash'], ['rm -f .claude/skills/*/SKILL.md', 'Bash'],
    ['Remove-Item .claude/skills/a', 'PowerShell'], ['Set-Content .mcp.json x', 'PowerShell'], ['mkdir .claude/skills/b', 'Bash'],
  ];
  for (const [cmd, tool] of hits) {
    test(`止める: ${cmd}`, () => {
      const root = fix(['.claude/skills/**', '.claude/agents/**', '.mcp.json']);
      assert.equal(sh(root, UNIT, cmd, tool), 'deny', 'unit は、命令書に書かれていても、シェルでは拒否');
      assert.equal(sh(root, OTHER, cmd, tool), 'deny');
      assert.equal(sh(root, null, cmd, tool), null, 'メインセッションは、ほかのファイルと同じ扱い');
    });
  }
  for (const cmd of ['cat .claude/skills/a/SKILL.md', 'ls .claude/agents', 'grep -r x .claude/skills', 'rm src/a.js']) {
    test(`止めない: ${cmd}`, () => {
      assert.equal(sh(fix(['src/**']), UNIT, cmd), null);
    });
  }
});

describe('作戦中に、AI司令部以外のスキルを Skill ツールで読み込むと、メインセッションは確認、サブエージェントは拒否(0.3.0)', () => {
  const OP = (result) => `# OP-001 作戦記録\n\n## 計画\nx\n${result === null ? '' : `\n## 結果\n${result}\n`}\n## 未解決\nなし\n`;
  // 作戦中の場の用意: 作戦記録と、そのセッションの記録(state/operation-session.json)
  function opRoot({ result = '未完了', marker = { session_id: 'S1', operation: 'OP-001' }, extraOp = false } = {}) {
    const root = fix();
    fs.writeFileSync(path.join(root, '.ai-headquarters/operations/OP-001.md'), OP(result));
    if (extraOp) fs.writeFileSync(path.join(root, '.ai-headquarters/operations/OP-002.md'), OP('未完了'));
    if (marker) fs.writeFileSync(path.join(root, '.ai-headquarters/state/operation-session.json'), JSON.stringify(marker));
    return root;
  }
  const skill = (root, agent, name, mode) => run(root, { agent, tool: 'Skill', input: name === undefined ? {} : { skill: name }, mode });
  const reason = (root, agent, name) => {
    const o = { session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Skill', tool_input: { skill: name }, tool_use_id: 't1' };
    if (agent) { o.agent_id = 'a1'; o.agent_type = agent; }
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, ...tmpEnv(root), CLAUDE_PROJECT_DIR: root } });
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  };

  test('hooks.json の guard.js の PreToolUse の matcher に Skill がある', () => {
    const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    assert.ok(h.hooks.PreToolUse[0].matcher.split('|').includes('Skill'));
    assert.match(h.hooks.PreToolUse[0].hooks[0].args.join(' '), /guard\.js/);
  });
  test('作戦中: ほかのスキルは、メインセッションでは確認、サブエージェントでは拒否、bypassPermissions では拒否', () => {
    const root = opRoot();
    for (const n of ['price-format', 'frontend-design:frontend-design', 'ai-headquarters:mission-orderx', 'other:mission']) {
      assert.equal(skill(root, null, n), 'ask', n);
      assert.equal(skill(root, OTHER, n), 'deny', n);
      assert.equal(skill(root, null, n, 'bypassPermissions'), 'deny', n);
    }
  });
  test('作戦中でも、AI司令部の3つのスキルは止めない', () => {
    const root = opRoot();
    for (const n of ['mission', 'mission-analysis', 'mission-order', 'ai-headquarters:mission', 'ai-headquarters:mission-analysis', 'ai-headquarters:mission-order']) {
      assert.equal(skill(root, null, n), null, n);
    }
  });
  test('名前が無い・読み取れない Skill の呼び出しは、作戦中なら確認', () => {
    assert.equal(skill(opRoot(), null, undefined), 'ask');
  });
  test('理由の文に、資源の手配の決まりを書く', () => {
    const r = reason(opRoot(), null, 'price-format');
    assert.match(r, /Skill ツールで読み込まず/);
    assert.match(r, /Read で/);
    assert.match(r, /命令書に写/);
  });
  test('「## 結果」の欄が無い、または「未完了」で始まるときは作戦中', () => {
    assert.equal(skill(opRoot({ result: null }), null, 'price-format'), 'ask');
    assert.equal(skill(opRoot({ result: '未完了(作戦を終えたら、この行を結果に書き換える)' }), null, 'price-format'), 'ask');
    assert.equal(skill(opRoot({ result: '\n\n未完了' }), null, 'price-format'), 'ask');
  });
  test('作戦の外では止めない: セッションの記録が無い、別のセッション、古い作戦番号、結果を書き終えた', () => {
    assert.equal(skill(opRoot({ marker: null }), null, 'price-format'), null, '記録なし');
    assert.equal(skill(opRoot({ marker: { session_id: 'S2', operation: 'OP-001' } }), null, 'price-format'), null, '別のセッション');
    assert.equal(skill(opRoot({ extraOp: true }), null, 'price-format'), null, '最新の作戦記録が別の番号');
    assert.equal(skill(opRoot({ result: '必成目標は達成した。望成1は捨てた' }), null, 'price-format'), null, '結果を書き終えた');
  });
  test('作戦記録が1つも無ければ止めない', () => {
    const root = fix();
    fs.rmSync(path.join(root, '.ai-headquarters/operations'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, '.ai-headquarters/state/operation-session.json'), JSON.stringify({ session_id: 'S1', operation: 'OP-001' }));
    assert.equal(skill(root, null, 'price-format'), null);
  });
  test('メインセッションが作戦記録を Write か Edit で書くと、そのセッションと作戦番号を記録する', () => {
    const root = fix();
    fs.rmSync(path.join(root, '.ai-headquarters/operations'), { recursive: true, force: true });
    const st = path.join(root, '.ai-headquarters/state/operation-session.json');
    assert.equal(run(root, { tool: 'Write', input: { file_path: path.join(root, '.ai-headquarters/operations/OP-001.md'), content: OP('未完了') } }), null);
    const rec = JSON.parse(fs.readFileSync(st, 'utf8'));
    assert.equal(rec.session_id, 'S1');
    assert.equal(rec.operation, 'OP-001');
    fs.mkdirSync(path.join(root, '.ai-headquarters/operations'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-headquarters/operations/OP-002.md'), OP('未完了'));
    const o = { session_id: 'S9', cwd: root, hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Edit', tool_input: { file_path: path.join(root, '.ai-headquarters/operations/OP-002.md'), old_string: 'x', new_string: 'y' }, tool_use_id: 't1' };
    spawnSync(process.execPath, [GUARD], { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    const rec2 = JSON.parse(fs.readFileSync(st, 'utf8'));
    assert.equal(rec2.session_id, 'S9');
    assert.equal(rec2.operation, 'OP-002');
  });
  test('state のフォルダがまだ無いとき(最初の作戦記録を書くとき)も記録する(0.3.0 の実地で、記録が作られなかったことへの直し)', () => {
    const root = fix();
    fs.rmSync(path.join(root, '.ai-headquarters'), { recursive: true, force: true });
    assert.equal(run(root, { tool: 'Write', input: { file_path: path.join(root, '.ai-headquarters/operations/OP-001.md'), content: OP('未完了') } }), null);
    const rec = JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters/state/operation-session.json'), 'utf8'));
    assert.equal(rec.session_id, 'S1');
    fs.mkdirSync(path.join(root, '.ai-headquarters/operations'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ai-headquarters/operations/OP-001.md'), OP('未完了'));
    assert.equal(skill(root, null, 'receipt-style'), 'ask');
  });
  test('作戦記録以外のファイルや、サブエージェントの書き込みでは記録しない', () => {
    const root = fix();
    const st = path.join(root, '.ai-headquarters/state/operation-session.json');
    run(root, { tool: 'Write', input: { file_path: path.join(root, 'src/a.js'), content: 'x' } });
    run(root, { tool: 'Write', input: { file_path: path.join(root, '.ai-headquarters/operations/notes.md'), content: 'x' } });
    run(root, { agent: UNIT, tool: 'Edit', input: { file_path: path.join(root, '.ai-headquarters/operations/OP-001.md'), old_string: 'x', new_string: 'y' } });
    assert.equal(fs.existsSync(st), false);
  });
});

describe('作戦の始まり: mission・mission-analysis を読み込んだとき、/ai-headquarters:mission で始めたときから、作戦記録が無くても確認(0.3.0。2026-11-22 指揮官の決定)', () => {
  const APPROVAL = path.join(__dirname, '..', 'hooks', 'approval.js');
  // OS の一時フォルダの代わりに、テストの一時フォルダを使わせる
  let tseq = 0;
  function env() {
    const tmp = path.join(TMP, `tmp${process.pid}-${++tseq}`);
    fs.mkdirSync(tmp, { recursive: true });
    return { tmp, vars: { TMP: tmp, TEMP: tmp, TMPDIR: tmp } };
  }
  // .ai-headquarters/ の無い、まっさらなプロジェクト
  function bare() {
    const root = path.join(TMP, `b${process.pid}-${++seq}`);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.js'), 'x');
    return root;
  }
  function hook(script, root, e, o) {
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ session_id: 'S1', cwd: root, permission_mode: 'default', tool_use_id: 't1', ...o }),
      encoding: 'utf8', env: { ...process.env, ...e.vars, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    return out && out.hookSpecificOutput ? out.hookSpecificOutput.permissionDecision || null : null;
  }
  const skillAs = (root, e, name, extra = {}) => hook(GUARD, root, e, { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: name }, ...extra });
  const prompt = (root, e, text, extra = {}) => hook(APPROVAL, root, e, { hook_event_name: 'UserPromptSubmit', prompt: text, ...extra });
  const pendingFiles = (e) => { try { return fs.readdirSync(path.join(e.tmp, 'ai-headquarters')); } catch { return []; } };

  test('mission-analysis を読み込んだあとは、作戦記録が無くても、ほかのスキルで確認(サブエージェントは拒否)', () => {
    const root = bare(); const e = env();
    assert.equal(skillAs(root, e, 'receipt-style'), null, '始まる前は止めない');
    assert.equal(skillAs(root, e, 'ai-headquarters:mission-analysis'), null, 'AI司令部のスキルそのものは止めない');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
    assert.equal(skillAs(root, e, 'receipt-style', { agent_id: 'a1', agent_type: OTHER }), 'deny');
    assert.equal(skillAs(root, e, 'receipt-style', { permission_mode: 'bypassPermissions' }), 'deny');
  });
  test('mission を読み込んだときも始まる。mission-order では始まらない', () => {
    const root = bare();
    const e1 = env();
    skillAs(root, e1, 'mission');
    assert.equal(skillAs(root, e1, 'price-format'), 'ask');
    const e2 = env();
    skillAs(root, e2, 'ai-headquarters:mission-order');
    assert.equal(skillAs(root, e2, 'price-format'), null);
  });
  test('/ai-headquarters:mission や /mission で始めたときも始まる(UserPromptSubmit)', () => {
    for (const text of ['/ai-headquarters:mission 中 3か所を直す', '/mission 大 作り直す', '  /ai-headquarters:mission', '/mission']) {
      const root = bare(); const e = env();
      prompt(root, e, text);
      assert.equal(skillAs(root, e, 'receipt-style'), 'ask', text);
    }
  });
  test('/mission-order や、文の途中の /mission では始まらない', () => {
    for (const text of ['/mission-order', '/ai-headquarters:mission-order', 'あとで /mission を使う', '/missions']) {
      const root = bare(); const e = env();
      prompt(root, e, text);
      assert.equal(skillAs(root, e, 'receipt-style'), null, text);
    }
  });
  test('/ai-headquarters:mission で始め、mission-analysis を読み込む前なら、指揮官の次の発言で終わる', () => {
    const root = bare(); const e = env();
    prompt(root, e, '/ai-headquarters:mission 中 直す');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
    prompt(root, e, 'やっぱりやめて、README を見て');
    assert.equal(skillAs(root, e, 'receipt-style'), null);
    assert.deepEqual(pendingFiles(e), [], '終えたら記録を消す');
  });
  // 2026-11-22 指揮官の指摘: 任務分析の途中の質問に答えると、作戦記録の前に作戦の始まりが終わっていた
  test('mission-analysis で始まったときは、任務分析の途中の質問に答えたあとも、作戦記録の前の読み込みで確認(サブエージェントは拒否)', () => {
    const root = bare(); const e = env();
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    prompt(root, e, '対象は src の3ファイルです。テストは要りません');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask', '1回目の答えのあと');
    assert.equal(skillAs(root, e, 'receipt-style', { agent_id: 'a1', agent_type: OTHER }), 'deny');
    prompt(root, e, 'はい、それで合っています');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask', '2回目の答えのあと');
  });
  test('/ai-headquarters:mission で始めても、mission-analysis を読み込んだあとは、質問への答えで終わらない', () => {
    const root = bare(); const e = env();
    prompt(root, e, '/ai-headquarters:mission 3か所を直す');
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    prompt(root, e, '対象は src の3ファイルです');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
  });
  test('作戦記録ができたら、作戦の始まりの記録を消して、作戦記録による見分け方に引き継ぐ', () => {
    const root = bare(); const e = env();
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    prompt(root, e, '対象は src の3ファイルです');
    const op = path.join(root, '.ai-headquarters/operations/OP-001.md');
    hook(GUARD, root, e, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: op, content: '# OP-001\n\n## 結果\n未完了\n' } });
    fs.mkdirSync(path.dirname(op), { recursive: true });
    fs.writeFileSync(op, '# OP-001\n\n## 結果\n未完了\n');
    assert.deepEqual(pendingFiles(e), [], '引き継いだら記録を消す');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask', '結果が「未完了」の間は確認');
    fs.writeFileSync(op, '# OP-001\n\n## 結果\n完了。3か所を直した\n');
    assert.equal(skillAs(root, e, 'receipt-style'), null, '作戦が終われば止めない');
  });
  test('任務分析のあと小規模と判断し、メインセッションがプロジェクトのファイルを書き換え始めたら終わる', () => {
    const root = bare(); const e = env();
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    const w = (p, extra = {}) => hook(GUARD, root, e, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: p, old_string: 'x', new_string: 'y' }, ...extra });
    w(path.join(root, '.ai-headquarters/operations/notes.md'));
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask', '.ai-headquarters/ の中の書き込みでは終わらない');
    w(path.join(e.tmp, 'scratch.md'));
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask', 'プロジェクトの外の書き込みでは終わらない');
    w(path.join(root, 'src/a.js'), { agent_id: 'a1', agent_type: OTHER });
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask', 'サブエージェントの書き込みでは終わらない');
    w(path.join(root, 'src/a.js'));
    assert.equal(skillAs(root, e, 'receipt-style'), null, 'メインセッションの書き込みで終わる');
    assert.deepEqual(pendingFiles(e), []);
  });
  test('任務分析のあと小規模と判断し、ファイルを書き換えなかったときも、指揮官の3回目の発言で終わる(確認が出続けない)', () => {
    const root = bare(); const e = env();
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    prompt(root, e, '答え1');
    prompt(root, e, '<task-notification>\n<status>completed</status>');
    prompt(root, e, '答え2');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask', '2回目までは続く。報告の知らせは数えない');
    prompt(root, e, '次は別の話です');
    assert.equal(skillAs(root, e, 'receipt-style'), null, '3回目で終わる');
    assert.deepEqual(pendingFiles(e), []);
  });
  test('mission-analysis を読み込み直すと、発言の数え直しになる', () => {
    const root = bare(); const e = env();
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    prompt(root, e, '答え1');
    prompt(root, e, '答え2');
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    prompt(root, e, '答え3');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
  });
  test('サブエージェントの報告の知らせ(<task-notification> で始まる UserPromptSubmit)では終わらない(0.3.0 の実地で、報告のたびに UserPromptSubmit が起きたため)', () => {
    const root = bare(); const e = env();
    prompt(root, e, '/ai-headquarters:mission 中 直す');
    prompt(root, e, '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
    prompt(root, e, '  <task-notification>x');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
    prompt(root, e, '次はこれをお願い <task-notification>');
    assert.equal(skillAs(root, e, 'receipt-style'), null, '文の途中にあるだけなら、指揮官の発言として終える');
  });
  test('「承認」の発言でも終わり、承認の記録はこれまでどおり', () => {
    const root = fix(); const e = env();
    fs.writeFileSync(path.join(root, '.ai-headquarters/state/approval.json'), '{}');
    prompt(root, e, '/ai-headquarters:mission 中 直す');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
    prompt(root, e, '承認');
    assert.equal(skillAs(root, e, 'receipt-style'), null);
    const ap = JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters/state/approval.json'), 'utf8'));
    assert.equal(ap.session_id, 'S1');
  });
  test('別のセッションには当てない', () => {
    const root = bare(); const e = env();
    prompt(root, e, '/ai-headquarters:mission 中 直す');
    assert.equal(skillAs(root, e, 'receipt-style', { session_id: 'S2' }), null);
  });
  test('プロジェクトに .ai-headquarters/ を作らず、記録は一時フォルダの ai-headquarters に置く', () => {
    const root = bare(); const e = env();
    prompt(root, e, '/ai-headquarters:mission 中 直す');
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    assert.equal(fs.existsSync(path.join(root, '.ai-headquarters')), false);
    assert.equal(pendingFiles(e).length, 1);
  });
  test('1日より古い記録は、書くときに消す', () => {
    const root = bare(); const e = env();
    const dir = path.join(e.tmp, 'ai-headquarters');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'pending-OLD.json');
    fs.writeFileSync(old, '{}');
    const t = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    fs.utimesSync(old, t, t);
    skillAs(root, e, 'ai-headquarters:mission-analysis');
    assert.equal(fs.existsSync(old), false);
  });
  test('作戦記録ができたあとは、作戦記録による見分け方に引き継がれる(次の発言のあとも、結果が「未完了」なら確認)', () => {
    const root = fix(); const e = env();
    prompt(root, e, '/ai-headquarters:mission 中 直す');
    hook(GUARD, root, e, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, '.ai-headquarters/operations/OP-001.md'), content: '# OP-001\n\n## 結果\n未完了\n' } });
    fs.writeFileSync(path.join(root, '.ai-headquarters/operations/OP-001.md'), '# OP-001\n\n## 結果\n未完了\n');
    prompt(root, e, '承認');
    assert.equal(skillAs(root, e, 'receipt-style'), 'ask');
  });
});
