'use strict';
// 0.6.0 の Hooks のうち、承認の引き継ぎ(v060-approval.test.js)の外のもの。
// - 承認の記録の細部: 「承認」の一致の規則、壊れた入力、作戦番号の揺れ、目標の決心の行の語、方針が無いとき(approval.test.js から移した)
// - 指紋: approval.js と guard.js の印のあいだが一字も違わないこと、書式(fingerprint.test.js から移した)
// - 時計と知らせ(伺4): clock.js の事実の知らせと設定の線、guard.js の指揮官の画面への1回だけの知らせ
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

const H = (n) => path.join(__dirname, '..', 'hooks', n);
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'v6h-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ } });

const OP = (decision = '未決心', policy = '要旨: unit が src/a.js を直す\n変更してよい範囲: src/a.js') => `# OP-001
## 企図
src/a.js を直す
## 目標
必成: src/a.js が直っている
## 方針
${policy}
## 承認
目標の決心: ${decision}
## いま
なし
## 任務の記録
なし
## 処置事項
なし
## 結果
未完了
`;
let seq = 0;
function fix(files = { 'OP-001.md': OP() }, extra = {}) {
  const root = path.join(TMP, `r${++seq}`);
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', n), t);
  for (const [rel, t] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), typeof t === 'string' ? t : JSON.stringify(t)); }
  return root;
}
function runRaw(name, root, raw, args = []) {
  const r = spawnSync(process.execPath, [H(name), ...args], { input: raw, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
const hook = (name, root, input, args) => { const r = runRaw(name, root, JSON.stringify({ cwd: root, ...input }), args); return r.stdout.trim() ? JSON.parse(r.stdout) : {}; };
const ctx = (o) => (o.hookSpecificOutput || {}).additionalContext || '';
const say = (root, prompt, s = 'S1') => hook('approval.js', root, { session_id: s, hook_event_name: 'UserPromptSubmit', prompt });
const rows = (root) => { try { return fs.readFileSync(path.join(root, '.ai-headquarters', 'state', 'approvals.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const ORDER = '【企図】x\n【任務】x\n【状況】なし\n【変更してよいファイル】\nsrc/a.js\n【制約と完了条件】動く\n【報告してほしいこと】なし';
function launch(root, s = 'S1') {
  const o = hook('guard.js', root, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `t${++seq}`, permission_mode: 'default', tool_input: { subagent_type: 'ai-headquarters:unit', prompt: ORDER, description: 'd' } });
  try { fs.unlinkSync(path.join(root, '.ai-headquarters', 'state', 'unit-lock.json')); } catch { /* 無い */ }
  return o;
}
const dec = (o) => (o.hookSpecificOutput || {}).permissionDecision || null;

describe('承認の記録: 「承認」の一致の規則', () => {
  for (const p of ['承認', ' 承認 ', '　承認　', '承認。', '承認!', '承認！', '承認！！', '承認。！!', ' 　承認。　\n']) {
    test(`一致: ${JSON.stringify(p)}`, () => {
      const root = fix();
      assert.match(ctx(say(root, p)), /OP-001 に記録しました/);
      assert.equal(rows(root).length, 1);
    });
  }
  for (const p of ['承認します', '承認。続けて', '承認 お願い', '承認承認', '未承認', '承 認', 'approve', '', '<task-notification>\n<result>承認</result>\n</task-notification>', '承認\n承認', '承認?', '続けて', '進めて', 5, null]) {
    test(`不一致: ${JSON.stringify(p)}`, () => {
      const root = fix();
      const r = runRaw('approval.js', root, JSON.stringify({ cwd: root, session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: p }));
      assert.equal(r.stdout, '');
      assert.equal(rows(root).length, 0);
    });
  }
});

describe('承認の記録: 壊れた入力と、作戦記録の無いとき', () => {
  for (const b of ['', 'not json', '[]', 'null', '{"prompt":', '"承認"']) {
    test(`壊れた入力 ${JSON.stringify(b)} でも exit 0・出力なし`, () => {
      const root = fix();
      assert.equal(runRaw('approval.js', root, b).stdout, '');
      assert.equal(runRaw('approval.js', root, b, ['post']).stdout, '');
    });
  }
  test('作戦記録が無ければ .ai-headquarters を作らない', () => {
    const root = path.join(TMP, `empty${++seq}`);
    fs.mkdirSync(root, { recursive: true });
    assert.match(ctx(say(root, '承認')), /作戦記録が無い/);
    assert.equal(fs.existsSync(path.join(root, '.ai-headquarters')), false);
  });
  for (const [label, s] of [['無い', undefined], ['空文字', ''], ['数値', 5], ['null', null]]) {
    test(`session_id が${label}ときは記録しない`, () => {
      const root = fix();
      runRaw('approval.js', root, JSON.stringify({ cwd: root, session_id: s, hook_event_name: 'UserPromptSubmit', prompt: '承認' }));
      assert.equal(rows(root).length, 0);
    });
  }
  test('state が書けない(同名のファイルがある)ときも exit 0', () => {
    const root = fix(undefined, { '.ai-headquarters/state': 'x' });
    runRaw('approval.js', root, JSON.stringify({ cwd: root, session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: '承認' }));
  });
});

describe('承認の記録: 作戦番号の揺れ', () => {
  test('op-010.md と OP-9.md が混ざっても最大(10)に結び付き、guard が通す', () => {
    const root = fix({ 'OP-9.md': OP(), 'op-010.md': OP('修正 物差しを足した') });
    say(root, '承認');
    assert.equal(rows(root)[0].operation, 'OP-010');
    assert.equal(rows(root)[0].kind, 'plan');
    assert.equal(dec(launch(root)), null);
  });
  test('4桁の番号でも結び付き、guard が通す', () => {
    const root = fix({ 'OP-1234.md': OP('省略 企図に目標がすべてある') });
    say(root, '承認');
    assert.equal(rows(root)[0].operation, 'OP-1234');
    assert.equal(dec(launch(root)), null);
  });
  test('新しい作戦記録を作ると、前の作戦の承認では通らない', () => {
    const root = fix({ 'OP-001.md': OP('修正 x') });
    say(root, '承認');
    assert.equal(dec(launch(root)), null);
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-002.md'), OP('修正 x'));
    assert.equal(dec(launch(root)), 'deny');
  });
});

describe('承認の記録: 「目標の決心: 」の行の語と、方針', () => {
  for (const [line, kind] of [['未決心', 'goals'], ['修正 物差しを1つ足した', 'plan'], ['省略 企図に目標がすべてある', 'plan'], ['承認 2026-11-25 10:00', 'goals'], ['未決心(回答待ち)', 'goals'], ['しゅうせい', 'goals']]) {
    test(`「目標の決心: ${line}」での最初の「承認」は ${kind}`, () => {
      const root = fix({ 'OP-001.md': OP(line) });
      say(root, '承認');
      assert.equal(rows(root)[0].kind, kind);
      assert.equal(dec(launch(root)), kind === 'plan' ? null : 'deny');
    });
  }
  test('「目標の決心: 」の行が無い作戦記録では、目標の決心に倒す', () => {
    const root = fix({ 'OP-001.md': OP().replace(/^目標の決心: .*\n/m, '') });
    say(root, '承認');
    assert.equal(rows(root)[0].kind, 'goals');
  });
  for (const [label, policy] of [['未作成', '未作成'], ['空', ''], ['括弧だけ', '(行動方針の要旨、変更してよい範囲)']]) {
    test(`方針が${label}のときは、計画の決心として記録せず、案内を出す`, () => {
      const root = fix({ 'OP-001.md': OP('修正 x', policy) });
      assert.match(ctx(say(root, '承認')), /「## 方針」が書かれていない/);
      assert.equal(rows(root).length, 0);
      assert.equal(dec(launch(root)), 'deny');
    });
  }
  test('計画の決心では、「## 承認」に計画の決心の1行が書き足される(指紋つき)', () => {
    const root = fix({ 'OP-001.md': OP('修正 x') });
    say(root, '承認');
    const t = fs.readFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-001.md'), 'utf8');
    const fp = FP.fingerprints(t);
    assert.match(t, new RegExp(`## 承認\\n目標の決心: 修正 x\\n計画の決心: 承認 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\(指紋 ${fp.fp_goals}/${fp.fp_policy}\\)\\n## いま`));
  });
});

describe('0.5.0 までの形の作戦記録(互換の処理は持たず、区切りで閉じて残りを新しい作戦として立てる移し方を示す。T0 の決心と第3段の指示)', () => {
  // 0.5.0 の雛形の要所(「### 時程」「## 計画」「### 目標の決心」)。計画の決心まで受けて、unit を動かしていた作戦
  const OLD = `# OP-002 作戦記録
## 企図
x
## 目標
### 必成目標
src/a.js が直っている
### 時程
計画の持ち時間: 30分
## 計画
手順1 unit が src/a.js を直す
## 承認
### 目標の決心
承認: 2026-11-20 10:00
### 計画の決心
承認: 2026-11-20 10:10
## 結果
未完了
`;
  const oldFix = () => fix({ 'OP-002.md': OLD }, {
    '.ai-headquarters/state/approval.json': { session_id: 'S1', operation: 'OP-002', plan: '2026-11-20T01:10:00Z', fingerprint: 'abc' },
    '.ai-headquarters/state/approvals.jsonl': `${JSON.stringify({ session_id: 'S1', operation: 'OP-002', kind: 'plan', fingerprint: 'abc', copy: {} })}\n`,
  });
  const NEW_HINT = /0\.5\.0 までの形[\s\S]*書き直すより[\s\S]*OP-002 の「## 結果」の最初の行[\s\S]*閉じる[\s\S]*次の番号の作戦記録[\s\S]*新しい雛形[\s\S]*経過: OP-002[\s\S]*1行だけ[\s\S]*「承認」/;
  test('unit の起動は、承認を持っていたセッションでも止まり、閉じて新しい作戦を立てる移し方を示す', () => {
    const root = oldFix();
    for (const s of ['S1', 'S2']) {
      const o = launch(root, s);
      assert.equal(dec(o), 'deny', s);
      assert.match(o.hookSpecificOutput.permissionDecisionReason, NEW_HINT);
    }
  });
  test('「承認」は記録せず、移し方を示す', () => {
    const root = oldFix();
    const before = rows(root).length;
    assert.match(ctx(say(root, '承認')), NEW_HINT);
    assert.equal(rows(root).length, before);
  });
  test('セッションの開始で、古い形のまま続いていることと、移し方を知らせる', () => {
    const root = oldFix();
    const t = ctx(hook('session-start.js', root, { session_id: 'S9', hook_event_name: 'SessionStart' }));
    assert.match(t, /OP-002 は 0\.5\.0 までの形の作戦記録で、続いています/);
    assert.match(t, NEW_HINT);
  });
  test('移し方の文は、guard.js、approval.js、session-start.js で一字も違わない', () => {
    const pick = (n) => { const m = /^const MIGRATE = .*$/m.exec(fs.readFileSync(H(n), 'utf8')); assert.ok(m, n); return m[0]; };
    assert.equal(pick('approval.js'), pick('guard.js'));
    assert.equal(pick('session-start.js'), pick('guard.js'));
  });
  test('移し方のとおり、古い作戦を閉じ、経過の1行を置いた新しい作戦を立てると、承認を受けて unit を起動できる(閉じた古い作戦は知らせに出ない)', () => {
    const root = oldFix();
    const dir = path.join(root, '.ai-headquarters', 'operations');
    fs.writeFileSync(path.join(dir, 'OP-002.md'), OLD.replace('## 結果\n未完了', '## 結果\nR9 まで終えた。残りは次の作戦に移す(OP-003)'));
    fs.writeFileSync(path.join(dir, 'OP-003.md'), OP().replace('# OP-001', '# OP-003').replace('## 企図\nsrc/a.js を直す', '## 企図\nsrc/a.js を直す\n経過: OP-002(0.5.0 の形の記録)'));
    assert.equal(ctx(hook('session-start.js', root, { session_id: 'S9', hook_event_name: 'SessionStart' })).includes('OP-002'), false);
    assert.equal(dec(launch(root, 'S1')), 'deny');
    say(root, '承認');
    const p3 = path.join(dir, 'OP-003.md');
    fs.writeFileSync(p3, fs.readFileSync(p3, 'utf8').replace('目標の決心: 未決心', '目標の決心: 承認'));
    say(root, '承認');
    assert.deepEqual(rows(root).filter((r) => r.operation === 'OP-003').map((r) => r.kind), ['goals', 'plan']);
    assert.equal(dec(launch(root, 'S1')), null);
  });
  test('新しい雛形に書き直し、目標と計画の「承認」を入れ直すと、unit を起動できる', () => {
    const root = oldFix();
    fs.writeFileSync(path.join(root, '.ai-headquarters', 'operations', 'OP-002.md'), OP('修正 0.5.0 の作戦記録を新しい雛形に書き直した').replace('# OP-001', '# OP-002'));
    say(root, '承認');
    assert.equal(dec(launch(root, 'S1')), null);
  });
});

describe('独立した点検(T10)の指摘で直したもの', () => {
  const opDir = (root) => path.join(root, '.ai-headquarters', 'operations');
  test('重1: 閉じた作戦の承認では unit を起動できず、閉じた作戦には「承認」を記録しない', () => {
    const root = fix({ 'OP-001.md': OP('修正 x') });
    say(root, '承認');
    assert.equal(dec(launch(root, 'S1')), null, '閉じる前は起動できる');
    const p = path.join(opDir(root), 'OP-001.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('## 結果\n未完了', '## 結果\n完了: 直した'));
    const o = launch(root, 'S1');
    assert.equal(dec(o), 'deny');
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /OP-001 は閉じています[\s\S]*次の番号の作戦記録/);
    const before = rows(root).length;
    assert.match(ctx(say(root, '承認')), /閉じている[\s\S]*記録していません/);
    assert.equal(rows(root).length, before);
    assert.equal(fs.readFileSync(p, 'utf8').split('計画の決心: ').length - 1, 1, '閉じた作戦の「## 承認」に行を足さない');
  });
  test('軽1: 「引き継ぎ待ち: なし」は引き継ぎ待ちとして記録せず、別のセッションは受け継げない。日時を書いた行は記録する', () => {
    const root = fix({ 'OP-001.md': OP('修正 x') });
    say(root, '承認');
    const p = path.join(opDir(root), 'OP-001.md');
    const post = (line) => {
      const t = fs.readFileSync(p, 'utf8').replace(/## いま\n[^\n]*\n/, `## いま\n${line}\n`);
      fs.writeFileSync(p, t);
      hook('approval.js', root, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: p, old_string: 'なし', new_string: line } }, ['post']);
    };
    post('引き継ぎ待ち: なし');
    assert.equal(rows(root).some((r) => r.kind === 'offer'), false);
    assert.equal(dec(launch(root, 'S2')), 'deny');
    post('引き継ぎ待ち: 2026-11-26 10:00。残りは手順2');
    assert.equal(rows(root).some((r) => r.kind === 'offer'), true);
    assert.equal(dec(launch(root, 'S2')), null);
  });
  test('軽2: 新しい雛形に「## 計画」の見出しを足しても、0.5.0 までの形と見なさない', () => {
    const root = fix({ 'OP-001.md': OP('修正 x').replace('## いま', '## 計画\n手順1 unit が直す\n## いま') });
    say(root, '承認');
    assert.equal(dec(launch(root, 'S1')), null);
  });
});

describe('指紋', () => {
  test('approval.js と guard.js の指紋の印のあいだが、一字も違わない', () => {
    assert.equal(FP.fpBlock(H('guard.js')), FP.fpBlock(H('approval.js')));
  });
  test('指紋は16進の12文字で、「## 目標」と「## 方針」から取る', () => {
    const a = FP.fingerprints(OP());
    assert.match(a.fp_goals, /^[0-9a-f]{12}$/);
    assert.match(a.fp_policy, /^[0-9a-f]{12}$/);
    assert.notEqual(FP.fingerprints(OP().replace('必成: src/a.js', '必成: src/b.js')).fp_goals, a.fp_goals);
    assert.notEqual(FP.fingerprints(OP('未決心', '要旨: 別')).fp_policy, a.fp_policy);
    // 空行と行末の空白、節の外は指紋を変えない
    assert.deepEqual(FP.fingerprints(OP().replace('## 方針\n', '## 方針\n\n').replace('src/a.js が直っている', 'src/a.js が直っている  ')), a);
    assert.deepEqual(FP.fingerprints(OP().replace('## いま\nなし', '## いま\n次は inspector')), a);
  });
});

describe('時計(clock.js。伺4 の事実の知らせ)', () => {
  const cfg = (notice) => ({ '.ai-headquarters/config.json': { notice } });
  const clock = (root, input) => ctx(hook('clock.js', root, { session_id: 'S1', ...input }));
  test('作戦中(「## 結果」が未完了)は、指揮官の発言で事実の1行を返す。数字は作業の時間と起動の回数と線', () => {
    const root = fix();
    const t = clock(root, { hook_event_name: 'UserPromptSubmit', prompt: '承認' });
    assert.match(t, /^時計: \d{4}-\d{2}-\d{2} \d{2}:\d{2}。/);
    assert.ok(t.endsWith('OP-001 は開始から 0分。作業 0分(線 60分)、起動 0回(線 12回)。'), t);
  });
  test('「### 時程」が無くても動き、結果が完了なら何もしない', () => {
    const root = fix({ 'OP-001.md': OP().replace('## 結果\n未完了', '## 結果\n完了: 直した') });
    assert.equal(clock(root, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }), '');
    assert.equal(fs.existsSync(path.join(root, '.ai-headquarters', 'state', 'clock.jsonl')), false);
  });
  test('4体の終わり(PostToolUse の Agent)で、役と時間を知らせる', () => {
    const root = fix();
    const t = clock(root, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:unit', prompt: ORDER }, tool_response: { totalDurationMs: 180000, agentId: 'a1' } });
    assert.match(t, /unit は 3分。/);
  });
  test('起動の回数が線を超えると、知らせに書く(止めない)', () => {
    const lines = Array.from({ length: 3 }, (_, i) => JSON.stringify({ operation: 'OP-001', agent_id: `a${i}` })).join('\n');
    const root = fix(undefined, { ...cfg({ launches: 2, minutes: 60 }), '.ai-headquarters/state/launches.jsonl': `${lines}\n` });
    const t = clock(root, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    assert.ok(t.includes('起動 3回(線 2回)。起動が線(2回)を超えています。'), t);
  });
  test('線を 0 にすると、その線は知らせに出さない', () => {
    const root = fix(undefined, cfg({ launches: 0, minutes: 0 }));
    const t = clock(root, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    assert.match(t, /作業 0分、起動 0回。$/);
  });
  test('壊れた入力と、読めない状態ファイルでも止めない', () => {
    const root = fix(undefined, { '.ai-headquarters/state/clock.jsonl': '{bad\n' });
    for (const b of ['', 'not json', 'null']) assert.equal(runRaw('clock.js', root, b).stdout, '');
    clock(root, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  });
  test('clock.js は 200行以内で、hooks.json の3つのイベントに登録されている', () => {
    assert.ok(fs.readFileSync(H('clock.js'), 'utf8').split('\n').length <= 200);
    const hj = fs.readFileSync(H('hooks.json'), 'utf8');
    const reg = JSON.parse(hj).hooks;
    for (const ev of ['UserPromptSubmit', 'Stop', 'PostToolUse']) assert.ok(JSON.stringify(reg[ev]).includes('clock.js'), ev);
  });
});

describe('設定の線の画面への知らせ(guard.js。伺4。止めずに、作戦ごと・線ごとに1回)', () => {
  const pre = (root, input) => hook('guard.js', root, { session_id: 'S1', hook_event_name: 'PreToolUse', permission_mode: 'default', tool_use_id: `t${++seq}`, ...input });
  const agentCall = (root) => pre(root, { tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:inspector', prompt: 'x', description: 'd' } });
  const launches = (n) => `${Array.from({ length: n }, (_, i) => JSON.stringify({ operation: 'OP-001', agent_id: `a${i}` })).join('\n')}\n`;
  test('線の手前では知らせず、超える起動で1回だけ知らせる', () => {
    const root = fix(undefined, { '.ai-headquarters/config.json': { notice: { launches: 2 } }, '.ai-headquarters/state/launches.jsonl': launches(1) });
    assert.equal(agentCall(root).systemMessage, undefined, '2回目の起動は線の内');
    fs.appendFileSync(path.join(root, '.ai-headquarters', 'state', 'launches.jsonl'), launches(2).split('\n')[1] + '\n');
    const o = agentCall(root);
    assert.ok(o.systemMessage.startsWith('【AI司令部】OP-001: 起動が設定の線(2回)を超えました(この起動で3回目)。止めずに続けています。'), o.systemMessage);
    assert.match(ctx(o), /切り上げか縮小の案/);
    assert.equal(dec(o), null, '止めない');
    assert.equal(agentCall(root).systemMessage, undefined, '2回目は出さない');
  });
  test('作業の時間の線は、時計の記録から数え、どのツールの前でも知らせる', () => {
    const start = new Date(Date.now() - 90 * 60000).toISOString();
    const root = fix(undefined, { '.ai-headquarters/state/clock.jsonl': `${JSON.stringify({ operation: 'OP-001', ev: 'start', ts: start })}\n` });
    const o = pre(root, { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    assert.ok(o.systemMessage.includes('作業の時間が設定の線(60分)を超えました(いま90分)'), o.systemMessage);
    assert.equal(pre(root, { tool_name: 'Bash', tool_input: { command: 'npm test' } }).systemMessage, undefined);
  });
  test('サブエージェントの操作、止めた操作、作戦の外では知らせない', () => {
    const extra = { '.ai-headquarters/config.json': { notice: { launches: 1 } }, '.ai-headquarters/state/launches.jsonl': launches(3) };
    const r1 = fix(undefined, extra);
    assert.equal(pre(r1, { tool_name: 'Bash', agent_id: 'x', agent_type: 'ai-headquarters:unit', tool_input: { command: 'npm test' } }).systemMessage, undefined);
    assert.equal(pre(r1, { tool_name: 'Bash', tool_input: { command: 'rm -rf .ai-headquarters' } }).systemMessage, undefined, '止めた操作');
    const r2 = fix({ 'OP-001.md': OP().replace('## 結果\n未完了', '## 結果\n完了: x') }, extra);
    assert.equal(agentCall(r2).systemMessage, undefined, '作戦の外');
  });
});
