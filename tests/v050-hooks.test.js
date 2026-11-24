'use strict';
// 0.5.0 の Hooks(第1段): 承認の記録を1行ずつ(approvals.jsonl)と計画の控え、時計(clock.js)、【統制】の読み取り、
// 持ち時間の知らせ、点検の単位の数え、承認の引き継ぎ、第1段の節目の下限。「### 時程」の欄のある作戦記録で確かめる。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const H = (n) => path.join(__dirname, '..', 'hooks', n);
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'v5-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ } });

const PLAN = [
  '【目標】必成: x',
  '【手順】',
  '手順1 担当: unit。危険度: 中。持ち時間: 20分。src/a.js を直す',
  '手順2 担当: unit。危険度: 低。持ち時間: 10分。src/b.js を直す',
  '【点検と節目】',
  '単1 手順1〜2 のあと。持ち時間: 10分。物1 を npm test で確かめる',
  '節目: なし',
  '【リスクと代替案】なし',
].join('\n');
const OP = ({ plan = '未作成', goals = '未決心', deadline = '期限: 作業の時間で 120分', timetable = true, scale = '中', result = '未完了', handover = 'なし', extra = '' } = {}) => `# OP-001 作戦記録

## 企図
x

## 目標
### 必成目標
x
### 点検の物差し
物1: npm test の失敗が0件
点検の上限: 同じ点検の単位につき2回
### 起動の上限
12回(見込み 6回)
${deadline}
${timetable ? '### 時程\n計画の持ち時間: 30分\n実行と点検の見込み: 40分(手順 30分、点検 10分)\n余り: 50分\n刻み: 30分\n引き直し: なし\n' : ''}
## 規模と編成
${scale}
${extra}
## 計画
${plan}

## 承認
### 目標の決心
${goals}
### 計画の決心
未決心
### 引き継ぎ
${handover}

## 結果
${result}
`;
let seq = 0;
const opFile = (root) => path.join(root, '.ai-headquarters', 'operations', 'OP-001.md');
function fix(body = OP()) {
  const root = path.join(TMP, `r${++seq}`);
  fs.mkdirSync(path.join(root, '.ai-headquarters', 'operations'), { recursive: true });
  fs.writeFileSync(opFile(root), body);
  return root;
}
const env = (root) => ({ ...process.env, CLAUDE_PROJECT_DIR: root });
function hook(name, root, input, args = []) {
  const r = spawnSync(process.execPath, [H(name), ...args], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8', env: env(root) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}
const ctx = (o) => (o.hookSpecificOutput || {}).additionalContext || '';
const say = (root, s, prompt = '承認') => ctx(hook('approval.js', root, { session_id: s, hook_event_name: 'UserPromptSubmit', prompt }));
const rows = (root, f = 'approvals.jsonl') => { try { return fs.readFileSync(path.join(root, '.ai-headquarters', 'state', f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const setPlan = (root, plan = PLAN) => fs.writeFileSync(opFile(root), fs.readFileSync(opFile(root), 'utf8').replace(/## 計画\n[\s\S]*?\n\n## 承認/, `## 計画\n${plan}\n\n## 承認`));

describe('承認の記録と控え(approvals.jsonl)', () => {
  test('目標の決心、計画の決心、2回目の「承認」が1行ずつ足される', () => {
    const root = fix();
    assert.match(say(root, 'S1'), /目標の決心として OP-001 に記録しました/);
    setPlan(root);
    assert.match(say(root, 'S1'), /計画の決心として OP-001 に記録しました\(指紋 [0-9a-f]{12}\)/);
    const c = say(root, 'S1');
    assert.match(c, /OP-001 に記録し直しました/);
    assert.ok(!c.includes('節目の承認'), '記録し直しは、節目の承認と名乗らない');
    assert.ok(c.includes('このあと、目標の3つの欄か計画の節を書き換えると、unit を起動できなくなります。'));
    assert.ok(!c.includes('前の承認の指紋'), '指紋が同じなら、書き換えの知らせは無い');
    assert.deepEqual(rows(root).map((r) => r.kind), ['goals', 'plan', 'milestone']);
    assert.ok(!fs.existsSync(path.join(root, '.ai-headquarters', 'state', 'approval.json')), '0.5.0 の作戦では approval.json を使わない');
  });
  test('計画の決心の行に、指紋と控えがある', () => {
    const root = fix(OP({ goals: '省略: 小さな作戦', plan: PLAN }));
    say(root, 'S1');
    const r = rows(root)[0];
    assert.equal(r.kind, 'plan');
    assert.match(r.fingerprint, /^[0-9a-f]{12}$/);
    assert.deepEqual(r.copy, {
      launch_limit: 12, inspect_limit: 2, deadline: '作業の時間で 120分', slack: 50, tick: 30,
      steps: [{ step: '1', role: 'unit', minutes: 20, risk: '中' }, { step: '2', role: 'unit', minutes: 10, risk: '低' }],
      units: [{ unit: '単1', minutes: 10, steps: ['1', '2'], redo: null }], milestones: [], floor: 3,
    });
  });
  test('持ち時間の読み取れない計画では記録されず、どの行かの案内が出る', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN.replace('手順2 担当: unit。危険度: 低。持ち時間: 10分。', '手順2 担当: unit。持ち時間: 少し。') }));
    const c = say(root, 'S1');
    assert.match(c, /持ち時間か危険度を読み取れない行があるため/);
    assert.ok(c.includes('- 手順2 担当: unit。持ち時間: 少し。'), c);
    assert.deepEqual(rows(root), []);
  });
  test('危険度の読み取れない手順の行では記録されず、どの行かの案内が出る(第2段)', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN.replace('危険度: 低。', '') }));
    assert.ok(say(root, 'S1').includes('- 手順2 担当: unit。持ち時間: 10分。src/b.js を直す'));
    assert.deepEqual(rows(root), []);
  });
  test('節目と節目の下限と、受け持つ手順の書き方(手順1、2)を控える(第2段)', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN.replace('単1 手順1〜2 のあと。', '単1 手順1、2 のあと。').replace('節目: なし', '節目: 手順2 の前\n節目の下限: unit 2回') }));
    say(root, 'S1');
    const c = rows(root)[0].copy;
    assert.deepEqual(c.milestones, ['2']); assert.equal(c.floor, 2); assert.deepEqual(c.units[0].steps, ['1', '2']);
  });
  test('2回目の前に計画を書き換えると、書き換えの知らせが足される(止めない)', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN }));
    say(root, 'S1');
    setPlan(root, PLAN.replace('src/a.js を直す', 'src/a.js と src/c.js を直す'));
    const c = say(root, 'S1');
    assert.match(c, /記録し直しました/);
    assert.match(c, /前の承認の指紋\([0-9a-f]{12}\)と違います/);
  });
  test('計画が無いときは、計画の決心として記録されない', () => {
    const root = fix(OP({ goals: '省略: x' }));
    assert.match(say(root, 'S1'), /計画書が書かれていない/);
    assert.deepEqual(rows(root), []);
  });
  test('指揮官以外の発言(報告の知らせ)と「続けて」は記録しない', () => {
    const root = fix();
    assert.equal(say(root, 'S1', '<task-notification>承認'), '');
    assert.equal(say(root, 'S1', '続けてください'), '');
    assert.deepEqual(rows(root), []);
  });
  test('別のセッションの「承認」は、申し出が無ければ目標の決心になる(作戦記録が「省略:」でも)', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN }));
    say(root, 'S1');
    assert.match(say(root, 'S2'), /目標の決心として/);
    assert.deepEqual(rows(root).map((r) => `${r.kind}:${r.session_id}`), ['plan:S1', 'goals:S2']);
  });
});

describe('時計(clock.js)', () => {
  const clock = (root, input) => ctx(hook('clock.js', root, input));
  test('作戦中なら、指揮官の発言で時刻と期限の知らせを返し、clock.jsonl に記録する', () => {
    const root = fix();
    const c = clock(root, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: '進めて' });
    assert.match(c, /^時計: \d{4}-\d\d-\d\d \d\d:\d\d。OP-001 は開始から 0分\(作業 0分\)。期限まで 120分。計画の持ち時間は残り 30分。起動 0\/12回。$/);
    assert.deepEqual(rows(root, 'clock.jsonl').map((r) => r.ev), ['start', 'prompt']);
  });
  test('報告の知らせと応答の終わりは、記録だけで知らせない', () => {
    const root = fix();
    assert.equal(clock(root, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1' }), '');
    assert.equal(clock(root, { session_id: 'S1', hook_event_name: 'Stop' }), '');
    assert.deepEqual(rows(root, 'clock.jsonl').map((r) => r.ev), ['start', 'notification', 'stop']);
  });
  test('4体の終わりで、【統制】と所要時間を記録し、超過と余りの残りを知らせる', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN }));
    say(root, 'S1');
    const c = clock(root, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:unit', prompt: '【任務番号】OP-001-1\n【統制】手順1。持ち時間: 20分。\n次は inspector' }, tool_response: { totalDurationMs: 31 * 60000 } });
    assert.match(c, /OP-001-1 unit は 31分\(持ち時間 20分。11分の超過\)。/);
    assert.match(c, /期限まで 120分、残りの見込み 20分、余りの残り 100分\(認めた余り 50分\)。/);
    const end = rows(root, 'clock.jsonl').find((r) => r.ev === 'agent_end');
    assert.equal(end.step, '1'); assert.equal(end.minutes, 20); assert.equal(end.actual_min, 31);
  });
  test('余りの残りが半分を切る、0を切る、計画の持ち時間を超える', () => {
    const r1 = fix(OP({ goals: '省略: x', plan: PLAN, deadline: '期限: 作業の時間で 60分' }));
    say(r1, 'S1');
    assert.match(clock(r1, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), /余りの残り 20分.*遅れの見込みです。時程を引き直し、指揮官に知らせてください。$/);
    const r2 = fix(OP({ goals: '省略: x', plan: PLAN, deadline: '期限: 作業の時間で 30分' }));
    say(r2, 'S1');
    assert.match(clock(r2, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), /このままでは期限に間に合いません。/);
    const r3 = fix(OP({ deadline: '期限: 2000-01-01 00:00' }));
    fs.mkdirSync(path.join(r3, '.ai-headquarters', 'state'), { recursive: true });
    const t = new Date(Date.now() - 40 * 60000).toISOString();
    fs.writeFileSync(path.join(r3, '.ai-headquarters', 'state', 'clock.jsonl'), `${JSON.stringify({ ts: t, operation: 'OP-001', ev: 'start' })}\n${JSON.stringify({ ts: t, operation: 'OP-001', ev: 'prompt' })}\n`);
    assert.match(clock(r3, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), /計画の持ち時間は残り -10分。.*計画の持ち時間を超えました。/);
  });
  test('作戦中でなければ何も出さない(結果を書き終えた、時程の無い 0.4.1 の作戦、作戦記録が無い)', () => {
    for (const root of [fix(OP({ result: '完了: x' })), fix(OP({ timetable: false })), path.join(TMP, 'none')]) {
      fs.mkdirSync(root, { recursive: true });
      assert.equal(clock(root, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), '');
    }
  });
  test('動かなくても、発言を止めない(壊れた入力と、読めない状態ファイル)', () => {
    const root = fix();
    const r = spawnSync(process.execPath, [H('clock.js')], { input: '{壊れ', encoding: 'utf8', env: env(root) });
    assert.equal(r.status, 0);
    fs.mkdirSync(path.join(root, '.ai-headquarters', 'state', 'clock.jsonl'), { recursive: true });
    const r2 = spawnSync(process.execPath, [H('clock.js')], { input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'x' }), encoding: 'utf8', env: env(root) });
    assert.equal(r2.status, 0);
  });
  test('clock.js は 200行以内で、hooks.json の3つのイベントに登録されている', () => {
    assert.ok(fs.readFileSync(H('clock.js'), 'utf8').split('\n').length <= 200);
    const h = JSON.parse(fs.readFileSync(H('hooks.json'), 'utf8')).hooks;
    const has = (ev, m) => h[ev].some((g) => (m === undefined || g.matcher === m) && g.hooks.some((x) => x.args.some((a) => a.endsWith('/hooks/clock.js'))));
    assert.ok(has('UserPromptSubmit')); assert.ok(has('Stop')); assert.ok(has('PostToolUse', 'Agent|Task'));
  });
});

// ---------------------------------------------------------------- guard.js(T4)
let tu = 0;
function launch(root, s, type = 'ai-headquarters:unit', prompt = '【任務番号】OP-001-1\n【統制】手順1。持ち時間: 20分。\n次は inspector\n【変更してよいファイル】\n- src/a.js') {
  const o = hook('guard.js', root, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `tu${++tu}`, permission_mode: 'default', tool_input: { subagent_type: type, prompt, description: 'd' } });
  const h = o.hookSpecificOutput || {};
  return { d: h.permissionDecision || null, reason: h.permissionDecisionReason || '', ctx: h.additionalContext || '', msg: o.systemMessage || '' };
}
let ag = 0;
function started(root, s, type = 'ai-headquarters:unit') {
  const id = `ag${++ag}`;
  hook('guard.js', root, { session_id: s, hook_event_name: 'SubagentStart', agent_type: type, agent_id: id }, ['subagent-start']);
  return id;
}
const unlock = (root) => { try { fs.unlinkSync(path.join(root, '.ai-headquarters', 'state', 'unit-lock.json')); } catch { /* 無い */ } };
// メインセッションが作戦記録の「### 引き継ぎ」を書き換えたあと(PostToolUse)を起こす。書き込みは、ここで実際に行う
function mainEdit(root, s, newString) {
  const before = fs.readFileSync(opFile(root), 'utf8');
  fs.writeFileSync(opFile(root), before.replace('### 引き継ぎ\nなし', `### 引き継ぎ\n${newString}`));
  return hook('approval.js', root, { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: opFile(root), old_string: 'なし', new_string: newString } }, ['post']);
}
const approved = (opts = {}) => { const root = fix(OP({ goals: '省略: x', plan: PLAN, ...opts })); say(root, 'S1'); return root; };

describe('guard.js: 【統制】の読み取り', () => {
  test('【統制】の無い命令書、持ち時間の読み取れない命令書では、4体とも止まる', () => {
    const root = approved();
    for (const t of ['ai-headquarters:intel', 'ai-headquarters:plans', 'ai-headquarters:inspector', 'ai-headquarters:unit']) {
      assert.equal(launch(root, 'S1', t, '【任務番号】OP-001-1\n【変更してよいファイル】\n- src/a.js').d, 'deny', t);
      assert.equal(launch(root, 'S1', t, '【統制】手順1。単1。持ち時間: しばらく。\n【変更してよいファイル】\n- src/a.js').d, 'deny', t);
    }
  });
  test('手順の番号の無い unit、点検の単位の無い inspector、控えに無い手順の unit は止まる', () => {
    const root = approved();
    assert.match(launch(root, 'S1', 'ai-headquarters:unit', '【統制】持ち時間: 20分。\n【変更してよいファイル】\n- src/a.js').reason, /手順の番号か持ち時間がありません/);
    assert.equal(launch(root, 'S1', 'ai-headquarters:inspector', '【統制】持ち時間: 10分。').d, 'deny');
    assert.match(launch(root, 'S1', 'ai-headquarters:unit', '【統制】手順7。持ち時間: 20分。\n【変更してよいファイル】\n- src/a.js').reason, /手順7 は、承認した計画の控えにありません\(控えの手順: 1、2\)/);
  });
  test('分け直した手順(手順1 の2)と、「なし」の inspector は通る', () => {
    const root = approved();
    assert.equal(launch(root, 'S1', 'ai-headquarters:unit', '【統制】手順1 の2。持ち時間: 5分。\n【変更してよいファイル】\n- src/a.js').d, null);
    assert.equal(launch(root, 'S1', 'ai-headquarters:inspector', '【統制】なし。持ち時間: 10分。').d, null);
  });
  test('「### 時程」の欄だけを書き換えても止まらない。計画を書き換えると止まる', () => {
    const root = approved();
    fs.writeFileSync(opFile(root), fs.readFileSync(opFile(root), 'utf8').replace('余り: 50分', '余り: 20分'));
    assert.equal(launch(root, 'S1').d, null);
    unlock(root);
    setPlan(root, PLAN.replace('src/a.js を直す', 'src/a.js を大きく直す'));
    assert.match(launch(root, 'S1').reason, /承認のあとで書き換えられています/);
  });
  test('目標の決心だけ、承認の無いセッションでは止まる', () => {
    const root = fix();
    say(root, 'S1');
    assert.match(launch(root, 'S1').reason, /目標の決心の記録しかありません/);
    assert.match(launch(root, 'S2').reason, /指揮官の承認がありません/);
  });
});

describe('guard.js: 持ち時間の知らせと点検の数え', () => {
  test('持ち時間を超えた unit の書き込みで、1回目に知らせが出て止まらない。2回目には出ない', () => {
    const root = approved();
    assert.equal(launch(root, 'S1').d, null);
    const id = started(root, 'S1');
    const lp = path.join(root, '.ai-headquarters', 'state', 'unit-lock.json');
    const lock = JSON.parse(fs.readFileSync(lp, 'utf8'));
    fs.writeFileSync(lp, JSON.stringify({ ...lock, started_at: Date.now() - 22 * 60000 }));
    const w = () => hook('guard.js', root, { session_id: 'S1', agent_id: id, agent_type: 'ai-headquarters:unit', hook_event_name: 'PreToolUse', tool_name: 'Edit', permission_mode: 'default', tool_input: { file_path: path.join(root, 'src', 'a.js'), old_string: 'a', new_string: 'b' } });
    const o1 = w();
    assert.equal((o1.hookSpecificOutput || {}).permissionDecision, undefined, '止めない');
    assert.match(o1.hookSpecificOutput.additionalContext, /^持ち時間 20分を超えました\(いま 22分\)。区切りのよい所で止め/);
    assert.deepEqual(w(), {}, '2回目には出ない');
  });
  test('持ち時間 1分の unit は、1分を過ぎたら知らせる(分に切り捨てて比べない。第3段の実地)', () => {
    const root = approved();
    assert.equal(launch(root, 'S1').d, null);
    const id = started(root, 'S1');
    const sp = path.join(root, '.ai-headquarters', 'state', 'unit-scope.json');
    fs.writeFileSync(sp, JSON.stringify({ ...JSON.parse(fs.readFileSync(sp, 'utf8')), minutes: 1 }));
    const lp = path.join(root, '.ai-headquarters', 'state', 'unit-lock.json');
    const lock = JSON.parse(fs.readFileSync(lp, 'utf8'));
    const w = () => hook('guard.js', root, { session_id: 'S1', agent_id: id, agent_type: 'ai-headquarters:unit', hook_event_name: 'PreToolUse', tool_name: 'Edit', permission_mode: 'default', tool_input: { file_path: path.join(root, 'src', 'a.js'), old_string: 'a', new_string: 'b' } });
    fs.writeFileSync(lp, JSON.stringify({ ...lock, started_at: Date.now() - 50000 }));
    assert.deepEqual(w(), {}, '1分の前は出ない');
    fs.writeFileSync(lp, JSON.stringify({ ...lock, started_at: Date.now() - 90000 }));
    assert.match(w().hookSpecificOutput.additionalContext, /^持ち時間 1分を超えました\(いま 1\.5分\)/);
  });
  test('点検の上限に達した単位の inspector で、知らせが出て止まらない。別の単位では出ない', () => {
    const root = approved();
    const end = (u) => hook('clock.js', root, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:inspector', prompt: `【統制】${u}。持ち時間: 10分。` }, tool_response: { totalDurationMs: 60000, content: '【結論】不合格。物1 が満たされていません' } });
    end('単1'); end('単1');
    const r = launch(root, 'S1', 'ai-headquarters:inspector', '【統制】単1。持ち時間: 10分。');
    assert.equal(r.d, null);
    assert.equal(r.msg, 'AI司令部: 単1 の点検は3回目です(上限 2回)。指揮官の決心を受けていなければ、起動せず、残った指摘を示して伺ってください。');
    assert.equal(r.ctx, r.msg);
    assert.equal(launch(root, 'S1', 'ai-headquarters:inspector', '【統制】単2。持ち時間: 10分。').msg, '');
  });
  test('起動の上限は、承認の行の控えから読む', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN }).replace('12回(見込み 6回)', '2回(見込み 2回)'));
    say(root, 'S1');
    started(root, 'S1', 'ai-headquarters:intel'); started(root, 'S1', 'ai-headquarters:plans');
    assert.equal(launch(root, 'S1', 'ai-headquarters:intel', '【統制】持ち時間: 10分。').d, 'ask');
  });
});

describe('guard.js: 承認の引き継ぎ(12.14 の6つの場面)', () => {
  const kinds = (root) => rows(root).map((r) => `${r.kind}:${r.session_id}`);
  test('1 引き継ぎ待ちを書く → offer。2 別のセッションの unit → accept して通る。指揮官の前の「承認」は数え直さない', () => {
    const root = approved();
    mainEdit(root, 'S1', '引き継ぎ待ち: 2026-11-24 10:00。セッションを替えるため');
    assert.deepEqual(kinds(root), ['plan:S1', 'offer:S1']);
    const r = launch(root, 'S2');
    assert.equal(r.d, null);
    assert.match(r.ctx, /承認を引き継ぎました/);
    assert.deepEqual(kinds(root), ['plan:S1', 'offer:S1', 'accept:S2']);
    unlock(root);
    assert.match(launch(root, 'S1').reason, /指揮官の承認がありません/, '承認を持つのは引き継いだセッションだけ');
    unlock(root);
    assert.match(launch(root, 'S3').reason, /指揮官の承認がありません/, 'offer は1回で使い切る');
  });
  test('3 offer を出したセッションが自分で unit を起動すると cancel', () => {
    const root = approved();
    mainEdit(root, 'S1', '引き継ぎ待ち: x');
    assert.equal(launch(root, 'S1').d, null);
    assert.deepEqual(kinds(root), ['plan:S1', 'offer:S1', 'cancel:S1']);
    unlock(root);
    assert.equal(launch(root, 'S2').d, 'deny');
  });
  test('4 引き継いだセッションの「承認」は記録し直し(milestone)', () => {
    const root = approved();
    mainEdit(root, 'S1', '引き継ぎ待ち: x');
    launch(root, 'S2');
    assert.match(say(root, 'S2'), /記録し直しました/);
    assert.equal(rows(root).pop().kind, 'milestone');
  });
  test('4の3 起動の上限の確認(ask)を出したときは、accept を足さない(断られたときに承認が移らない。T16 の点検)', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN }).replace('12回(見込み 6回)', '2回(見込み 2回)'));
    say(root, 'S1');
    mainEdit(root, 'S1', '引き継ぎ待ち: x');
    started(root, 'S1', 'ai-headquarters:intel'); started(root, 'S1', 'ai-headquarters:plans');
    assert.equal(launch(root, 'S2').d, 'ask');
    assert.ok(!kinds(root).includes('accept:S2'), kinds(root).join(','));
  });
  test('4の2 引き継いだあと unit の前に計画を書き換えても、別のセッションの「承認」1回で受け継ぎ、いまの指紋で記録し直す(第3段の実地)', () => {
    const root = approved();
    mainEdit(root, 'S1', '引き継ぎ待ち: x');
    setPlan(root, PLAN.replace('持ち時間: 20分', '持ち時間: 25分'));
    assert.equal(launch(root, 'S2').d, 'deny', '書き換えた計画のままでは、まだ起動できない');
    const c = say(root, 'S2');
    assert.match(c, /承認を、このセッションに引き継ぎました/);
    assert.match(c, /前の承認の指紋\(.+\)と違います/);
    assert.deepEqual(kinds(root).slice(-2), ['accept:S2', 'milestone:S2']);
    unlock(root);
    assert.equal(launch(root, 'S2').d, null, '「承認」1回で起動できる');
  });
  test('5 offer の無いまま別のセッションで「承認」: 申し出があれば計画の決心、無ければ目標の決心', () => {
    const root = approved();
    assert.match(say(root, 'S2'), /目標の決心として/);
    const root2 = approved();
    mainEdit(root2, 'S2', '受け継ぎの申し出: 2026-11-24 11:00。計画と任務の要点を示した');
    assert.match(say(root2, 'S2'), /計画の決心として/);
    unlock(root2);
    assert.equal(launch(root2, 'S2').d, null);
  });
  test('指紋が違うときは、受け継げない(offer も、申し出のあとの「承認」も)', () => {
    const root = approved();
    mainEdit(root, 'S1', '引き継ぎ待ち: x');
    setPlan(root, PLAN.replace('src/b.js', 'src/c.js'));
    assert.equal(launch(root, 'S2').d, 'deny');
    assert.ok(!kinds(root).includes('accept:S2'));
    const root2 = approved();
    setPlan(root2, PLAN.replace('src/b.js', 'src/c.js'));
    mainEdit(root2, 'S2', '受け継ぎの申し出: x');
    assert.match(say(root2, 'S2'), /目標の決心として/);
  });
  test('承認を持たないセッションの「引き継ぎ待ち」では offer を足さない', () => {
    const root = approved();
    mainEdit(root, 'S2', '引き継ぎ待ち: x');
    assert.deepEqual(kinds(root), ['plan:S1']);
  });
});

describe('guard.js: 節目と、危険度が高の関門、節目の下限(第2段。12.10)', () => {
  const ORDER = (n, extra = '') => `【任務番号】OP-001-${n}\n【統制】手順${n}。持ち時間: 10分。${extra}\n【変更してよいファイル】\n- src/a.js`;
  const ended = (root, step) => hook('clock.js', root, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:unit', prompt: `【統制】手順${step}。持ち時間: 10分。` }, tool_response: { totalDurationMs: 60000 } });
  const go = (root, n, extra) => { const r = launch(root, 'S1', 'ai-headquarters:unit', ORDER(n, extra)); if (r.d === null) { started(root, 'S1'); unlock(root); } return r; };
  test('節目の手順は、前の「承認」のあとの unit が0回でないと止まり、「続けて」では止まったまま、「承認」で通る。直しの起動は前の「承認」のまま通る', () => {
    const root = approved({ plan: PLAN.replace('節目: なし', '節目: 手順2 の前') });
    assert.equal(go(root, 1).d, null);
    assert.match(go(root, 2).reason, /手順2 は、計画の節目です/);
    say(root, 'S1', '続けてください');
    assert.equal(go(root, 2).d, 'deny');
    say(root, 'S1');
    assert.equal(go(root, 2).d, null);
    ended(root, 2);
    assert.equal(go(root, 2).d, null, '節目の手順の直し(2回目の起動)は通る');
  });
  test('危険度が高の手順は、2回目の起動も止まる', () => {
    const root = approved({ plan: PLAN.replace('危険度: 低。', '危険度: 高。') });
    assert.equal(go(root, 1).d, null);
    assert.match(go(root, 2).reason, /危険度が高の手順です.*戻し方と確かめ方を示して/);
    say(root, 'S1');
    assert.equal(go(root, 2).d, null);
    ended(root, 2);
    assert.equal(go(root, 2).d, 'deny', '高の手順は、直しの起動も止まる');
  });
  test('最初の手順が節目なら、計画の決心が兼ねる', () => {
    const root = approved({ plan: PLAN.replace('節目: なし', '節目: 手順1 の前') });
    assert.equal(go(root, 1).d, null);
  });
  test('命令書の危険度が控えと違うと止まる。書かないときは止めない', () => {
    const root = approved();
    assert.match(go(root, 1, '危険度: 低').reason, /危険度\(低\)が、承認した計画の手順1 の危険度\(中\)と違います/);
    assert.equal(go(root, 1, '危険度: 中').d, null);
    assert.equal(go(root, 1).d, null);
  });
  test('節目のある計画では、控えた下限(節目の下限: unit 2回)で次の unit が止まる', () => {
    const root = approved({ plan: PLAN.replace('節目: なし', '節目: 手順2 の前\n節目の下限: unit 2回') });
    assert.equal(go(root, 1).d, null);
    assert.equal(go(root, 1).d, null);
    assert.match(go(root, 1).reason, /節目の下限は unit 2回です/);
  });
  test('比べる作戦の節のある作戦記録と、unit の手順が5つの計画では、既定の3回で止まる', () => {
    const r1 = approved({ extra: '## 状況の特質\nx\n' });
    for (let i = 0; i < 3; i++) assert.equal(go(r1, 1).d, null);
    assert.match(go(r1, 1).reason, /節目の下限は unit 3回です/);
    const five = PLAN.replace('手順2 担当: unit。危険度: 低。持ち時間: 10分。src/b.js を直す', [2, 3, 4, 5].map((k) => `手順${k} 担当: unit。危険度: 低。持ち時間: 5分。x`).join('\n'));
    const r2 = approved({ plan: five });
    for (let i = 0; i < 3; i++) assert.equal(go(r2, 1).d, null);
    assert.equal(go(r2, 1).d, 'deny');
  });
  test('節目が無く、比べておらず、unit の手順が4つ以下の計画では、下限が働かない', () => {
    const root = approved();
    for (let i = 0; i < 5; i++) assert.equal(go(root, 1).d, null);
  });
});

describe('時計: バックグラウンドで起動した4体(実地で見つけた直し)', () => {
  test('起動の PostToolUse では起動だけを記録して知らせず、報告の知らせ(task-id)で終わりを記録して知らせる', () => {
    const root = fix(OP({ goals: '省略: x', plan: PLAN }));
    say(root, 'S1');
    const c1 = ctx(hook('clock.js', root, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:inspector', run_in_background: true, prompt: '【任務番号】OP-001-3\n【統制】単1。持ち時間: 10分。' }, tool_response: { status: 'async_launched', agentId: 'aX1' } }));
    assert.equal(c1, '');
    const c2 = ctx(hook('clock.js', root, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>aX1</task-id>\n<status>completed</status>\n<result>【任務番号】OP-001-3\n【結論】\n不合格\n物1 が満たされていません</result>\n</task-notification>' }));
    assert.match(c2, /OP-001-3 inspector は 0分\(持ち時間 10分\)。/);
    const end = rows(root, 'clock.jsonl').find((r) => r.ev === 'agent_end');
    assert.equal(end.unit, '単1'); assert.equal(end.verdict, 'fail'); assert.equal(end.agent_id, 'aX1');
    assert.equal(ctx(hook('clock.js', root, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>aX1</task-id>' })), '', '同じ知らせは2回数えない');
    assert.equal(ctx(hook('clock.js', root, { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>bash1</task-id>' })), '', '4体でない仕事の知らせは記録だけ');
  });
});

describe('承認の引き継ぎ: 引き継ぎ待ちのまま、新しいセッションで先に「承認」が来たとき(実地で見つけた隙間)', () => {
  test('受け継いでから、記録し直し(milestone)として記録する。指紋が違っても受け継ぎ、いまの指紋で記録する(第3段で改めた)', () => {
    const root = approved();
    mainEdit(root, 'S1', '引き継ぎ待ち: x');
    assert.match(say(root, 'S2'), /^引き継ぎ待ちの OP-001 の承認を、このセッションに引き継ぎました。指揮官の承認を、OP-001 に記録し直しました/);
    assert.deepEqual(rows(root).map((r) => `${r.kind}:${r.session_id}`), ['plan:S1', 'offer:S1', 'accept:S2', 'milestone:S2']);
    assert.equal(launch(root, 'S2').d, null);
    const root2 = approved();
    mainEdit(root2, 'S1', '引き継ぎ待ち: x');
    setPlan(root2, PLAN.replace('src/b.js', 'src/c.js'));
    assert.match(say(root2, 'S2'), /記録し直しました/);
    assert.equal(rows(root2).pop().kind, 'milestone');
    const root3 = approved();
    assert.match(say(root3, 'S2'), /目標の決心として/, 'offer が無ければ、目標の決心に倒す(止める側)');
  });
});

describe('計画の読み取り: 見出し【手順】の無い計画(実地で見つけた直し)', () => {
  test('計画の節の全体から、手順と点検の単位の行を拾う', () => {
    const plan = PLAN.replace('【手順】\n', '').replace('【点検と節目】\n', '');
    const root = fix(OP({ goals: '省略: x', plan }));
    assert.match(say(root, 'S1'), /計画の決心として/);
    assert.deepEqual(rows(root)[0].copy.steps.map((s) => s.step), ['1', '2']);
    assert.deepEqual(rows(root)[0].copy.units.map((u) => u.unit), ['単1']);
  });
  test('手順の行が1つも無いときの案内は、行の初めの形を示す', () => {
    const root = fix(OP({ goals: '省略: x', plan: '1. unit が直す(15分)' }));
    assert.match(say(root, 'S1'), /行の初めが「手順」と番号の行が1つもありません/);
  });
});

describe('開始の案内: 同じセッションには出さない(実地で見つけた直し)', () => {
  const start = (root, s) => ctx(hook('session-start.js', root, { session_id: s, hook_event_name: 'SessionStart', source: 'resume' }));
  test('計画の決心の前は、どのセッションにも出さない', () => {
    const root = fix();
    say(root, 'S1');
    assert.doesNotMatch(start(root, 'S2'), /OP-001 は/);
  });
  test('この作戦で時計に記録のあるセッション(--continue で続けた会話)には出さない', () => {
    const root = approved();
    hook('clock.js', root, { session_id: 'S9', hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    assert.doesNotMatch(start(root, 'S9'), /OP-001 は/);
    assert.match(start(root, 'S2'), /OP-001 は続いています/);
  });
});

describe('書き込みのあとの確かめ(approval.js post。第2段)', () => {
  const post = (root, s, oldS, newS) => ctx(hook('approval.js', root, { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: opFile(root), old_string: oldS, new_string: newS } }, ['post']));
  test('計画を書いたとき、読めない行を知らせる(止めない)。承認した計画のままなら知らせない', () => {
    const root = fix(OP({ goals: '承認: x' }));
    const bad = PLAN.replace('危険度: 低。', '');
    setPlan(root, bad);
    const c = post(root, 'S1', '未作成', bad);
    assert.match(c, /^AI司令部\(計画の確かめ。止めません\): 計画に、持ち時間か危険度を読み取れない行があります/);
    assert.ok(c.includes('- 手順2 担当: unit。持ち時間: 10分。src/b.js を直す'));
    setPlan(root);
    assert.equal(post(root, 'S1', bad, PLAN), '', '読める計画で、上限も時程に合えば知らせない');
  });
  test('失2 の直し: 時程に合わない点検の上限を知らせる(余り 50分 ÷ 単位1 ÷ 直し 25分 → 1 + 2 = 3回まで。余り 10分なら1回)', () => {
    const root = fix(OP({ goals: '承認: x' }).replace('余り: 50分', '余り: 10分'));
    setPlan(root);
    const c = post(root, 'S1', '未作成', PLAN);
    assert.match(c, /時程に合わせると、点検の上限は 1回です\(1 に、余り 10分 ÷ 点検の単位 1つ ÷ 直しと再点検1回 25分 の切り捨て/);
    assert.match(c, /いまの「点検の上限: 2回」を 1回に改めるか/);
  });
  test('点検の単位が多く、余りが単位の持ち時間の合計より短いときは、まとめることを促す', () => {
    const root = fix(OP({ goals: '承認: x' }).replace('余り: 50分', '余り: 5分'));
    const two = PLAN.replace('単1 手順1〜2 のあと。持ち時間: 10分。', '単1 手順1 のあと。持ち時間: 10分。\n単2 手順2 のあと。持ち時間: 10分。');
    setPlan(root, two);
    assert.match(post(root, 'S1', '未作成', two), /点検の単位を減らすことを考えてください/);
  });
  test('引き継ぎ待ちは、新しく足された行だけを数える(前からある行を含めた書き換えでは足さない)', () => {
    const root = approved();
    mainEdit(root, 'S1', '引き継ぎ待ち: x');
    const n = rows(root).length;
    post(root, 'S1', '引き継ぎ待ち: x', '引き継ぎ待ち: x\n(追記)');
    assert.equal(rows(root).length, n);
  });
  test('サブエージェントの書き込みと、作戦記録でないファイルでは何もしない。壊れた入力でも止めない', () => {
    const root = approved();
    assert.equal(ctx(hook('approval.js', root, { session_id: 'S1', agent_id: 'a1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: opFile(root), old_string: 'なし', new_string: '引き継ぎ待ち: x' } }, ['post'])), '');
    assert.equal(ctx(hook('approval.js', root, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'README.md'), old_string: 'a', new_string: 'b' } }, ['post'])), '');
    const r = spawnSync(process.execPath, [H('approval.js'), 'post'], { input: '{壊れ', encoding: 'utf8', env: env(root) });
    assert.equal(r.status, 0);
  });
  test('hooks.json の PostToolUse に、Edit、Write、MultiEdit の確かめが登録されている', () => {
    const h = JSON.parse(fs.readFileSync(H('hooks.json'), 'utf8')).hooks;
    assert.ok(h.PostToolUse.some((g) => g.matcher === 'Edit|Write|MultiEdit' && g.hooks.some((x) => x.args.join(' ').endsWith('/hooks/approval.js post'))));
  });
});

describe('振り返り(第3段。10.6)', () => {
  const REVIEW = '\n## 振り返り\n期限との差、任務ごとの持ち時間と実測(1行ずつ)\n次の見積もり: unit 1回 6分、inspector 1回 4分、計画 25分\n';
  const TPLREVIEW = '\n## 振り返り\n期限との差(写す)\n次の見積もり: 次の作戦の時程に引く数字(例:「unit 1回 6分」)\n';
  const op2 = (root) => path.join(root, '.ai-headquarters', 'operations', 'OP-002.md');
  const write2 = (root, s = 'S2') => {
    const body = OP().replace('# OP-001', '# OP-002') + TPLREVIEW;
    fs.writeFileSync(op2(root), body);
    return ctx(hook('approval.js', root, { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: op2(root), content: body } }, ['post']));
  };
  test('新しい作戦記録を作ると、直近の作戦の「次の見積もり」を知らせる(止めない)', () => {
    const root = fix(OP({ result: '完了。物1 合格' }) + REVIEW);
    const c = write2(root);
    assert.match(c, /振り返りのある直近の作戦 OP-001 の「次の見積もり」は「unit 1回 6分、inspector 1回 4分、計画 25分」です/);
    assert.match(c, /時程の見積もりに、この数字を使ってください/);
  });
  test('前の作戦の振り返りが雛形のまま、または無いときは知らせない。Edit でも知らせない', () => {
    const root = fix(OP({ result: '完了' }) + TPLREVIEW);
    assert.equal(write2(root), '');
    const root2 = fix(OP({ result: '完了' }));
    assert.equal(write2(root2), '');
    const root3 = fix(OP({ result: '完了' }) + REVIEW);
    write2(root3);
    const e = ctx(hook('approval.js', root3, { session_id: 'S2', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: op2(root3), old_string: 'x', new_string: 'y' } }, ['post']));
    assert.doesNotMatch(e, /直近の作戦/);
  });
  test('「## 結果」を書き換えたのに、振り返りの「次の見積もり」が雛形のままなら知らせる', () => {
    const root = fix(OP() + TPLREVIEW);
    const done = (oldS, newS) => {
      fs.writeFileSync(opFile(root), fs.readFileSync(opFile(root), 'utf8').replace(oldS, newS));
      return ctx(hook('approval.js', root, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: opFile(root), old_string: oldS, new_string: newS } }, ['post']));
    };
    assert.match(done('## 結果\n未完了', '## 結果\n完了。物1 合格'), /「次の見積もり」が、まだ書かれていません/);
    const root2 = fix(OP() + REVIEW);
    fs.writeFileSync(opFile(root2), fs.readFileSync(opFile(root2), 'utf8').replace('## 結果\n未完了', '## 結果\n完了'));
    assert.equal(ctx(hook('approval.js', root2, { session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: opFile(root2), old_string: '## 結果\n未完了', new_string: '## 結果\n完了' } }, ['post'])), '', '埋まっていれば知らせない');
  });
});
