'use strict';
// skills/mission-order/SKILL.md の型と記入例が、requirements.md および guard.js と合っているかの自動テスト。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

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

describe('8つの型が requirements.md と同じ見出し・同じ順(0.2.0。0.4.1 で処置事項の一覧を足して8つ)', { skip: SKIP_REQ }, () => {
  const reqBlocks = HAS_REQ ? codeBlocks(section(REQ, '## 10. 型').split('## 11. ')[0]) : [];
  const skillBlocks = codeBlocks(SKILL.split('## 記入例')[0]);
  const names = ['命令書', '完了条件の分け方', '報告', '計画書', '状況の特質', '行動方針案', '行動方針の分析', '処置事項の一覧'];
  test('型のコードブロックは8つ', () => {
    assert.equal(reqBlocks.length, 8);
    assert.equal(skillBlocks.length, 8);
  });
  test('処置事項の一覧の型は、要件と一字も違わない(見出しの【】が無い型のため、本文で比べる)', () => {
    assert.equal(skillBlocks[7], reqBlocks[7]);
  });
  names.forEach((n, i) => {
    test(`${n}`, () => {
      assert.deepEqual(headings(skillBlocks[i]), headings(reqBlocks[i]));
    });
  });
  test('見出し数(命令書9(0.5.0 で【統制】)・完了条件1・報告9(0.5.0 で【引き継ぎ】)・計画書4(0.5.0 で4つの見出し)・状況の特質5・行動方針案3・行動方針の分析2)', () => {
    assert.deepEqual(skillBlocks.map((b) => headings(b).length), [9, 1, 9, 4, 5, 3, 2, 0]);
    assert.ok(!SKILL.includes('使う資源'));
  });
  test('報告の【引き継ぎ】は【未解決・懸念】のすぐあと、【物差しの外の指摘】は【引き継ぎ】と【推測】の間(0.5.0)', () => {
    const h = headings(skillBlocks[2]);
    assert.equal(h.indexOf('引き継ぎ'), h.indexOf('未解決・懸念') + 1);
    assert.equal(h.indexOf('物差しの外の指摘'), h.indexOf('引き継ぎ') + 1);
    assert.equal(h.indexOf('推測'), h.indexOf('物差しの外の指摘') + 1);
  });
  test('報告の【目標の達成】は【実施内容】と【未解決・懸念】の間', () => {
    const h = headings(skillBlocks[2]);
    assert.equal(h.indexOf('目標の達成'), h.indexOf('実施内容') + 1);
    assert.equal(h.indexOf('未解決・懸念'), h.indexOf('目標の達成') + 1);
  });
  test('完了条件の分け方:必成、時期的順位、望成(優先と損耗限度)の書き方があり、本文の行は【】で始まらない', () => {
    const b = skillBlocks[1];
    assert.match(b, /^必成: 物\d+ /m);
    assert.match(b, /^望成1\(優先1、損耗限度: 試行\d+回\): /m);
    assert.doesNotMatch(SKILL, /試行\d+回、\d+分|M分/);
    assert.equal(b.split('\n').filter((l) => l.startsWith('【')).length, 1);
    assert.match(SKILL, /達成する順に「必成1:」「必成2:」/);
    assert.match(SKILL, /必成を終えてから望成に着手し、損耗限度に達したら繰り返さずに止め/);
  });
  test('状況の特質:敵の可能行動は5つまで、最も起こりやすいものと最も痛いもの', () => {
    assert.match(skillBlocks[4], /5つまで/);
    assert.match(skillBlocks[4], /最も起こりやすいもの/);
    assert.match(skillBlocks[4], /起きたら最も痛いもの/);
  });
  test('行動方針案:2〜3案、評価の材料になる事実、1案だけの理由', () => {
    assert.match(skillBlocks[5], /2〜3案/);
    assert.match(skillBlocks[5], /評価の材料になる事実/);
    assert.match(skillBlocks[5], /^【1案だけの理由】/m);
  });
  test('行動方針の分析:表の3列と致命的な弱点', () => {
    assert.match(skillBlocks[6], /「我の行動」「敵の可能行動が起こす問題」「こちらの対処」/);
    assert.match(skillBlocks[6], /^【致命的な弱点】/m);
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
    w('.ai-headquarters/state/approval.json', { session_id: 'S1', operation: 'OP-003', plan: '2026-11-22T00:00:00Z', fingerprint: FP.fingerprintOf('x') });
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
  test('記入例の命令書の【完了条件】は、必成と望成に分けてある(0.2.0)', () => {
    const c = example.split(/^【完了条件】/m)[1].split(/^【/m)[0];
    assert.match(c, /^必成: /m);
    assert.match(c, /^望成1\(優先1、損耗限度: /m);
  });
  test('型のブロックをそのまま写した命令書は、範囲が読み取れず、unit の起動そのものが止まる(2026-11-22)', () => {
    const root = makeRoot();
    assert.equal(run(root, { tool_name: 'Agent', tool_input: { subagent_type: 'ai-headquarters:unit', prompt: skillBlocks[0], description: 'd' } }), 'deny');
    assert.equal(fs.existsSync(path.join(root, '.ai-headquarters/state/unit-lock.json')), false, '予約が残っていない');
    assert.equal(fs.existsSync(path.join(root, '.ai-headquarters/state/unit-scope.json')), false, '範囲を記録していない');
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
  const [, unitReport] = codeBlocks(section(SKILL, '## 記入例'));
  // plans の報告の記入例は、0.4.0 で agents/plans.md に移した(削11。要るのは plans だけのため)
  const PLANS = fs.readFileSync(path.join(ROOT, 'agents', 'plans.md'), 'utf8').replace(/\r\n/g, '\n');
  const plansReport = codeBlocks(section(PLANS, '## 記入例(報告)'))[0];
  // 必須の見出しは、requirements.md の「必須の見出しは…の6つ」の行から取り出す(0.5.0 で【引き継ぎ】を足した)
  const reqLine = HAS_REQ ? REQ.split('\n').find((l) => l.includes('必須の見出しは')) : '';
  const required = [...reqLine.slice(0, reqLine.indexOf('の6つ')).matchAll(/【([^】]+)】/g)].map((m) => m[1]);
  const coaHeads = headings(codeBlocks(SKILL.split('## 記入例')[0])[5]);
  test('必須の見出しは、requirements.md から6つ取り出せる', () => {
    assert.equal(required.length, 6);
    assert.deepEqual(required, ['任務番号', '結論', '根拠', '未解決・懸念', '引き継ぎ', '推測']);
  });
  test('mission-order の記入例はちょうど2つ(命令書・報告(unit))。plans の報告の記入例は agents/plans.md にある', () => {
    assert.equal(codeBlocks(section(SKILL, '## 記入例')).length, 2);
    assert.ok(unitReport && plansReport);
    assert.match(SKILL, /記入例は plans の本文にあります/);
  });
  test('unit の報告: 必須の6つが行の先頭にあり、【実施内容】と【目標の達成】もある', () => {
    for (const h of [...required, '実施内容', '目標の達成']) assert.match(unitReport, new RegExp(`^【${h}】`, 'm'), h);
    const g = unitReport.split(/^【目標の達成】/m)[1].split(/^【/m)[0];
    assert.match(g, /必成: 達成/);
    assert.match(g, /望成1: /);
  });
  test('plans の報告: 必須の6つが行の先頭にある(【実施内容】は不要)', () => {
    for (const h of required) assert.match(plansReport, new RegExp(`^【${h}】`, 'm'), h);
    assert.doesNotMatch(plansReport, /^【実施内容】/m);
  });
  test('plans の報告: 行動方針案の3つの見出しが行の先頭にあり、【結論】の1行目は要約(0.2.0)', () => {
    for (const h of coaHeads) assert.match(plansReport, new RegExp(`^【${h}】`, 'm'), h);
    assert.match(plansReport, /^【結論】\S+/m);
    assert.match(plansReport, /^案1/m);
    assert.match(plansReport, /^案2/m);
  });
  test('plans の報告: 行動方針案の見出しは【結論】と【根拠】の間にある', () => {
    const order = headings(plansReport);
    assert.deepEqual(order.slice(0, 2 + coaHeads.length + 1), ['任務番号', '結論', ...coaHeads, '根拠']);
  });
  test('記入例の任務番号は、plans が OP-003-1、unit の命令書と報告が OP-003-2', () => {
    const ex = codeBlocks(section(SKILL, '## 記入例'));
    assert.deepEqual(ex.map((b) => /^【任務番号】(\S+)/m.exec(b)[1]), ['OP-003-2', 'OP-003-2']);
    assert.match(plansReport, /^【任務番号】OP-003-1$/m);
  });
  test('plans の報告: 【行動方針】の中で【】を使わない', () => {
    const body = plansReport.split(/^【行動方針】/m)[1].split(/^【1案だけの理由】/m)[0];
    assert.doesNotMatch(body, /【/);
  });
});

describe('報告の決まり:指揮官の指定でないものを指定として書かない(2026-11-21)', () => {
  test('報告の決まりにある', () => {
    const rules = section(SKILL, '### 報告の決まり').split(/^## /m)[0];
    assert.match(rules, /指揮官の指定でないものを、指定として書きません/);
  });
  test('要件の目標の扱いの決まりにもある(0.5.0 で 7.1 に移った)', { skip: SKIP_REQ }, () => {
    const req = section(REQ, '### 7.1 目標の扱い').split('### 7.2 ')[0];
    assert.match(req, /指揮官の指定でないものを、指定として書かない/);
  });
});

describe('権限や Hooks で止められた望成目標(2026-11-21)', () => {
  const duty = section(SKILL, '## 全員の義務').slice('## 全員の義務'.length).split(/^## /m)[0];
  test('全員の義務: 望成目標の作業なら、試行1回と数え、限度に達したら捨てる', () => {
    assert.match(duty, /望成目標のための操作が止められたときは、あわせて試行1回と数え、損耗限度に達したら「捨てた」と【目標の達成】に書き、何の権限があれば達成できたかを添えます/);
  });
  test('止められた試行を数えることは、全員の義務に1か所だけ書く(第3段で重なりを削った)', () => {
    const rules = section(SKILL, '### 完了条件の分け方').split(/^## /m)[0];
    assert.doesNotMatch(rules, /権限や Hooks で止められた試行も、1回と数えます/);
  });
  test('要件にもある', { skip: SKIP_REQ }, () => {
    assert.match(REQ, /望成目標のための試行が、権限や Hooks で止められたときも、損耗限度の試行1回と数える/);
    assert.match(REQ, /最終報告に「何の権限があれば達成できたか」を書く/);
    assert.match(REQ, /任務分析の報告の「企図の読み」の中に、その文を一字も変えずに引く/);
    assert.ok(!REQ.includes('報告の画面にも「あなたが書いた目標(原文)」'));
  });
});

describe('無効な命令書の下での試行(2026-11-22)', () => {
  test('完了条件の分け方: 命令書の書き誤りで unit の起動が止められたときは、試行に数えない(起動の時点で止めるため、無効な命令書の下での試行は無い)', () => {
    const rules = section(SKILL, '### 完了条件の分け方').split(/^## /m)[0];
    assert.match(rules, /命令書の書き誤りで unit の起動が止められたときは、試行に数えません/);
    assert.doesNotMatch(rules, /読み取れなかった命令書の下での試行/);
  });
  test('要件にもある', { skip: SKIP_REQ }, () => {
    assert.match(REQ, /命令書の書き誤りで unit の起動が止められたときは、試行に数えない/);
    assert.doesNotMatch(REQ, /無効な命令書\)の下で行った試行/);
    assert.match(REQ, /その文を一字も変えずに引く/);
    assert.match(REQ, /サブエージェントへの命令書を書く前に、Skill ツールで mission-order を読み込む/);
  });
});

describe('【変更してよいファイル】が読み取れないと、unit の起動が止まる(2026-11-22)', () => {
  test('書き方の決まりに、起動を止めることを書く', () => {
    assert.match(SKILL, /欄が無い、または読み取れないと、Hooks が unit の起動を止めます/);
    assert.doesNotMatch(SKILL, /Hooks が unit のすべての書き込みを止めます/);
  });
});

describe('処置事項の一覧と、期限と見積もり(0.4.1)', () => {
  const blocks = codeBlocks(SKILL.split('## 記入例')[0]);
  const list = blocks[7] || '';
  const sec = section(SKILL, '## 処置事項の一覧').split('## 書き方の決まり')[0];
  test('型: 件数と、番号と直し方だけを書く案内。1件は1行で、内容と理由', () => {
    assert.match(list, /^処置事項\(幕僚が決めたこと。\d+件。直したいものは、番号と直し方だけを書いてください\)$/m);
    for (const l of list.trim().split('\n').slice(1)) assert.match(l, /^処\d+ .+。理由: .+/, l);
  });
  test('型は「大規模の計画で使う型」のあと、「書き方の決まり」の前', () => {
    assert.ok(SKILL.indexOf('## 大規模の計画で使う型') < SKILL.indexOf('## 処置事項の一覧'));
    assert.ok(SKILL.indexOf('## 処置事項の一覧') < SKILL.indexOf('## 書き方の決まり'));
  });
  test('決まり: 置き場所、並べ方、番号、作戦記録、入力、直し、中規模、一覧だけを別に示さない', () => {
    assert.match(sec, /指揮官への報告の「決めていただくこと」のすぐあとに置きます。処置事項が無ければ書きません/);
    assert.match(sec, /指揮官が直しそうなもの\(迷って決めたものを含む\)を上に並べます/);
    assert.match(sec, /番号は、作戦を通した連番\(処1、処2\)です/);
    assert.match(sec, /同じ行を、作戦記録の「## 処置事項」に1行に1件で書き、指揮官の答え\(承認の日時、または直し\)をあとから足します/);
    assert.match(sec, /その報告への「承認」で済みます\(決心や節目の承認と兼ねます\)/);
    assert.match(sec, /挙げなかった番号は、承認として扱います/);
    assert.match(sec, /その報告が計画の決心か節目を兼ねていたときだけ、反映のあとに「承認」を1回求めます。目標の決心では、改めて「承認」を求めません/);
    assert.match(sec, /中規模の最終報告の一覧には、「承認」を求めません。目標に「承認を受ける」とあるときだけ求め/);
    assert.match(sec, /「必成目標: 一覧への承認を受ければ達成」/);
    assert.match(sec, /一覧だけを、報告と別に示して「承認」を求めることはしません/);
  });
  test('報告の【実施内容】に「決めた点」。unit は重い手順の1回の時間を【根拠】に書く', () => {
    assert.match(blocks[2], /^【実施内容】変更したファイル一覧\(部隊のみ\)。命令書が決めていない細部を自分で決めたときは、「決めた点」として内容と理由も書く$/m);
    assert.match(SKILL, /unit は、重い手順では、1回にかかった時間を【根拠】に書きます/);
  });
  test('計画書の【手順】に重い手順。行動方針案の評価の材料に重い手順。状況の特質の【時間】は数字か測り方', () => {
    assert.match(blocks[3], /^【手順】.*重い手順は、回数、1回の時間、合計\(実測か実測前か\)$/m);
    assert.match(blocks[5], /評価の材料になる事実\(起動するサブエージェントの回数とモデル、重い手順の回数と時間、指揮官に求める手作業、依存するもの\)/);
    assert.match(blocks[4], /^【時間】期限\(決心を受けたもの\)と、重い手順の回数と時間、使用量の見込み\(起動の回数とモデル\)。数字か、測り方を書く$/m);
  });
});
