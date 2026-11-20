'use strict';
// skills/mission と skills/mission-analysis の形が、要件どおりかを確かめる自動テスト。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const MISSION = read('skills', 'mission', 'SKILL.md');
const ANALYSIS = read('skills', 'mission-analysis', 'SKILL.md');

const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter がありません');
  return m[1];
};
const field = (fm, key) => {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(fm);
  return m ? m[1] : null;
};
const AGENTS = fs.readdirSync(path.join(ROOT, 'agents'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => field(frontmatter(read('agents', f)), 'name'))
  .sort();

describe('frontmatter', () => {
  test('mission は disable-model-invocation: true、mission-analysis には無い', () => {
    assert.match(frontmatter(MISSION), /^disable-model-invocation: true$/m);
    assert.doesNotMatch(frontmatter(ANALYSIS), /disable-model-invocation/);
  });
  test('name と description があり、description に ASCII の ": " が無い', () => {
    for (const [text, name] of [[MISSION, 'mission'], [ANALYSIS, 'mission-analysis']]) {
      const fm = frontmatter(text);
      assert.equal(field(fm, 'name'), name);
      const d = field(fm, 'description');
      assert.ok(d && d.length > 10, `${name}: description`);
      assert.ok(!d.includes(': '), `${name}: description に ": " がある`);
    }
  });
});

describe('mission-analysis の決まり', () => {
  const has = (re, label) => assert.match(ANALYSIS, re, label);
  test('規模の3段階と判定基準の3つ', () => {
    for (const w of ['小', '中', '大']) has(new RegExp('^\\| ' + w + ' \\|', 'm'), `規模 ${w}`);
    for (const w of ['変更ファイル数', '調査の要否', '取り消しの難しさ']) has(new RegExp(w), w);
    has(/迷ったら、大きい側/, '迷ったら大きい側');
    has(/指揮官が規模を指定/, '指揮官の上書き');
  });
  test('承認の取り方', () => {
    has(/「承認」とだけ入力/, '「承認」とだけ');
    has(/選択肢の画面は使いません/, '選択肢の画面');
    has(/承認を求める前に作/, '承認前に作戦記録');
    has(/`\.ai-headquarters\/` 以外のファイルを変更しません/, '承認前は変更しない');
  });
  test('作戦記録の置き場所と番号の振り方', () => {
    has(/\.ai-headquarters\/operations\/OP-NNN\.md/, '置き場所');
    has(/既存の最大の番号に1を足し、3桁/, '番号');
  });
  test('Edit で更新', () => {
    has(/Write で作ったあとは、Edit で更新/, 'Edit で更新');
  });
  test('4体だけ', () => {
    has(/本製品の4体\(intel、plans、unit、inspector\)だけ/, '4体の名前を並べた文');
    has(/Explore、general-purpose、Plan/, '組み込みを使わない');
  });
  test('同時3体と unit 1体', () => {
    has(/3体まで/, '同時3体');
    has(/unit は.*同時に1体/, 'unit 同時1体');
  });
  test('モデルの割り当て', () => {
    has(/intel は haiku/, 'intel haiku');
    has(/model に sonnet/, '重い調査は sonnet');
  });
  test('次の任務案、中間報告、監察、未解決', () => {
    has(/次の任務案/, '次の任務案');
    has(/1、2件の任務ごとに中間報告/, '中間報告');
    has(/作った本人以外/, '監察');
    has(/作戦記録が保存されるまで完了としません/, '保存まで完了としない');
    has(/「未解決」があれば、勝手に補わず、指揮官に上げ/, '未解決は指揮官へ');
  });
  test('規模の表の承認の欄と、小規模の「サブエージェントは使わない」', () => {
    const row = (w) => ANALYSIS.split('\n').find((l) => l.startsWith('| ' + w + ' |'));
    assert.match(row('小'), /サブエージェントは使わない/);
    assert.match(row('小'), /\| 不要 \|$/);
    assert.match(row('中'), /\| 計画を1回 \|$/);
    assert.match(row('大'), /\| 計画と節目ごと \|$/);
  });
  test('大規模の節目の承認、承認が無効になる条件、実装は並列にしない', () => {
    has(/中間報告のあと、次の unit を起動する前に、指揮官に「承認」とだけ入力/, '節目の承認');
    has(/同じ作戦記録のまま承認し直せば足ります/, '承認し直し');
    has(/最新の作戦記録に結び付きます/, '最新の作戦記録');
    has(/新しい作戦記録を作ったとき、\/clear したとき、別のセッションに移ったとき/, '無効になる条件');
    has(/実装は並列にしません\(unit は常に1体。Hooks が2体目を止めます\)/, '並列にしない');
  });
  test('Hooks に止められたときは、メインセッションと unit・inspector で書き分ける', () => {
    has(/メインセッションは、Hooks の理由文が示す正規の手順/, 'メインセッション向け');
    has(/シェルなど別の手段で同じ操作を試すことはしません/, '別の手段を試さない');
    has(/unit と inspector は、止められたら別の手段を試さず、未解決として報告/, 'unit と inspector');
  });
  test('description は表の境目と合っている', () => {
    const d = field(frontmatter(ANALYSIS), 'description');
    assert.match(d, /3ファイル以上の変更、または調査が要る依頼/);
    assert.match(d, /1〜2ファイルの小さな修正では使わない/);
  });
  test('長さの目安は150行以内', () => {
    assert.ok(ANALYSIS.split('\n').length <= 150);
  });
});

describe('mission の中身', () => {
  const has = (re, label) => assert.match(MISSION, re, label);
  test('9段階の番号と名前', () => {
    const names = ['企図の受領', '任務分析', '情報収集', '計画立案', '反対検討', '承認', '実行', '監察', '報告'];
    names.forEach((n, i) => has(new RegExp('^' + (i + 1) + '\\. ' + n, 'm'), n));
    assert.doesNotMatch(MISSION, /^10\. /m);
  });
  test('$ARGUMENTS の扱い', () => {
    has(/\$ARGUMENTS/, '$ARGUMENTS');
    has(/最初の語が「小」「中」「大」のどれかのときだけ、規模の指定とみなします/, '最初の語');
    has(/残りは企図として扱います/, '残りは企図');
  });
  test('核の文', () => {
    has(/幕僚役\(intel、plans、inspector\)は書き込みません/, '幕僚役は書き込まない');
    has(/点検は、作った本人以外が行います/, '点検は作った本人以外');
    has(/小規模では、サブエージェントを使わず、メインセッションが単独で片付けます/, '小規模は単独');
    has(/本製品の4体\(intel、plans、unit、inspector\)だけ/, '4体だけ');
  });
  test('承認の取り方と完了の条件', () => {
    has(/「承認」とだけ入力するよう指揮官に頼みます。選択肢の画面は使いません/, '選択肢の画面は使わない');
    has(/作戦記録が保存されるまで完了としません/, '保存まで完了としない');
  });
  test('小規模の流れの行', () => {
    has(/小規模の流れ: 企図の受領、任務分析のあと、メインセッションが自分で実装して報告します。情報収集、反対検討、承認、監察、作戦記録は無しです/, '小規模の流れ');
    has(/^6\. 承認\(中規模以上\)/m, '段階6は中規模以上');
    has(/小規模は作戦記録が無いので、報告だけです/, '段階9は小規模と矛盾しない');
  });
  test('節目の承認と、実装は並列にしないこと', () => {
    has(/中間報告のあと、次の unit を起動する前に、指揮官に「承認」とだけ入力してもらいます/, '節目の承認');
    has(/同じ作戦記録のまま承認し直せば足ります/, '承認し直し');
    has(/実装は並列にしません/, '並列にしない');
  });
  test('Skill ツールで mission-analysis と mission-order を読み込む', () => {
    has(/Skill ツールでスキル mission-analysis と mission-order を読み込みます/, 'Skill ツール');
    has(/ai-headquarters:/, 'プラグイン版の名前');
  });
});

describe('エージェント名', () => {
  test('agents/ に4体ある', () => {
    assert.deepEqual(AGENTS, ['inspector', 'intel', 'plans', 'unit']);
  });
  test('両方のスキルが4体の名前をすべて含む', () => {
    for (const text of [MISSION, ANALYSIS]) {
      for (const a of AGENTS) assert.match(text, new RegExp('\\b' + a + '\\b'), a);
    }
  });
  test('「4体」と並べた名前の列が agents/ と一致する', () => {
    for (const text of [MISSION, ANALYSIS]) {
      const lists = [...text.matchAll(/4体[（(]([a-z、]+)[）)]/g)].map((m) => m[1].split('、').sort());
      assert.ok(lists.length >= 1);
      for (const l of lists) assert.deepEqual(l, AGENTS);
    }
  });
  test('編成の表に出る名前は agents/ のものだけ', () => {
    const rows = ANALYSIS.split('\n').filter((l) => /^\| (小|中|大) \|/.test(l));
    assert.equal(rows.length, 3);
    for (const r of rows) {
      for (const w of r.match(/\b[a-z]{3,}\b/g) || []) assert.ok(AGENTS.includes(w), w);
    }
  });
});

describe('作戦記録の雛形', () => {
  const m = /### 作戦記録の雛形\n\n```markdown\n([\s\S]*?)```/.exec(ANALYSIS);
  test('雛形がある', () => assert.ok(m));
  test('欄の見出しがそろっている', () => {
    const t = m[1];
    for (const h of ['作戦番号', '開始日', '企図', '任務分析', '言い直し', '推測した点', '速報事項',
      '規模と編成', '計画', '承認', '任務', '途中修正', '結果', '未解決', '次の任務案']) {
      assert.match(t, new RegExp(`^#{2,3} ${h}$`, 'm'), h);
    }
    for (const k of ['担当', '命令の要旨', '結果', '人の介入']) assert.match(t, new RegExp(`^- ${k}:`, 'm'), k);
    assert.match(t, /^### OP-NNN-1$/m);
  });
});
