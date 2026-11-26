'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SS = path.join(__dirname, '..', 'hooks', 'session-start.js');
const HOOKS = path.join(__dirname, '..', 'hooks', 'hooks.json');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'ss-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

// 配置の違いを再現するため、スクリプトを一時フォルダに写して動かす
function place(name, withPluginJson) {
  const d = path.join(TMP, name);
  fs.mkdirSync(path.join(d, 'hooks'), { recursive: true });
  fs.copyFileSync(SS, path.join(d, 'hooks', 'session-start.js'));
  if (withPluginJson) {
    fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude-plugin', 'plugin.json'), '{}');
  }
  return path.join(d, 'hooks', 'session-start.js');
}
const ZIP = place('zip', false);
const PLUG = place('plug', true);
function run(stdin, plugin, script = ZIP) {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  if (plugin) env.CLAUDE_PLUGIN_ROOT = TMP;
  return spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env });
}
const ctx = (r) => JSON.parse(r.stdout).hookSpecificOutput;
const good = JSON.stringify({ session_id: 'S1', hook_event_name: 'SessionStart', source: 'startup' });

describe('session-start.js', () => {
  test('出力が正しい JSON で、additionalContext が入る', () => {
    const r = run(good, true);
    assert.equal(r.status, 0);
    const o = ctx(r);
    assert.equal(o.hookEventName, 'SessionStart');
    assert.equal(typeof o.additionalContext, 'string');
    // 0.6.0: 進め方のスキルを読み込む1行だけ(設定とつづく作戦が無いとき)。進め方の中身はスキルに置く
    assert.equal(o.additionalContext.split('\n').length, 1);
    for (const w of ['作業の依頼', '最初の応答の前', 'mission-analysis']) assert.ok(o.additionalContext.includes(w), w);
  });
  test('プラグイン版は ai-headquarters:mission-analysis', () => {
    assert.ok(ctx(run(good, true)).additionalContext.includes('ai-headquarters:mission-analysis'));
  });
  test('環境変数が無くても .claude-plugin/plugin.json が隣にあればプラグイン版', () => {
    assert.ok(ctx(run(good, false, PLUG)).additionalContext.includes('ai-headquarters:mission-analysis'));
  });
  test('実物の配置では、plugin.json があり、プラグイン版の呼び名が出る', () => {
    assert.ok(fs.existsSync(path.join(path.dirname(SS), '..', '.claude-plugin', 'plugin.json')));
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    const t = ctx(spawnSync(process.execPath, [SS], { input: good, encoding: 'utf8', env })).additionalContext;
    assert.ok(t.includes('ai-headquarters:mission-analysis'));
  });
  test('ZIP 版は mission-analysis だけ', () => {
    const t = ctx(run(good, false)).additionalContext;
    assert.ok(t.includes('mission-analysis'));
    assert.ok(!t.includes('ai-headquarters:'));
  });
  for (const b of ['', 'not json', '[]', '{"a":']) {
    test(`壊れた入力 ${JSON.stringify(b)} でも exit 0 で JSON を返す`, () => {
      const r = run(b, false);
      assert.equal(r.status, 0);
      assert.equal(ctx(r).hookEventName, 'SessionStart');
    });
  }
});

describe('session-start.js: 設定ファイルの役ごとのモデル(0.4.0)', () => {
  function proj(cfg) {
    const root = path.join(TMP, `p${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(root, '.ai-headquarters'), { recursive: true });
    if (cfg !== undefined) fs.writeFileSync(path.join(root, '.ai-headquarters', 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
    return root;
  }
  const runIn = (root) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: TMP };
    const r = spawnSync(process.execPath, [SS], { input: JSON.stringify({ session_id: 'S1', hook_event_name: 'SessionStart', source: 'startup', cwd: root }), encoding: 'utf8', env });
    assert.equal(r.status, 0);
    return ctx(r).additionalContext;
  };
  const base = runIn(proj());
  test('設定ファイルが無いとき、models が無いときは、案内は8行以内で、モデルの行は無い', () => {
    assert.ok(base.split('\n').length <= 8);
    assert.ok(!base.includes('役ごとのモデル'));
    assert.equal(runIn(proj({ protect: { add: ['x'] } })), base);
  });
  test('models を書いたときだけ、その中身を1行足す', () => {
    const t = runIn(proj({ models: { unit: 'opus', inspector: 'opus' } }));
    const lines = t.split('\n');
    assert.equal(lines.length, base.split('\n').length + 1);
    const line = lines.find((l) => l.includes('役ごとのモデル'));
    assert.ok(line);
    assert.match(line, /unit=opus/);
    assert.match(line, /inspector=opus/);
  });
  test('4体以外の名前や、使えない値は書かない', () => {
    const line = runIn(proj({ models: { unit: 'sonnet', general: 'opus', plans: 3, intel: 'haiku\n悪い行' } })).split('\n').find((l) => l.includes('役ごとのモデル'));
    assert.match(line, /unit=sonnet/);
    assert.ok(!line.includes('general'));
    assert.ok(!line.includes('plans'));
    assert.ok(!line.includes('悪い行'));
  });
  for (const bad of ['{bad', '[]', '{"models": "opus"}', '{"models": []}', '{"models": {}}', '{"models": {"general": "opus"}}']) {
    test(`壊れた設定、使えない models(${bad})では、足さずに終わる`, () => {
      assert.equal(runIn(proj(bad)), base);
    });
  }
  test('案内に、0.6.0 で外した mission-order は出てこない', () => {
    assert.ok(!base.includes('mission-order'), base);
  });
});

describe('hooks.json の登録', () => {
  const h = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
  for (const [ev, file] of [['SessionStart', 'session-start.js'], ['UserPromptSubmit', 'approval.js']]) {
    test(`${ev}: matcher なし・onFailure なし・${file}`, () => {
      assert.equal(h[ev].length, 1);
      assert.equal(h[ev][0].matcher, undefined);
      const c = h[ev][0].hooks[0];
      assert.deepEqual([c.type, c.command, c.args, c.onFailure], ['command', 'node', [`\${CLAUDE_PLUGIN_ROOT}/hooks/${file}`], undefined]);
      assert.ok(fs.existsSync(path.join(path.dirname(HOOKS), file)));
    });
  }
  test('既存の PreToolUse と SubagentStart は変わらない', () => {
    assert.equal(h.PreToolUse[0].hooks[0].onFailure, 'block');
    assert.deepEqual(h.PreToolUse[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/guard.js']);
    assert.equal(h.SubagentStart[0].matcher, '^(ai-headquarters:)?(intel|plans|unit|inspector)$');
    assert.deepEqual(h.SubagentStart[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/guard.js', 'subagent-start']);
  });
});

describe('続いている作戦の1行(0.6.0)', () => {
  const OPT = (result = '未完了') => `# OP-002\n## 目標\nx\n## 方針\ny\n## 承認\n目標の決心: 承認\n## いま\nなし\n## 結果\n${result}\n`;
  function opProj(rows, result) {
    const d = fs.mkdtempSync(path.join(TMP, 'cont-'));
    fs.mkdirSync(path.join(d, '.ai-headquarters', 'operations'), { recursive: true });
    fs.mkdirSync(path.join(d, '.ai-headquarters', 'state'), { recursive: true });
    fs.writeFileSync(path.join(d, '.ai-headquarters', 'operations', 'OP-002.md'), OPT(result));
    fs.writeFileSync(path.join(d, '.ai-headquarters', 'state', 'approvals.jsonl'), rows.map((r) => JSON.stringify({ operation: 'OP-002', ...r })).join('\n') + '\n');
    return d;
  }
  const at = (d, session = 'S9') => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: d };
    delete env.CLAUDE_PLUGIN_ROOT;
    return ctx(spawnSync(process.execPath, [SS], { input: JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }), encoding: 'utf8', env })).additionalContext;
  };
  test('計画の決心のある未完了の作戦は、承認を持っていないことと、受け継ぎの申し出の書き方を伝える', () => {
    const t = at(opProj([{ session_id: 'S1', kind: 'plan' }]));
    assert.ok(t.includes('OP-002 は続いています'), t);
    assert.ok(t.includes('受け継ぎの申し出: '), t);
  });
  test('引き継ぎ待ちなら、「承認」の入れ直しが要らないことを伝える', () => {
    const t = at(opProj([{ session_id: 'S1', kind: 'plan' }, { session_id: 'S1', kind: 'offer' }]));
    assert.ok(t.includes('OP-002 は引き継ぎ待ちです'), t);
    assert.ok(t.includes('入れ直しは要りません'), t);
  });
  test('計画の決心が無い作戦、終わった作戦、すでに関わったセッションには出さない', () => {
    assert.ok(!at(opProj([{ session_id: 'S1', kind: 'goals' }])).includes('OP-002'));
    assert.ok(!at(opProj([{ session_id: 'S1', kind: 'plan' }], '完了: x')).includes('OP-002'));
    assert.ok(!at(opProj([{ session_id: 'S1', kind: 'plan' }]), 'S1').includes('OP-002'));
  });
});
