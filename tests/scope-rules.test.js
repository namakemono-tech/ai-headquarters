'use strict';
// 【変更してよいファイル】の読み取り規則(parseScope / scopeLine)と、拒否の理由文の自動テスト。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'sr-'));
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

let seq = 0;
const H = '【変更してよいファイル】';
function makeRoot() {
  const root = path.join(TMP, `r${process.pid}-${++seq}`);
  const w = (rel, v) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof v === 'string' ? v : JSON.stringify(v));
  };
  w('.ai-headquarters/operations/OP-001.md', 'x');
  w('.ai-headquarters/state/approval.json', { session_id: 'S1', operation: 'OP-001', plan: '2026-11-22T00:00:00Z', fingerprint: FP.fingerprintOf('x') });
  return root;
}
function run(root, input, extra = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: 'S1', transcript_path: 'x', cwd: root, hook_event_name: 'PreToolUse', permission_mode: 'default', tool_use_id: 'tu1', ...input, ...extra }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  const h = out && out.hookSpecificOutput;
  return { decision: h ? h.permissionDecision : null, reason: h ? h.permissionDecisionReason : '' };
}
const launch = (root, prompt) => run(root, { tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:unit', prompt, description: 'd' } });
const edit = (root, rel) => run(root, { tool_name: 'Edit', tool_input: { file_path: path.join(root, rel) } }, { agent_id: 'agent-1', agent_type: 'unit' });
const scopeOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters/state/unit-scope.json'), 'utf8'));
const hasScope = (root) => fs.existsSync(path.join(root, '.ai-headquarters/state/unit-scope.json'));
const hasLock = (root) => fs.existsSync(path.join(root, '.ai-headquarters/state/unit-lock.json'));

describe('規則1: 見出しは行の先頭にあるものだけ。2つ以上なら読み取れない', () => {
  test('見出し行の途中に出てくる見出し名は無視する', () => {
    const root = makeRoot();
    const prompt = `【状況】前回の命令書の${H}、src/**、を参考にした\n${H}\nsrc/a.js\n【完了条件】動く`;
    assert.equal(launch(root, prompt).decision, null);
    assert.deepEqual(scopeOf(root).entries, ['src/a.js']);
    assert.equal(edit(root, 'src/a.js').decision, null);
    assert.equal(edit(root, 'src/b.js').decision, 'deny');
  });
  test('行の途中にしか無ければ読み取れない(起動を止める)', () => {
    const root = makeRoot();
    assert.equal(launch(root, `【状況】${H}src/a.js を参考にした`).decision, 'deny');
    assert.equal(hasScope(root), false);
  });
  test('先頭の見出しが2つ以上なら、起動を止め、書き込みも全部 deny', () => {
    const root = makeRoot();
    assert.equal(launch(root, `${H}\nsrc/a.js\n【制約】なし\n  ${H}\nsrc/**`).decision, 'deny');
    assert.equal(hasScope(root), false);
    assert.equal(edit(root, 'src/a.js').decision, 'deny');
    assert.equal(edit(root, 'src/b.js').decision, 'deny');
  });
});

describe('規則2: 括弧は空白の後ろの行末の注記だけ取り除く', () => {
  test('パスの中の括弧(Next.js のルートグループ)は残す', () => {
    const root = makeRoot();
    launch(root, `${H}\napp/(auth)/**\nsrc/(main)/page.js\n`);
    assert.deepEqual(scopeOf(root).entries, ['app/(auth)/**', 'src/(main)/page.js']);
    assert.equal(edit(root, 'app/(auth)/login/page.tsx').decision, null);
    assert.equal(edit(root, 'app/(admin)/page.tsx').decision, 'deny');
  });
  test('行末の注記は取り除く(半角は空白の後ろ、全角は空白なしでも)', () => {
    const root = makeRoot();
    launch(root, `${H}\nsrc/a.js (新規)\napp/(auth)/** (ルート)\nsrc/g.js（任意）\n`);
    assert.deepEqual(scopeOf(root).entries, ['src/a.js', 'app/(auth)/**', 'src/g.js']);
  });
});

describe('規則3: 句点「。」を含む項目があれば読み取れない', () => {
  test('型の見出し行の説明文を写した命令書は、起動を止め、書き込みも全部 deny', () => {
    const root = makeRoot();
    const prompt = `${H}unitのみ。ここにないファイルは触らない。1行に1つ、プロジェクトの最上位からの相対パスで書く\n【制約】なし`;
    assert.equal(launch(root, prompt).decision, 'deny');
    assert.equal(hasScope(root), false);
    assert.equal(edit(root, 'src/a.js').decision, 'deny');
  });
  test('次の行以降に句点つきの項目があっても読み取れない(起動を止める)', () => {
    const root = makeRoot();
    assert.equal(launch(root, `${H}\nsrc/a.js\nここを直す。\n`).decision, 'deny');
    assert.equal(hasScope(root), false);
  });
});

describe('拒否の理由文: 読み取れない場合と含まれない場合を分け、書き方を案内する', () => {
  test('読み取れない場合', () => {
    const root = makeRoot();
    launch(root, '【任務番号】OP-1');
    const r = edit(root, 'src/a.js');
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason.includes('読み取れない'), r.reason);
    assert.ok(r.reason.includes('次の行から'), r.reason);
  });
  test('範囲に含まれない場合', () => {
    const root = makeRoot();
    launch(root, `${H}\nsrc/a.js\n`);
    const r = edit(root, 'src/b.js');
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason.includes('含まれていない'), r.reason);
    assert.ok(!r.reason.includes('読み取れない'), r.reason);
    assert.ok(r.reason.includes('次の行から'), r.reason);
  });
});

describe('括弧の注記(空白なし)と、読み間違える書き方の固定', () => {
  test('空白なしの半角括弧でも、中に ASCII 以外があれば注記として取り除く', () => {
    const root = makeRoot();
    launch(root, `${H}\nsrc/a.js(新規)\napp/(auth)\napp/(auth)/page.js(修正)\n`);
    assert.deepEqual(scopeOf(root).entries, ['src/a.js', 'app/(auth)', 'app/(auth)/page.js']);
    assert.equal(edit(root, 'src/a.js').decision, null);
  });
  test('ASCII だけで前に空白の無い括弧は残す', () => {
    const root = makeRoot();
    launch(root, `${H}\napp/(auth)\ndocs/note(1)\n`);
    assert.deepEqual(scopeOf(root).entries, ['app/(auth)', 'docs/note(1)']);
  });
  test('カンマを含むパスは別のパスに分かれる(SKILL.md が書かないよう指示している)', () => {
    const root = makeRoot();
    launch(root, `${H}\nsrc/a,b.js\n`);
    assert.deepEqual(scopeOf(root).entries, ['src/a', 'b.js']);
    assert.equal(edit(root, 'src/a/x.js').decision, null); // 意図しないフォルダまで許してしまう
  });
  test('名前の最後が括弧のパスは注記として取り除かれ、別のパスになる', () => {
    const root = makeRoot();
    launch(root, `${H}\nsrc/memo (copy)\nsrc/note(旧)\n`);
    assert.deepEqual(scopeOf(root).entries, ['src/memo', 'src/note']);
    assert.equal(edit(root, 'src/memo/x.js').decision, null);
  });
});

describe('崩れた命令書では unit を起動させない(2026-11-22)', () => {
  // 0.2.0 の中規模の5回目で、メインセッションが mission-order を読まずに書いた1つ目の命令書
  const BROKEN = [
    '【任務】OP-001-2: 金額表示を「円」付きにする。',
    '【作業場所】C:\\work\\sample',
    '【変更してよいファイル】src/cart.js、src/receipt.js、README.md のみ。テストと他のファイルは変更しない。',
    '【内容】',
    '1. src/cart.js: 表示用の formatYen(n) を追加する。',
    '【完了条件】',
    '必成: 上記3か所の金額表示が円付きになっている。',
  ].join('\n');
  test('起動の時点で止め、mission-order を読み込んで型の見出しどおりに書き直すよう案内する', () => {
    const root = makeRoot();
    const r = launch(root, BROKEN);
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason.includes('mission-order'), r.reason);
    assert.ok(r.reason.includes('型の見出しどおり'), r.reason);
    assert.ok(r.reason.includes('次の行から'), r.reason);
  });
  test('止めたときに、unit の予約と範囲の記録が残らない', () => {
    const root = makeRoot();
    assert.equal(launch(root, BROKEN).decision, 'deny');
    assert.equal(hasLock(root), false, 'unit-lock.json');
    assert.equal(hasScope(root), false, 'unit-scope.json');
  });
  test('止めたあと、書き直した命令書なら起動できる(予約が邪魔をしない)', () => {
    const root = makeRoot();
    assert.equal(launch(root, BROKEN).decision, 'deny');
    assert.equal(launch(root, `【任務番号】OP-001-2\n${H}\nsrc/cart.js\n【完了条件】動く`).decision, null);
    assert.deepEqual(scopeOf(root).entries, ['src/cart.js']);
    assert.equal(hasLock(root), true);
  });
  test('実行中の unit がいるときに崩れた命令書で起動しても、実行中の範囲の記録を壊さない', () => {
    const root = makeRoot();
    assert.equal(launch(root, `${H}\nsrc/a.js`).decision, null);
    assert.equal(launch(root, BROKEN).decision, 'deny');
    assert.deepEqual(scopeOf(root).entries, ['src/a.js']);
    assert.equal(edit(root, 'src/a.js').decision, null);
  });
  test('欄が無い命令書も、起動の時点で止める', () => {
    const root = makeRoot();
    assert.equal(launch(root, '【任務番号】OP-1\n【任務】x').decision, 'deny');
    assert.equal(hasLock(root), false);
  });
});
