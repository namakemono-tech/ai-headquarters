'use strict';
// J52(.claude/ の3つの保護)の追加の確認: 親フォルダへの操作、git stash、大文字・小文字、読み取りの扱い
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'cp-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

let seq = 0;
function fix() {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(path.join(root, '.claude', 'hooks', 'ai-headquarters'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(root, '.claude', 'hooks', 'ai-headquarters', 'guard.js'), '//');
  return root;
}
// platform を模擬するための先読みファイル(プロセスの platform だけをすり替える)
function mock(platform) {
  const f = path.join(TMP, `mock-${platform}.js`);
  fs.writeFileSync(f, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`);
  return f;
}
function run(root, { agent, tool, input, platform }) {
  const o = {
    session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', permission_mode: 'default',
    tool_name: tool, tool_input: input, tool_use_id: 't1',
  };
  if (agent) { o.agent_id = 'a1'; o.agent_type = agent; }
  const args = platform ? ['-r', mock(platform), GUARD] : [GUARD];
  const r = spawnSync(process.execPath, args, { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}
const sh = (root, agent, command, tool = 'Bash', platform) => run(root, { agent, tool, input: { command }, platform });
const dec = (h) => (h ? h.permissionDecision : null);

describe('親フォルダ(.claude、.claude/hooks)を対象にした操作も、J52 の保護に当たる', () => {
  const hits = [
    ['mv .claude .claude-old', 'Bash'],
    ['mv .claude/hooks .claude/h2', 'Bash'],
    ['mv .claude/hooks/ai-headquarters x', 'Bash'],
    ['mv ./.claude/ x', 'Bash'],
    ['rm .claude/hooks', 'Bash'],
    ['Rename-Item .claude x', 'PowerShell'],
    ['Remove-Item .claude/hooks', 'PowerShell'],
    ['git checkout -- .claude', 'Bash'],
    ['git checkout .claude', 'Bash'],
    ['git restore .claude', 'Bash'],
    ['git restore .claude/hooks', 'Bash'],
    ['cp -r evil/. .claude', 'Bash'],
    ['cp -r evil/hooks .claude/', 'Bash'],
    ['cp -r evil .claude/hooks', 'Bash'],
    ['rsync -a evil/ .claude/', 'Bash'],
    ['Copy-Item -Recurse evil .claude', 'PowerShell'],
    ['mv .cl* x', 'Bash'],
    ['cd .claude && mv hooks x', 'Bash'],
  ];
  for (const [cmd, tool] of hits) {
    test(`止める: ${cmd}`, () => {
      const root = fix();
      assert.equal(dec(sh(root, null, cmd, tool)), 'ask', 'メインセッションは確認');
      assert.equal(dec(sh(root, 'unit', cmd, tool)), 'deny', 'unit は拒否');
    });
  }
  const passes = ['mv .claude/agents/x.md y', 'mv .claude-old x', 'cp a.txt b.txt', 'cp -r evil src/', 'rsync -a a/ b/',
    'git checkout main', 'git checkout -b feature', 'git restore src/a.js', 'git checkout -- src', 'git restore --staged .claude',
    'ls .claude', 'rm -f src/a.txt', 'mv src/a.js src/b.js'];
  for (const cmd of passes) {
    test(`止めない: ${cmd}`, () => {
      assert.equal(dec(sh(fix(), null, cmd)), null);
    });
  }
});

describe('git stash の未追跡・無視ファイルまで退避する指定は、破壊的コマンドとして扱う', () => {
  for (const cmd of ['git stash -u', 'git stash --include-untracked', 'git stash -a', 'git stash --all', 'git stash push -u -m x', 'git stash -ua', 'git stash push --include-untracked']) {
    test(`止める: ${cmd}`, () => {
      const root = fix();
      assert.equal(dec(sh(root, null, cmd)), 'ask');
      assert.equal(dec(sh(root, 'unit', cmd)), 'deny');
    });
  }
  for (const cmd of ['git stash', 'git stash pop', 'git stash list', 'git stash push -m x', 'git stash apply', 'git stash drop']) {
    test(`止めない: ${cmd}`, () => {
      assert.equal(dec(sh(fix(), null, cmd)), null);
    });
  }
});

describe('大文字・小文字: Windows と Mac は区別せず、Linux は区別する', () => {
  const write = (root, rel, platform) => dec(run(root, { tool: 'Write', input: { file_path: path.join(root, rel), content: 'x' }, platform }));
  for (const [platform, ci] of [['darwin', true], ['win32', true], ['linux', false]]) {
    test(`platform=${platform}(模擬)`, () => {
      const root = fix();
      const want = ci ? 'ask' : null;
      assert.equal(write(root, '.ENV', platform), want, '.ENV');
      assert.equal(write(root, 'Server.PEM', platform), want, 'Server.PEM');
      assert.equal(write(root, '.Claude/Settings.json', platform), want, '.Claude/Settings.json');
      assert.equal(write(root, '.CLAUDE/hooks/AI-Headquarters/x.js', platform), want, 'hooks');
      // 小文字は、どの platform でも保護
      assert.equal(write(root, '.env', platform), 'ask');
      assert.equal(write(root, '.claude/settings.json', platform), 'ask');
    });
  }
  test('実際の platform でも、同じ規則に従う', () => {
    const ci = process.platform === 'win32' || process.platform === 'darwin';
    assert.equal(write(fix(), '.ENV'), ci ? 'ask' : null);
  });
});

describe('J52 の3つは書き込みだけを保護する(読み取りは通す)。秘密のファイルは読み取りも止める', () => {
  for (const cmd of ['cat .claude/settings.json', 'ls .claude/hooks/ai-headquarters', 'git diff .claude/settings.json',
    'git log -- .claude/settings.json', 'git add .claude/settings.json', 'cat < .claude/settings.json', 'grep x .claude/settings.local.json',
    'head -n 3 .claude/hooks/ai-headquarters/guard.js']) {
    test(`通す: ${cmd}`, () => {
      const root = fix();
      assert.equal(dec(sh(root, null, cmd)), null);
      assert.equal(dec(sh(root, 'unit', cmd)), null);
    });
  }
  for (const cmd of ['echo x > .claude/settings.json', 'echo x >> .claude/settings.local.json', 'sed -i s/a/b/ .claude/settings.json',
    'cp x .claude/settings.json', 'rm .claude/settings.json', 'tee .claude/hooks/ai-headquarters/guard.js']) {
    test(`止める: ${cmd}`, () => {
      const root = fix();
      assert.equal(dec(sh(root, null, cmd)), 'ask');
      assert.equal(dec(sh(root, 'unit', cmd)), 'deny');
    });
  }
  test('秘密のファイルは、読み取りも止める(これまでどおり)', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'cat .env')), 'ask');
    assert.equal(dec(sh(root, null, 'cat < server.pem')), 'ask');
    assert.equal(dec(sh(root, 'unit', 'git diff .env')), 'deny');
  });
  test('inspector の git diff .claude/settings.json は通る', () => {
    const root = fix();
    const h = sh(root, 'inspector', 'git diff .claude/settings.json');
    assert.ok(!h || h.permissionDecision === 'allow', JSON.stringify(h));
  });
  test('inspector は .env を含む git diff を、これまでどおり拒否する', () => {
    assert.equal(dec(sh(fix(), 'inspector', 'git diff .env')), 'deny');
  });
  test('unit の Edit・Write は拒否される', () => {
    const root = fix();
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      assert.equal(dec(run(root, { agent: 'unit', tool, input: { file_path: path.join(root, '.claude', 'settings.json'), content: 'x' } })), 'deny', tool);
    }
  });
  test('メインセッションの Edit・Write は確認になる', () => {
    const root = fix();
    for (const rel of ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/ai-headquarters/guard.js']) {
      assert.equal(dec(run(root, { tool: 'Edit', input: { file_path: path.join(root, rel), old_string: 'a', new_string: 'b' } })), 'ask', rel);
    }
  });
});
