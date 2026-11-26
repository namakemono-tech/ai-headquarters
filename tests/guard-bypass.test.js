'use strict';
// J59: bypassPermissions のメインセッションでは、確認(ask)の代わりに拒否(deny)を返す。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'gb-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 無視 */ } });

let seq = 0;
function fix(files = {}) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
function run(root, { mode, agent, tool, input }) {
  const o = { session_id: 'S1', transcript_path: 'x', cwd: root, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'tu1' };
  if (mode !== undefined) o.permission_mode = mode;
  if (agent) { o.agent_id = 'agent-1'; o.agent_type = agent; }
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const h = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { d: h ? h.permissionDecision : null, reason: h ? h.permissionDecisionReason : '' };
}
const NOTE = 'bypassPermissions では確認の画面が出ないため、止めました';
const cfg = { '.ai-headquarters/config.json': { protect: { add: ['secret-area/**'] } }, '.claude/keep': 'x' };

const cases = (root) => [
  ['.env の Write', { tool: 'Write', input: { file_path: path.join(root, '.env') } }],
  ['rm -rf src', { tool: 'Bash', input: { command: 'rm -rf src' } }],
  ['git reset --hard', { tool: 'Bash', input: { command: 'git reset --hard' } }],
  ['.claude/settings.json の Write', { tool: 'Write', input: { file_path: path.join(root, '.claude', 'settings.json') } }],
  ['mv .claude x', { tool: 'Bash', input: { command: 'mv .claude x' } }],
  ['protect.add のパスの Write', { tool: 'Write', input: { file_path: path.join(root, 'secret-area', 'a.txt') } }],
  // 伺5(0.6.0): コミットと外に出す操作も、メインセッションは確認(bypassPermissions では拒否)
  ['git commit', { tool: 'Bash', input: { command: 'git commit -m x' } }],
  ['git push', { tool: 'Bash', input: { command: 'git push' } }],
  ['npm publish', { tool: 'Bash', input: { command: 'npm publish' } }],
];

describe('J59: bypassPermissions のメインセッション', () => {
  const root = fix(cfg);
  for (const [name, c] of cases(root)) {
    test(`${name} は deny で、理由に bypassPermissions の文が入る`, () => {
      const r = run(root, { mode: 'bypassPermissions', ...c });
      assert.equal(r.d, 'deny');
      assert.ok(r.reason.includes(NOTE), r.reason);
      assert.ok(r.reason.includes('権限モードを変えてから頼むか'), r.reason);
    });
  }
});

describe('J59: ほかのモードと permission_mode なしは ask のまま', () => {
  const root = fix(cfg);
  for (const mode of ['default', 'auto', 'dontAsk', 'manual', 'acceptEdits', 'plan', undefined]) {
    for (const [name, c] of cases(root)) {
      test(`${mode === undefined ? '(モードなし)' : mode}: ${name}`, () => {
        const r = run(root, { mode, ...c });
        assert.equal(r.d, 'ask');
        assert.ok(!r.reason.includes('bypassPermissions'), r.reason);
      });
    }
  }
});

describe('J59: サブエージェントはどのモードでも deny', () => {
  const root = fix(cfg);
  for (const mode of ['bypassPermissions', 'default', 'dontAsk', undefined]) {
    test(`${mode}`, () => {
      for (const [, c] of cases(root)) assert.equal(run(root, { mode, agent: 'ai-headquarters:inspector', ...c }).d, 'deny');
    });
  }
});

describe('J59: 普段の操作は bypassPermissions でも何も返さない', () => {
  const root = fix(cfg);
  test('npm test', () => assert.equal(run(root, { mode: 'bypassPermissions', tool: 'Bash', input: { command: 'npm test' } }).d, null));
  test('ls', () => assert.equal(run(root, { mode: 'bypassPermissions', tool: 'Bash', input: { command: 'ls' } }).d, null));
  test('普通のファイルの Edit', () => assert.equal(run(root, { mode: 'bypassPermissions', tool: 'Edit', input: { file_path: path.join(root, 'src', 'a.js') } }).d, null));
});
