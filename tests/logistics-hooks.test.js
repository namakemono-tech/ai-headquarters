'use strict';
// プラグインと MCP の状態を変えるコマンド、.claude/skills/・.claude/agents/・.mcp.json への書き込み(0.3.0。0.4.0 で守る相手を4体に狭めた)
// 0.4.0 で削った Skill ツールの見張りと作戦の始まりの管理が、何も出さず何も作らないことも確かめる
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

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
  w('.ai-headquarters/state/approvals.jsonl', FP.planRow('x'));
  if (entries) w('.ai-headquarters/state/unit-scope.json', { valid: true, entries, session_id: 'S1', ts: new Date().toISOString() });
  return root;
}
function run(root, { agent, tool, input, mode = 'default' }) {
  const o = {
    session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', permission_mode: mode,
    tool_name: tool, tool_input: input, tool_use_id: 't1',
  };
  if (agent) { o.agent_id = 'a1'; o.agent_type = agent; }
  if (agent === '') o.agent_id = 'a1'; // 役の名前(agent_type)が無いサブエージェント
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
  test('intel、plans、inspector は止める(0.4.0 でも同じ)', () => {
    const root = fix(['.claude/skills/**', '.mcp.json']);
    for (const a of ['ai-headquarters:intel', 'plans', 'ai-headquarters:inspector']) {
      assert.equal(edit(root, a, '.claude/skills/a/SKILL.md'), 'deny', a);
      assert.equal(edit(root, a, '.mcp.json', 'Write'), 'deny', a);
    }
  });
  test('4体以外のサブエージェントは止めず、確認も出さない(0.4.0 で狭めた)', () => {
    const root = fix(['.claude/skills/**', '.mcp.json']);
    assert.equal(edit(root, OTHER, '.claude/skills/a/SKILL.md'), null);
    assert.equal(edit(root, 'general-purpose', '.claude/agents/x.md', 'Write'), null);
    assert.equal(edit(root, OTHER, '.mcp.json'), null);
    assert.equal(edit(root, '', '.claude/skills/new/SKILL.md', 'Write'), null, '役の名前が無いサブエージェント');
  });
  test('4体以外のサブエージェントでも、.ai-headquarters/ の中への書き込みは止める', () => {
    const root = fix();
    assert.equal(edit(root, OTHER, '.ai-headquarters/operations/OP-001.md'), 'deny');
    assert.equal(edit(root, '', '.ai-headquarters/operations/OP-002.md', 'Write'), 'deny');
  });
  test('メインセッションは止めず、確認も出さない', () => {
    const root = fix();
    assert.equal(edit(root, null, '.claude/skills/a/SKILL.md'), null);
    assert.equal(edit(root, null, '.claude/agents/new.md', 'Write'), null);
    assert.equal(edit(root, null, '.mcp.json'), null);
  });
});

describe('シェルのコマンドで .claude/skills/ などを書き換えるものは、4体では拒否(0.3.0。0.4.0 で4体に狭めた)', () => {
  const hits = [
    ['rm .claude/skills/a/SKILL.md', 'Bash'], ['mv .claude/agents/x.md y.md', 'Bash'], ['cp evil.md .claude/skills/a/SKILL.md', 'Bash'],
    ['echo x > .mcp.json', 'Bash'], ['echo x >> .claude/agents/x.md', 'Bash'], ['rm -f .claude/skills/*/SKILL.md', 'Bash'],
    ['Remove-Item .claude/skills/a', 'PowerShell'], ['Set-Content .mcp.json x', 'PowerShell'], ['mkdir .claude/skills/b', 'Bash'],
  ];
  for (const [cmd, tool] of hits) {
    test(`止める: ${cmd}`, () => {
      const root = fix(['.claude/skills/**', '.claude/agents/**', '.mcp.json']);
      assert.equal(sh(root, UNIT, cmd, tool), 'deny', 'unit は、命令書に書かれていても、シェルでは拒否');
      assert.equal(sh(root, OTHER, cmd, tool), null, '4体以外のサブエージェントは、ほかのファイルと同じ扱い');
      assert.equal(sh(root, '', cmd, tool), null, '役の名前が無いサブエージェントも同じ');
      assert.equal(sh(root, null, cmd, tool), null, 'メインセッションは、ほかのファイルと同じ扱い');
    });
  }
  test('4体以外のサブエージェントでも、破壊的なコマンドと .ai-headquarters/ の中への書き込みは止める', () => {
    const root = fix();
    assert.equal(sh(root, OTHER, 'rm -r .claude/skills'), 'deny');
    assert.equal(sh(root, OTHER, 'rm -rf .claude'), 'deny');
    assert.equal(sh(root, OTHER, 'mv .claude x'), 'deny', '.claude ごと動かす');
    assert.equal(sh(root, OTHER, 'echo x > .ai-headquarters/operations/OP-001.md'), 'deny');
  });
  for (const cmd of ['cat .claude/skills/a/SKILL.md', 'ls .claude/agents', 'grep -r x .claude/skills', 'rm src/a.js']) {
    test(`止めない: ${cmd}`, () => {
      assert.equal(sh(fix(['src/**']), UNIT, cmd), null);
    });
  }
});

describe('0.4.0 で削ったもの: Skill ツールの見張りと、作戦の始まりの管理', () => {
  const APPROVAL = path.join(__dirname, '..', 'hooks', 'approval.js');
  const OP = '# OP-001 作戦記録\n\n## 計画\nx\n\n## 結果\n未完了\n';
  const skill = (root, agent, name, mode) => run(root, { agent, tool: 'Skill', input: name === undefined ? {} : { skill: name }, mode });
  const tmpFiles = (root) => { const d = path.join(`${root}-tmp`, 'ai-headquarters'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
  test('hooks.json の guard.js の PreToolUse の matcher に Skill が無い', () => {
    const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    assert.ok(!h.hooks.PreToolUse[0].matcher.split('|').includes('Skill'));
    assert.match(h.hooks.PreToolUse[0].hooks[0].args.join(' '), /guard\.js/);
  });
  test('作戦中に、AI司令部以外のスキルを Skill ツールで読み込んでも、Hooks は何も出さない', () => {
    const root = fix();
    fs.writeFileSync(path.join(root, '.ai-headquarters/operations/OP-001.md'), OP);
    for (const n of ['price-format', 'frontend-design:frontend-design', 'mission-analysis', 'ai-headquarters:mission']) {
      assert.equal(skill(root, null, n), null, n);
      assert.equal(skill(root, OTHER, n), null, n);
      assert.equal(skill(root, null, n, 'bypassPermissions'), null, n);
    }
    assert.deepEqual(tmpFiles(root), [], 'OS の一時フォルダに何も作らない');
  });
  test('/ai-headquarters:mission で始まる発言を送っても、何も出さず、OS の一時フォルダに何も作らない', () => {
    const root = fix();
    for (const prompt of ['/ai-headquarters:mission 価格の表示を直す', '/mission 中 x', '<task-notification>x</task-notification>', 'こんにちは']) {
      const o = { session_id: 'S1', cwd: root, hook_event_name: 'UserPromptSubmit', prompt };
      const r = spawnSync(process.execPath, [APPROVAL], { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, ...tmpEnv(root), CLAUDE_PROJECT_DIR: root } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), '', prompt);
      assert.deepEqual(tmpFiles(root), [], prompt);
    }
  });
  test('メインセッションが作戦記録を書いても、operation-session.json を作らない', () => {
    const root = fix();
    fs.rmSync(path.join(root, '.ai-headquarters/operations'), { recursive: true, force: true });
    assert.equal(run(root, { tool: 'Write', input: { file_path: path.join(root, '.ai-headquarters/operations/OP-001.md'), content: OP } }), null);
    assert.ok(!fs.existsSync(path.join(root, '.ai-headquarters/state/operation-session.json')));
    assert.deepEqual(tmpFiles(root), []);
  });
  test('guard.js と approval.js に、作戦の始まりの記録と Skill ツールの判定が残っていない', () => {
    const g = fs.readFileSync(GUARD, 'utf8');
    const a = fs.readFileSync(APPROVAL, 'utf8');
    for (const w of ['evalSkill', 'markOperation', 'operation-session', 'pendingPath', 'tmpdir']) {
      assert.ok(!g.includes(w), `guard.js: ${w}`);
      assert.ok(!a.includes(w), `approval.js: ${w}`);
    }
  });
});
