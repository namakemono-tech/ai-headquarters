'use strict';
// 0.6.0 の承認の引き継ぎ(実装の最初の任務。設計書 4.2、受5、失4)。
// 新しい雛形(rules-draft の8章。見出し8つ、「### 時程」が無い)の作戦記録で、目標の決心と計画の決心を受け、
// セッションを替えても「承認」の入れ直しが0回で unit を起動できることを確かめる。
// 0.5.0 の Hooks では、「### 時程」の無い作戦記録は引き継ぎの無い古い道(approval.json)に入るので、このテストは落ちる。
// T4 と T5 のあとに、すべて通ることを確かめる。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const H = (n) => path.join(__dirname, '..', 'hooks', n);
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'v6a-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ } });

// rules-draft.md の8章の雛形を埋めたもの
const OP = () => `# OP-001
## 企図
src/a.js の誤りを直す
## 目標
必成: src/a.js の誤りが直っている
物差し: 物1 npm test の失敗が0件
## 方針
未作成
## 承認
目標の決心: 未決心
## いま
なし
## 任務の記録
なし
## 処置事項
なし
## 結果
未完了
`;
const POLICY = [
  '要旨: unit が src/a.js を直し、inspector が npm test で確かめる',
  '変更してよい範囲: src/a.js',
  '戻せない操作: 無い',
  '配分: 重点 unit 1回、そのほか inspector 1回、予備 1回',
].join('\n');

let seq = 0;
const opFile = (root) => path.join(root, '.ai-headquarters', 'operations', 'OP-001.md');
function fix() {
  const root = path.join(TMP, `r${++seq}`);
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
  fs.writeFileSync(opFile(root), OP());
  return root;
}
const env = (root) => ({ ...process.env, CLAUDE_PROJECT_DIR: root });
function hook(name, root, input, args = []) {
  const r = spawnSync(process.execPath, [H(name), ...args], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8', env: env(root) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}
const ctx = (o) => (o.hookSpecificOutput || {}).additionalContext || '';

// 指揮官の「承認」。セッションごとに数える(入れ直しの回数を確かめるため)
const said = {};
function say(root, s) {
  said[`${root}|${s}`] = (said[`${root}|${s}`] || 0) + 1;
  return ctx(hook('approval.js', root, { session_id: s, hook_event_name: 'UserPromptSubmit', prompt: '承認' }));
}
const saidCount = (root, s) => said[`${root}|${s}`] || 0;

// 節の本文を差し替える(メインセッションの Edit に当たる)。書き込んだあとに PostToolUse(approval.js post)を起こす
function section(text, head) {
  const m = new RegExp(`(^## ${head}\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
  assert.ok(m, `節 ## ${head} が無い`);
  return m;
}
function mainEdit(root, s, head, newBody) {
  const before = fs.readFileSync(opFile(root), 'utf8');
  const m = section(before, head);
  const oldBody = m[2];
  const body = newBody.endsWith('\n') ? newBody : `${newBody}\n`;
  fs.writeFileSync(opFile(root), before.slice(0, m.index) + m[1] + body + before.slice(m.index + m[0].length));
  return hook('approval.js', root, { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: opFile(root), old_string: oldBody.trimEnd(), new_string: body.trimEnd() } }, ['post']);
}
// 「## 承認」の「目標の決心: 」の行だけを書き換える(節の中の、Hooks が書き足した行は残す)
function setGoalDecision(root, s, word) {
  const before = fs.readFileSync(opFile(root), 'utf8');
  const after = before.replace(/^目標の決心: .*$/m, `目標の決心: ${word}`);
  assert.notEqual(after, before, '「目標の決心: 」の行が無い');
  fs.writeFileSync(opFile(root), after);
  hook('approval.js', root, { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: opFile(root), old_string: '目標の決心: 未決心', new_string: `目標の決心: ${word}` } }, ['post']);
}

// unit の命令書(rules-draft の7章の6見出し。【統制】は無い)
const ORDER = [
  '【企図】src/a.js の誤りを直す',
  '【任務】src/a.js の誤りを直す',
  '【状況】なし',
  '【変更してよいファイル】',
  'src/a.js',
  '【制約と完了条件】npm test が通る',
  '【報告してほしいこと】【結論】【根拠】【変更したファイル】【未解決】',
].join('\n');
let tu = 0;
function launch(root, s, prompt = ORDER) {
  const o = hook('guard.js', root, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `tu${++tu}`, permission_mode: 'default', tool_input: { subagent_type: 'ai-headquarters:unit', prompt, description: 'd' } });
  const h = o.hookSpecificOutput || {};
  return { d: h.permissionDecision || null, reason: h.permissionDecisionReason || '' };
}
const unlock = (root) => {
  for (const f of ['unit-lock.json', 'unit-scope.json']) { try { fs.unlinkSync(path.join(root, '.ai-headquarters', 'state', f)); } catch { /* 無い */ } }
};
const passes = (r, msg) => assert.ok(r.d !== 'deny' && r.d !== 'ask', `${msg}: ${r.d} ${r.reason}`);

// S1 で、目標の決心と計画の決心を受けた作戦記録
function decided() {
  const root = fix();
  say(root, 'S1'); // 目標の決心
  setGoalDecision(root, 'S1', '承認 2026-11-25 10:00');
  mainEdit(root, 'S1', '方針', POLICY);
  say(root, 'S1'); // 計画の決心
  passes(launch(root, 'S1'), '計画の決心のあと、同じセッションで unit を起動できる');
  unlock(root);
  return root;
}

describe('0.6.0 承認: 新しい雛形の作戦記録(「### 時程」が無い)', () => {
  test('目標の決心だけでは unit を起動できず、計画の決心のあとに起動できる', () => {
    const root = fix();
    say(root, 'S1');
    assert.equal(launch(root, 'S1').d, 'deny', '目標の決心だけでは止まる(K35)');
    unlock(root);
    setGoalDecision(root, 'S1', '承認 2026-11-25 10:00');
    mainEdit(root, 'S1', '方針', POLICY);
    say(root, 'S1');
    passes(launch(root, 'S1'), '計画の決心のあと');
  });

  test('引き継ぎ待ちを「## いま」に書けば、別のセッションは「承認」の入れ直し0回で unit を起動できる', () => {
    const root = decided();
    mainEdit(root, 'S1', 'いま', '引き継ぎ待ち: 2026-11-25 11:00。セッションを替えるため。次は unit に src/a.js を直させる');
    passes(launch(root, 'S2'), '引き継いだセッションの unit');
    assert.equal(saidCount(root, 'S2'), 0, '入れ直しの「承認」は0回');
    unlock(root);
    assert.equal(launch(root, 'S1').d, 'deny', '承認を持つのは引き継いだセッションだけ');
    unlock(root);
    assert.equal(launch(root, 'S3').d, 'deny', '引き継ぎ待ちは1回で使い切る');
  });

  test('引き継ぎ待ちを書かずに替えたときは、受け継ぎの申し出のあとの「承認」1回で起動できる', () => {
    const root = decided();
    mainEdit(root, 'S2', 'いま', '受け継ぎの申し出: 2026-11-25 11:30。計画と任務の要点を指揮官に示した');
    say(root, 'S2');
    passes(launch(root, 'S2'), '申し出のあとの「承認」1回で');
    assert.equal(saidCount(root, 'S2'), 1);
  });

  test('申し出も引き継ぎ待ちも無い別のセッションの「承認」は、目標の決心に倒れ、unit は起動できない(K35、K75)', () => {
    const root = decided();
    say(root, 'S2');
    assert.equal(launch(root, 'S2').d, 'deny');
  });

  test('「## 目標」を書き換えたら止まる', () => {
    const root = decided();
    mainEdit(root, 'S1', '目標', '必成: src/a.js と src/b.js の誤りが直っている\n物差し: 物1 npm test の失敗が0件');
    assert.equal(launch(root, 'S1').d, 'deny');
  });

  test('「## 方針」を書き換えたら止まる', () => {
    const root = decided();
    mainEdit(root, 'S1', '方針', POLICY.replace('src/a.js', 'src/a.js、src/b.js'));
    assert.equal(launch(root, 'S1').d, 'deny');
  });

  test('引き継ぎ待ちのあとに「## 方針」を書き換えたら、別のセッションは受け継げない', () => {
    const root = decided();
    mainEdit(root, 'S1', 'いま', '引き継ぎ待ち: 2026-11-25 11:00');
    mainEdit(root, 'S1', '方針', POLICY.replace('予備 1回', '予備 2回'));
    assert.equal(launch(root, 'S2').d, 'deny');
  });

  test('節の外(承認、いま、任務の記録、処置事項)を書き換えても止まらない', () => {
    const root = decided();
    mainEdit(root, 'S1', 'いま', '次は unit に src/a.js を直させる。未解決なし');
    passes(launch(root, 'S1'), '「## いま」のあと'); unlock(root);
    mainEdit(root, 'S1', '任務の記録', 'OP-001-1 unit に src/a.js を直させた。済み');
    passes(launch(root, 'S1'), '「## 任務の記録」のあと'); unlock(root);
    mainEdit(root, 'S1', '処置事項', '処1 点検は1回にした。危険が低いため');
    passes(launch(root, 'S1'), '「## 処置事項」のあと'); unlock(root);
    setGoalDecision(root, 'S1', '修正 物差しを1つ足した');
    passes(launch(root, 'S1'), '「## 承認」の決心の行のあと'); unlock(root);
  });

  test('unit が終わる(SubagentStop)と同時に1体の印が外れ、次の unit を起動できる(実1 で見つけた直し)', () => {
    const root = decided();
    passes(launch(root, 'S1'), '1体目');
    const ev = (name, extra) => hook('guard.js', root, { session_id: 'S1', hook_event_name: name, agent_type: 'ai-headquarters:unit', agent_id: 'u1', ...extra }, [name === 'SubagentStart' ? 'subagent-start' : 'subagent-stop']);
    ev('SubagentStart');
    assert.equal(launch(root, 'S1').d, 'deny', '動いているあいだは2体目を止める');
    ev('SubagentStop', { agent_id: 'u2' });
    assert.equal(launch(root, 'S1').d, 'deny', '別の unit の終わりでは外さない');
    ev('SubagentStop');
    passes(launch(root, 'S1'), '終わったあとの2体目');
  });

  test('引き継いだあと、節の外を書き換えても、引き継いだセッションは起動し続けられる', () => {
    const root = decided();
    mainEdit(root, 'S1', 'いま', '引き継ぎ待ち: 2026-11-25 11:00');
    passes(launch(root, 'S2'), '引き継ぎ'); unlock(root);
    mainEdit(root, 'S2', '任務の記録', 'OP-001-1 unit に src/a.js を直させた。済み');
    mainEdit(root, 'S2', 'いま', '引き継ぎ済み: 2026-11-25 11:05。次は inspector');
    passes(launch(root, 'S2'), '引き継いだあとの2回目');
    assert.equal(saidCount(root, 'S2'), 0);
  });
});
