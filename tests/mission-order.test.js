'use strict';
// skills/mission-order/SKILL.md の型と記入例が、requirements.md および guard.js と合っているかの自動テスト。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'hooks', 'guard.js');
const SKILL = fs.readFileSync(path.join(ROOT, 'skills', 'mission-order', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const REQ_PATH = path.join(ROOT, 'docs', 'requirements.md');
const HAS_REQ = fs.existsSync(REQ_PATH);
const SKIP_REQ = HAS_REQ ? false : '要件の原本(非公開)が無いため省略';
const REQ = HAS_REQ ? fs.readFileSync(REQ_PATH, 'utf8').replace(/\r\n/g, '\n') : '';
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'mo-'));

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

const codeBlocks = (text) => [...text.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);
const headings = (block) => [...block.matchAll(/^【([^】]+)】/gm)].map((m) => m[1]);
const section = (text, title) => {
  const i = text.indexOf(title);
  assert.ok(i >= 0, title);
  return text.slice(i);
};

describe('SKILL.md の形式', () => {
  test('frontmatter に name と description がある', () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);
    assert.ok(m);
    assert.match(m[1], /^name: mission-order$/m);
    assert.match(m[1], /^description: .+/m);
    assert.doesNotMatch(m[1], /disable-model-invocation/);
  });
});

describe('3つの型が requirements.md と同じ見出し・同じ順', { skip: SKIP_REQ }, () => {
  const reqBlocks = HAS_REQ ? codeBlocks(section(REQ, '## 命令書と報告の型').split('## 作戦の流れ')[0]) : [];
  const skillBlocks = codeBlocks(SKILL.split('## 記入例')[0]);
  const names = ['命令書', '報告', '計画書'];
  test('型のコードブロックは3つ', () => {
    assert.equal(reqBlocks.length, 3);
    assert.equal(skillBlocks.length, 3);
  });
  names.forEach((n, i) => {
    test(`${n}`, () => {
      assert.deepEqual(headings(skillBlocks[i]), headings(reqBlocks[i]));
      assert.ok(headings(skillBlocks[i]).length >= 6);
    });
  });
  test('見出し数(命令書8・報告6・計画書6)', () => {
    assert.deepEqual(skillBlocks.map((b) => headings(b).length), [8, 6, 6]);
  });
});

describe('記入例(unit 向け命令書)が guard.js を通る', () => {
  const exampleBlocks = codeBlocks(section(SKILL, '## 記入例'));
  const example = exampleBlocks[0];
  const skillBlocks = codeBlocks(SKILL.split('## 記入例')[0]);
  const EXPECTED = ['src/auth/login.js', 'src/lib/validate.js', 'tests/auth/**'];
  let seq = 0;
  const makeRoot = () => {
    const root = path.join(TMP, `r${process.pid}-${++seq}`);
    const w = (rel, v) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), typeof v === 'string' ? v : JSON.stringify(v));
    };
    w('.ai-headquarters/operations/OP-003.md', 'x');
    w('.ai-headquarters/state/approval.json', { session_id: 'S1', operation: 'OP-003' });
    return root;
  };
  const run = (root, input, extra = {}) => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ session_id: 'S1', transcript_path: 'x', cwd: root, hook_event_name: 'PreToolUse', permission_mode: 'default', tool_use_id: 'tu1', ...input, ...extra }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    return out && out.hookSpecificOutput ? out.hookSpecificOutput.permissionDecision : null;
  };

  test('記入例が取り出せる', () => {
    assert.ok(example && example.includes('【変更してよいファイル】'));
    assert.match(example, /^【任務番号】OP-\d+-\d+/);
  });
  test('記入例の命令書は8つの見出しが、型と同じ順番でそろっている', () => {
    assert.deepEqual(headings(example), headings(skillBlocks[0]));
  });
  test('型のブロックをそのまま写した命令書は、範囲が読み取れず、unit の書き込みは全部止まる', () => {
    const root = makeRoot();
    assert.equal(run(root, { tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:unit', prompt: skillBlocks[0], description: 'd' } }), null);
    const scope = JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters/state/unit-scope.json'), 'utf8'));
    assert.deepEqual(scope, { valid: false });
    for (const rel of ['src/a.js', 'src/auth/login.js', 'package.json']) {
      assert.equal(run(root, { tool_name: 'Write', tool_input: { file_path: path.join(root, rel) } }, { agent_id: 'agent-1', agent_type: 'unit' }), 'deny', rel);
    }
  });
  test('起動が通り、範囲が期待どおり記録される。範囲内は通り、範囲外は止まる', () => {
    const root = makeRoot();
    assert.equal(run(root, { tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:unit', prompt: example, description: 'd' } }), null);
    const scope = JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters/state/unit-scope.json'), 'utf8'));
    assert.equal(scope.valid, true);
    assert.deepEqual(scope.entries, EXPECTED);
    const edit = (rel, tool = 'Edit') => run(root, { tool_name: tool, tool_input: { file_path: path.join(root, rel) } }, { agent_id: 'agent-1', agent_type: 'unit' });
    for (const rel of ['src/auth/login.js', 'src/lib/validate.js', 'tests/auth/login.test.js', 'tests/auth/sub/new.test.js']) {
      assert.equal(edit(rel), null, rel);
      assert.equal(edit(rel, 'Write'), null, rel);
    }
    for (const rel of ['package.json', 'src/auth/other.js', 'src/lib/other.js', 'tests/other/a.test.js']) {
      assert.equal(edit(rel), 'deny', rel);
    }
  });
});

describe('記入例の報告', { skip: SKIP_REQ }, () => {
  const [, unitReport, plansReport] = codeBlocks(section(SKILL, '## 記入例'));
  // 必須の見出しは、requirements.md の「必須の見出しは…の5つ」の行から取り出す
  const reqLine = HAS_REQ ? REQ.split('\n').find((l) => l.includes('必須の見出しは')) : '';
  const required = [...reqLine.slice(0, reqLine.indexOf('の5つ')).matchAll(/【([^】]+)】/g)].map((m) => m[1]);
  const planHeads = headings(codeBlocks(SKILL.split('## 記入例')[0])[2]);
  test('必須の見出しは、requirements.md から5つ取り出せる', () => {
    assert.equal(required.length, 5);
    assert.deepEqual(required, ['任務番号', '結論', '根拠', '未解決・懸念', '推測']);
  });
  test('記入例はちょうど3つ(命令書・報告(unit)・報告(plans))', () => {
    assert.equal(codeBlocks(section(SKILL, '## 記入例')).length, 3);
    assert.ok(unitReport && plansReport);
  });
  test('unit の報告: 必須の5つが行の先頭にあり、【実施内容】もある', () => {
    for (const h of [...required, '実施内容']) assert.match(unitReport, new RegExp(`^【${h}】`, 'm'), h);
  });
  test('plans の報告: 必須の5つが行の先頭にある(【実施内容】は不要)', () => {
    for (const h of required) assert.match(plansReport, new RegExp(`^【${h}】`, 'm'), h);
    assert.doesNotMatch(plansReport, /^【実施内容】/m);
  });
  test('plans の報告: 計画書の6つの見出しが行の先頭にあり、【結論】の1行目は要約', () => {
    for (const h of planHeads) assert.match(plansReport, new RegExp(`^【${h}】`, 'm'), h);
    assert.match(plansReport, /^【結論】\S+/m);
  });
  test('plans の報告: 計画書の見出しは【結論】と【根拠】の間にある', () => {
    const order = headings(plansReport);
    assert.deepEqual(order.slice(0, 2 + planHeads.length + 1), ['任務番号', '結論', ...planHeads, '根拠']);
  });
  test('記入例の任務番号は、plans が OP-003-1、unit の命令書と報告が OP-003-2', () => {
    const ex = codeBlocks(section(SKILL, '## 記入例'));
    assert.deepEqual(ex.map((b) => /^【任務番号】(\S+)/m.exec(b)[1]), ['OP-003-2', 'OP-003-2', 'OP-003-1']);
  });
  test('plans の報告: 【手順】の中で【】を使わない', () => {
    const body = plansReport.split(/^【手順】/m)[1].split(/^【リスク】/m)[0];
    assert.doesNotMatch(body, /【/);
  });
});
