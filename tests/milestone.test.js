'use strict';
// 大規模の節目の承認の下限(0.4.0。2026-11-23 指揮官の決定)。
// 前の「承認」のあと unit を3回起動したら、4回目の unit の起動を止め、「承認」を求める(決まりの「unit の起動3回ごとの下限」と合わせる)。
// 数えるのは launches.jsonl(起動の数え上げ)。中規模と小規模には当てない。
// 大規模かどうかは、作戦記録の「## 規模と編成」の最初の行の初めの字(大、中、小。前に「規模:」があってもよい)で見分ける。
// その行で見分けられないときは、大規模だけが足す節(「## 行動方針の比較と結論」「## 状況の特質」)があれば大規模とみなす。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APPROVAL = path.join(__dirname, '..', 'hooks', 'approval.js');
const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'ms-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

const OP = (scale = '大。指揮官の指定', extra = '') => `# OP-001 作戦記録\n\n## 目標\n### 必成目標\nx\n### 点検の物差し\n物1: x\n### 起動の上限\n30回(見込み 20回)\n\n## 規模と編成\n${scale}\n\n${extra}## 承認\n### 目標の決心\n省略: 理由\n### 計画の決心\n未決心\n\n## 計画\n手順1: unit\n\n## 結果\n未完了\n`;
let seq = 0;
const st = (root, n) => path.join(root, '.ai-headquarters', 'state', n);
function fix(body = OP()) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-001.md'), body);
  return root;
}
const env = (root) => ({ ...process.env, CLAUDE_PROJECT_DIR: root });
function say(root, prompt, session = 'S1') {
  const r = spawnSync(process.execPath, [APPROVAL], { input: JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'UserPromptSubmit', prompt }), encoding: 'utf8', env: env(root) });
  assert.equal(r.status, 0, r.stderr);
}
const approve = (root) => say(root, '承認');
let agentSeq = 0;
// 起動の知らせ(SubagentStart)のあと、unit の報告が通ったとして実行中の記録を消す
function started(root, type = 'ai-headquarters:unit', id = `ag${++agentSeq}`) {
  const r = spawnSync(process.execPath, [GUARD, 'subagent-start'], { input: JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'SubagentStart', agent_type: type, agent_id: id }), encoding: 'utf8', env: env(root) });
  assert.equal(r.status, 0, r.stderr);
  try { fs.unlinkSync(st(root, 'unit-lock.json')); } catch { /* 無い */ }
}
function before(root, type = 'ai-headquarters:unit') {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `tu${++seq}`, permission_mode: 'default',
      tool_input: { subagent_type: type, prompt: '【変更してよいファイル】\nsrc/a.js', description: 'd' } }),
    encoding: 'utf8', env: env(root),
  });
  assert.equal(r.status, 0, r.stderr);
  const h = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput || {} : {};
  try { fs.unlinkSync(st(root, 'unit-lock.json')); } catch { /* 無い */ }
  return { d: h.permissionDecision || null, reason: h.permissionDecisionReason || '' };
}
const units = (root, n) => { for (let i = 0; i < n; i++) started(root); };

describe('大規模の節目の承認の下限(Hooks)', () => {
  test('前の「承認」のあと unit を3回起動したら、4回目の unit の起動を止め、「承認」を求める', () => {
    const root = fix();
    approve(root);
    units(root, 2);
    assert.equal(before(root).d, null, '3回目の前は止めない');
    started(root);
    const r = before(root);
    assert.equal(r.d, 'deny');
    assert.match(r.reason, /大規模/);
    assert.match(r.reason, /unit を3回/);
    assert.match(r.reason, /中間報告/);
    assert.match(r.reason, /「承認」とだけ/);
    assert.match(r.reason, /「続けて」「進めて」/);
    assert.ok(!fs.existsSync(st(root, 'unit-lock.json')), '止めたときは、予約を残さない');
  });
  test('止められたあと、「承認」とだけ入力すれば、unit を起動できる(数えるのは、前の承認のあと)', () => {
    const root = fix();
    approve(root);
    units(root, 3);
    assert.equal(before(root).d, 'deny');
    approve(root);
    assert.equal(before(root).d, null);
    units(root, 2);
    assert.equal(before(root).d, null, '承認のあと2回');
    started(root);
    assert.equal(before(root).d, 'deny', '承認のあと3回');
  });
  test('「続けてください」「進めて」「OK」などは承認にならず、止まったまま', () => {
    const root = fix();
    approve(root);
    units(root, 3);
    for (const p of ['続けてください', '続けて', '進めて', 'OK', '承認します。続けてください', 'はい']) {
      say(root, p);
      assert.equal(before(root).d, 'deny', p);
    }
  });
  test('数えるのは unit だけ。intel、plans、inspector の起動は数えず、止めない', () => {
    const root = fix();
    approve(root);
    started(root, 'ai-headquarters:inspector'); started(root, 'intel'); started(root, 'plans');
    units(root, 2);
    started(root, 'inspector');
    assert.equal(before(root).d, null, 'unit は2回');
    started(root);
    assert.equal(before(root, 'ai-headquarters:inspector').d, null, '点検の起動は止めない');
    assert.equal(before(root, 'intel').d, null);
    assert.equal(before(root).d, 'deny');
  });
  test('同じ agent_id の知らせは1回と数える', () => {
    const root = fix();
    approve(root);
    started(root, 'unit', 'same'); started(root, 'unit', 'same'); started(root, 'unit', 'same');
    started(root);
    assert.equal(before(root).d, null);
  });
  test('中規模と小規模には当てない', () => {
    for (const scale of ['中。3ファイル', '規模: 中(指揮官の指定)。変更の見込みは3ファイル。', '小', '中規模']) {
      const root = fix(OP(scale));
      approve(root);
      units(root, 5);
      assert.equal(before(root).d, null, scale);
    }
  });
  test('実地で書かれた大規模の書き方を見分ける', () => {
    for (const scale of ['大。指揮官の指定。4体すべて使う。', '大(指揮官の指定)。intel(状況の特質は sonnet)', '規模: 大', '規模:大規模', '大規模(10ファイル以上)', '**大**(指揮官の指定)', '  大']) {
      const root = fix(OP(scale));
      approve(root);
      units(root, 3);
      assert.equal(before(root).d, 'deny', scale);
    }
  });
  test('規模の行で見分けられないときは、大規模だけが足す節があれば大規模とみなす', () => {
    for (const extra of ['## 行動方針の比較と結論\n案1\n\n', '## 状況の特質\nx\n\n']) {
      const root = fix(OP('規模(小、中、大)、判定の理由、使うサブエージェントと役ごとのモデル', extra));
      approve(root);
      units(root, 3);
      assert.equal(before(root).d, 'deny', extra);
    }
    const plain = fix(OP('未定'));
    approve(plain);
    units(plain, 3);
    assert.equal(before(plain).d, null, '見分けられず、大規模の節も無いときは止めない');
    const none = fix(OP().replace(/## 規模と編成\n.*\n\n/, ''));
    approve(none);
    units(none, 3);
    assert.equal(before(none).d, null, '節が無いときも止めない');
  });
  // 新3(直したあとの確かめの指摘): 雛形の行を書き換え忘れても、大規模とみなさない(大規模の節があるときだけ大規模)
  test('雛形の規模の行をそのまま残した作戦記録は、規模の行では大規模とみなさない', () => {
    const tplLine = (text) => text.replace(/\r\n/g, '\n').split('## 規模と編成\n')[1].split('\n')[0];
    const lines = [
      tplLine(fs.readFileSync(path.join(__dirname, '..', 'templates', 'operations-log.md'), 'utf8')),
      tplLine(fs.readFileSync(path.join(__dirname, '..', 'skills', 'mission-analysis', 'SKILL.md'), 'utf8')),
    ];
    assert.equal(lines[0], lines[1], '雛形とテンプレートの行が同じ');
    assert.doesNotMatch(lines[0], /^[\s*]*(?:規模\s*[:：]?)?[\s*]*[大中小]/, '行の初めの字が大、中、小ではない');
    const medium = fix(OP(lines[0]));
    approve(medium);
    units(medium, 3);
    assert.equal(before(medium).d, null, '大規模の節が無ければ止めない');
    const large = fix(OP(lines[0], '## 行動方針の比較と結論\n案1\n\n'));
    approve(large);
    units(large, 3);
    assert.equal(before(large).d, 'deny', '大規模の節があれば大規模');
  });
  test('規模の行が中なら、大規模の節があっても中規模として扱う(行を先に見る)', () => {
    const root = fix(OP('中(指揮官の指定)', '## 状況の特質\nx\n\n'));
    approve(root);
    units(root, 3);
    assert.equal(before(root).d, null);
  });
  test('結果を書き終えた作戦では止めない', () => {
    const root = fix();
    approve(root);
    units(root, 3);
    const p = path.join(root, '.ai-headquarters', 'operations', 'OP-001.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('## 結果\n未完了', '## 結果\n必成目標を達成した'));
    const r = before(root);
    assert.notEqual(r.d, 'deny', r.reason);
  });
  test('ほかの関門(計画の決心が無い)が先に止める', () => {
    const root = fix();
    const r = before(root);
    assert.equal(r.d, 'deny');
    assert.doesNotMatch(r.reason, /unit を3回/);
  });
});
