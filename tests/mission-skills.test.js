'use strict';
// skills/mission と skills/mission-analysis の形が、要件どおりかを確かめる自動テスト。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const MISSION = read('skills', 'mission', 'SKILL.md');
// 段階の1行目と、その下の箇条(字下げした「- 」の行)をまとめて返す
const stepOf = (head) => {
  const ls = MISSION.split('\n');
  const i = ls.findIndex((l) => l.startsWith(head));
  if (i < 0) return '';
  const out = [ls[i]];
  for (let k = i + 1; k < ls.length && /^\s+- /.test(ls[k]); k++) out.push(ls[k]);
  return out.join('\n');
};
const ANALYSIS = read('skills', 'mission-analysis', 'SKILL.md');
// 目標の扱い、大規模の計画の手続き、作戦記録の雛形は、SKILL.md の中の節(別ファイルに分けると、プラグインのフォルダの Read に許可が要るため。2026-11-22)
const level2 = (text, title) => {
  const i = text.indexOf(title);
  if (i < 0) return '';
  const rest = text.slice(i + title.length);
  const j = rest.search(/^## /m);
  return j < 0 ? rest : rest.slice(0, j);
};
const GOALS = level2(ANALYSIS, '## 目標の扱い');
const LARGE = level2(ANALYSIS, '## 大規模の計画の手続き');
const TPL = (/### 作戦記録の雛形\n\n```markdown\n([\s\S]*?)```/.exec(ANALYSIS) || [])[1] || '';
// 行数の目安。公式の文書の「SKILL.md の本文は500行未満」の範囲で、戻したあとの行数(約270行)と目標の決心の段階の分を見て決めた(2026-11-22)
const ANALYSIS_MAX_LINES = 350;

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
    assert.ok(ANALYSIS.split('\n').length <= ANALYSIS_MAX_LINES);
  });
});

describe('mission の中身', () => {
  const has = (re, label) => assert.match(MISSION, re, label);
  test('10段階の番号と名前', () => {
    // 0.2.0 で、5段目が「我の行動方針の分析」に変わり、2026-11-22 に「目標の決心」が加わり「承認」が「計画の決心」になった(requirements.md の作戦の流れ)
    const names = ['企図の受領', '任務分析', '目標の決心', '情報収集', '計画立案', '我の行動方針の分析', '計画の決心', '実行', '監察', '報告'];
    names.forEach((n, i) => has(new RegExp('^' + (i + 1) + '\\. ' + n, 'm'), n));
    assert.doesNotMatch(MISSION, /^11\. /m);
    has(/次の10段階で進めます/, '10段階');
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
    has(/^7\. 計画の決心\(中規模以上\)/m, '段階7は中規模以上');
    has(/^3\. 目標の決心\(中規模以上\)/m, '段階3は中規模以上');
    has(/小規模は作戦記録が無いので、報告だけです/, '段階10は小規模と矛盾しない');
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
  const m = (TPL ? [TPL, TPL] : null);
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

// ---------------------------------------------------------------- 0.2.0
const sectionOf = (text, title) => {
  const i = text.indexOf(title);
  assert.ok(i >= 0, title);
  const rest = text.slice(i + title.length);
  const j = rest.search(/^#{2,3} /m);
  return j < 0 ? rest : rest.slice(0, j);
};
describe('目標の扱い(中規模以上。0.2.0)', () => {
  const g = GOALS;
  test('任務分析の成果物に、特質、必成目標、望成目標、評価基準(大規模)が加わる', () => {
    const out = sectionOf(ANALYSIS, '## 任務分析の成果物');
    for (const w of ['任務の特質と状況の特質', '必成目標', '望成目標', '評価基準']) assert.ok(out.includes(w), w);
    assert.match(out, /小規模では/);
  });
  test('必成目標は原則一つ、複数なら時期的順位', () => {
    assert.match(g, /原則として一つ/);
    assert.match(g, /時期的順位/);
  });
  test('望成目標には優先順位と損耗限度(起動の回数と分)', () => {
    assert.match(g, /優先順位と損耗限度/);
    assert.match(g, /サブエージェントの回数/);
    assert.match(g, /不合格でのやり直しを含む/);
    assert.match(g, /着手した時刻を作戦記録に書いて、そこから数え/);
  });
  test('望成目標を捨てる判断は承認なし。取り消しにあたらない。報告する', () => {
    assert.match(g, /その望成目標を捨てて必成目標を守ります/);
    assert.match(g, /指揮官の承認は要りません/);
    assert.match(g, /決定の取り消し.*にはあたりません/);
    assert.match(g, /中間報告(\(大規模\))?と最終報告/);
    assert.match(g, /速報事項として/);
  });
  test('監察の合否:命令書の必成、制約、既存の動作。望成の未達成は報告事項', () => {
    assert.match(g, /命令書の【完了条件】の必成、【制約】を守ったこと、既存の動作を壊していないこと/);
    assert.match(g, /不合格ではなく報告事項/);
  });
  test('小規模では目標を分けない', () => assert.match(g, /小規模では、目標を分けません/));
});
describe('大規模の計画の手続き(0.2.0)', () => {
  const p = LARGE;
  test('段階の順:状況の特質→行動方針→分析→第1部→第4部→比較と結論→計画書→承認', () => {
    const order = ['状況の特質', '行動方針を2〜3案', '我の行動方針の分析', '第1部(要員と指揮官の手間)', '第4部(作戦を支える資源)', '比較と結論', '計画書の型にまとめ', '計画の決心を1回'];
    const pos = order.map((w) => p.indexOf(w));
    assert.ok(pos.every((i) => i >= 0), `欠け: ${order.filter((_, k) => pos[k] < 0)}`);
    assert.deepEqual([...pos].sort((a, b) => a - b), pos);
  });
  test('上限:3案、5つ、同時3体。幕僚の起動は各1回', () => {
    assert.match(p, /3案まで/);
    assert.match(p, /5つまで/);
    assert.match(p, /同時に動かすサブエージェントは3体まで/);
    assert.match(p, /intel\(状況の特質\)、plans、inspector を1回ずつ/);
  });
  test('評価基準は任務分析で先に決め、比較のときに作らない', () => {
    assert.match(p, /任務分析で示した評価基準/);
    assert.match(p, /評価基準を後から作りません/);
  });
  test('第1部と第4部は案を作らず、メインセッションが評価する', () => assert.match(p, /第1部と第4部は自分で案を作らず/));
  test('分析後の変更は「こちらの対処」の取り込みに限り、ほかは別に書く', () => {
    assert.match(p, /「こちらの対処」を取り込むことに限り/);
    assert.match(p, /分析後の変更/);
  });
  test('1案だけのときと、全案に致命的な弱点があるとき', () => {
    assert.match(p, /1案しか成り立たないとき/);
    assert.match(p, /すべての案に致命的な弱点があるとき/);
    assert.match(p, /plans を再び起動するかは指揮官が決めます/);
  });
  test('intel の状況の特質は model に sonnet を指定する', () => assert.match(p, /model に sonnet を指定/));
  test('中規模は行動方針を作らない', () => assert.match(p, /中規模では、行動方針を作りません/));
});
describe('mission の9段階(0.2.0)', () => {
  test('任務分析で必成と望成、大規模で評価基準', () => {
    assert.match(MISSION, /必成目標と望成目標/);
    assert.match(MISSION, /評価基準/);
  });
  test('大規模の計画は mission-analysis の「大規模の計画の手続き」に従う', () => assert.match(MISSION, /「大規模の計画の手続き」に従います/));
  test('監察の合否と、報告の達成状況', () => {
    assert.match(MISSION, /望成目標の未達成だけでは不合格にしません/);
    assert.match(MISSION, /必成目標と望成目標それぞれの達成状況/);
  });
  test('小規模の流れは変わらない(目標を分けない)', () => {
    assert.match(MISSION, /小規模の流れ: 企図の受領、任務分析のあと、メインセッションが自分で実装して報告します/);
  });
});
describe('作戦記録の雛形(0.2.0の欄)', () => {
  const m = (TPL ? [TPL, TPL] : null);
  test('目標と行動方針の欄がある', () => {
    for (const h of ['目標', '必成目標', '望成目標', '捨てた望成目標', '状況の特質', '行動方針の比較と結論']) {
      assert.match(m[1], new RegExp(`^#{2,3} ${h}$`, 'm'), h);
    }
    assert.match(m[1], /評価基準/);
    assert.match(m[1], /第1部/);
    assert.match(m[1], /第4部/);
  });
});

describe('実地の作戦で見つかった穴(0.2.0)', () => {
  test('指揮官が企図で示した区分(必成、望成、損耗限度)は言い換えない', () => {
    assert.match(GOALS, /指揮官が企図で示した区分と損耗限度は、言い換えずにそのまま使います/);
    assert.match(GOALS, /指揮官が望成目標としたものを、必成目標に入れません/);
  });
  test('点検と承認は規律で、望成目標にしない。中規模以上では点検を必ず行う', () => {
    assert.match(GOALS, /inspector による点検と承認は規律なので、望成目標にしません/);
    assert.match(ANALYSIS, /中規模以上では、inspector の点検を必ず行います/);
  });
});

describe('区分の扱い A〜C(2026-11-21 指揮官の決定)', () => {
  const tpl = (TPL ? [TPL, TPL] : null)[1];
  test('A: 規律と指揮官の指定が食い違うときは、規律に合わせて区分を改め、改めたことと理由を伝えて承認を得る', () => {
    assert.match(GOALS, /規律(\(監察の合否の基準など\))?と指揮官の指定が食い違うときは、規律に合わせて区分を改め、改めたことと理由を任務分析の報告で伝え、目標の決心を得ます/);
  });
  test('B: 企図に目標が書かれていたときだけ、報告に「あなたが書いた目標(原文)」と「あなたが書いた目標から改めた点」を出す(0.2.1)', () => {
    const out = sectionOf(ANALYSIS, '## 任務分析の成果物');
    assert.match(out, /「あなたが書いた目標\(原文\)」/);
    assert.match(out, /「あなたが書いた目標から改めた点」/);
    assert.match(out, /無ければ「なし」/);
  });
  test('B: 作戦記録の雛形にも同じ2つの欄がある', () => {
    assert.match(tpl, /^### 指揮官の指定$/m);
    assert.match(tpl, /^### 区分を改めた点$/m);
    assert.ok(tpl.indexOf('### 指揮官の指定') < tpl.indexOf('### 必成目標'), '指揮官の指定は目標より前');
  });
  test('C: 指揮官が示していない望成目標に、指揮官の損耗限度を付け替えない', () => {
    assert.match(GOALS, /指揮官が示していない望成目標に、指揮官が示した損耗限度を付け替えません/);
  });
  test('指揮官の指定でないものを、指定として書かない(メインセッションの報告)', () => {
    assert.match(GOALS, /指揮官の指定でないものを、指定として書きません/);
  });
  test('長さの目安(150行)は守る', () => assert.ok(ANALYSIS.split('\n').length <= ANALYSIS_MAX_LINES));
});

describe('権限や Hooks で止められた望成目標(2026-11-21 指揮官の決定)', () => {
  const g = GOALS;
  const tpl = (TPL ? [TPL, TPL] : null)[1];
  test('望成目標の試行が権限や Hooks で止められたら、損耗限度の試行1回と数える', () => {
    assert.match(g, /望成目標のための試行が、権限や Hooks で止められたときも、損耗限度の試行1回と数えます/);
  });
  test('損耗限度に達したら、未解決にせず捨てる。別の手段は試さない', () => {
    assert.match(g, /損耗限度に達したら、「未解決」にせず捨てます/);
    assert.match(g, /別の手段は試しません/);
  });
  test('必成目標は、今までどおり未解決として判断を仰ぐ', () => {
    assert.match(g, /必成目標は、止められたら、これまでどおり「未解決」として指揮官の判断を仰ぎます/);
  });
  test('最終報告に「何の権限があれば達成できたか」を書く', () => {
    assert.match(g, /最終報告に「何の権限があれば達成できたか」を書きます/);
  });
  test('流れの要点8(未解決の扱い)に、望成目標の例外を書く', () => {
    const flow = sectionOf(ANALYSIS, '## 流れの要点');
    assert.match(flow, /望成目標が止められたときは、下の「目標の扱い」の決まりに従います/);
  });
  test('作戦記録の雛形の「捨てた望成目標」に、達成に要る権限を書く', () => {
    const t = tpl.slice(tpl.indexOf('### 捨てた望成目標'));
    assert.match(t.split('\n')[1], /何の権限があれば達成できたか/);
  });
  test('B の直し漏れ: 企図に目標が書かれていたときは、報告の画面にも原文を出す(作戦記録だけでは足りない)', () => {
    const out = sectionOf(ANALYSIS, '## 任務分析の成果物');
    assert.match(out, /指揮官に見せる任務分析の報告そのものに/);
    assert.match(out, /作戦記録に書くだけでは足りません/);
  });
  test('mission の段階2にも、報告の画面に出すことを書く', () => {
    const step2 = stepOf('2. 任務分析');
    assert.match(step2, /指揮官に見せる報告そのものに/);
    assert.match(step2, /作戦記録に書くだけでは足りません/);
  });
  test('mission の段階9に、捨てた望成目標と達成に要る権限を書く', () => {
    const step9 = stepOf('10. 報告');
    assert.match(step9, /何の権限があれば達成できたか/);
  });
  test('長さの目安(150行)は守る', () => assert.ok(ANALYSIS.split('\n').length <= ANALYSIS_MAX_LINES));
});

describe('命令書を書く前に型を読む・無効な命令書の試行・指揮官の指定の写し方(2026-11-22)', () => {
  const g = GOALS;
  const out = sectionOf(ANALYSIS, '## 任務分析の成果物');
  const tpl = (TPL ? [TPL, TPL] : null)[1];
  test('サブエージェントへの命令書を書く前に、Skill ツールで mission-order を読み込む', () => {
    const head = ANALYSIS.slice(0, ANALYSIS.indexOf('## 任務分析の成果物'));
    assert.match(head, /サブエージェントへの命令書を書く前に、Skill ツールで mission-order を読み込みます/);
    assert.match(head, /ai-headquarters:mission-order/);
    assert.match(head, /承認のあとに新しく始まった処理/);
    assert.match(head, /型に無い見出しを足しません/);
  });
  test('unit の起動が命令書の書き誤りで止められたときは、試行に数えない(起動の時点で止めるので、無効な命令書の下での試行は無い)', () => {
    assert.match(g, /unit の起動が、命令書の書き誤りで Hooks に止められたときは、試行に数えません/);
    assert.doesNotMatch(g, /無効な命令書/);
  });
  test('あなたが書いた目標(原文)は、文末も含めて一字も変えずに写す。要約や言い直しをしない', () => {
    assert.match(out, /「あなたが書いた目標\(原文\)」には、企図の中の目標、区分、損耗限度を述べた文を、文末も含めて一字も変えずに写します/);
    assert.match(out, /要約や言い直しをしません/);
  });
  test('作戦記録の雛形の「指揮官の指定」も、一字も変えずに写す', () => {
    const t = tpl.slice(tpl.indexOf('### 指揮官の指定'));
    assert.match(t.split('\n')[1], /文末も含めて一字も変えずに写す/);
  });
  test('mission の段階2も、文末も含めて一字も変えずに写す', () => {
    const step2 = stepOf('2. 任務分析');
    assert.match(step2, /文末も含めて一字も変えずに/);
  });
  test('長さの目安(150行)は守る', () => assert.ok(ANALYSIS.split('\n').length <= ANALYSIS_MAX_LINES));
});

describe('スキルとエージェントの行の長さと行数(2026-11-22)', () => {
  // 0.1.1 の最長の行は198字。1行に1つの決まりを書く形の上限として200字にする
  const MAX_CHARS = 200;
  const MAX_LINES = ANALYSIS_MAX_LINES;
  const mdFiles = [];
  for (const s of fs.readdirSync(path.join(ROOT, 'skills'))) {
    for (const f of fs.readdirSync(path.join(ROOT, 'skills', s))) if (f.endsWith('.md')) mdFiles.push(['skills', s, f]);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) if (f.endsWith('.md')) mdFiles.push(['agents', f]);
  for (const parts of mdFiles) {
    const rel = parts.join('/');
    const lines = read(...parts).split('\n');
    test(`${rel}: 1行は${MAX_CHARS}字まで`, () => {
      const long = lines.map((l, i) => [i + 1, [...l].length]).filter(([, n]) => n > MAX_CHARS);
      assert.deepEqual(long, [], `長い行(行番号, 字数): ${JSON.stringify(long)}`);
    });
    // 行数の目安(150行)は、もともと mission-analysis にだけ設けていたもの。分けたファイルにも同じ目安をかける
    if (parts[1] === 'mission-analysis') test(`${rel}: ${MAX_LINES}行まで`, () => assert.ok(lines.length <= MAX_LINES, String(lines.length)));
  }
});

describe('監察の合否と、テストの実行の区別(2026-11-22)', () => {
  test('規律は既存の動作を壊していないこと。確かめ方は inspector が決めて報告する', () => {
    assert.match(GOALS, /監察の合否は、命令書の【完了条件】の必成、【制約】を守ったこと、既存の動作を壊していないことで決めます。/);
    assert.match(GOALS, /既存の動作を壊していないことをどう確かめるか\(テストを実行する、コードを読むなど\)は、inspector が決めて、報告に書きます/);
    assert.match(GOALS, /テストを実行すること自体は、規律ではありません/);
  });
  test('指揮官が「テストを実行すること」を望成目標にしたときは、区分を改めない', () => {
    assert.match(GOALS, /指揮官が「テストを実行すること」を望成目標にしたときは、規律と食い違わないので、区分を改めずにそのまま扱います/);
  });
  test('mission の段階8も同じ書き方', () => {
    const step8 = stepOf('9. 監察');
    assert.match(step8, /既存の動作を壊していないこと/);
    assert.match(MISSION, /確かめ方は inspector が決め/);
  });
  test('テストの実行を規律に含めるように読める書き方が残っていない', () => {
    for (const [name, text] of [['SKILL', ANALYSIS], ['goals', GOALS], ['large', LARGE], ['mission', MISSION]]) {
      assert.doesNotMatch(text, /既存のテストが通ることなど/, name);
    }
  });
});

describe('mission-analysis は分けずに1つの SKILL.md にする(2026-11-22 指揮官の決定。案2)', () => {
  test('スキルのフォルダには SKILL.md だけがある', () => {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'skills', 'mission-analysis')), ['SKILL.md']);
  });
  test('目標の扱い、大規模の計画の手続き、作戦記録の雛形が SKILL.md の中にある', () => {
    assert.match(ANALYSIS, /^## 目標の扱い\(中規模以上\)$/m);
    assert.match(ANALYSIS, /^## 大規模の計画の手続き$/m);
    assert.ok(TPL.length > 0, '雛形');
  });
  test('別ファイルを Read で読み込む決まりを残さない', () => {
    for (const [name, t] of [['mission-analysis', ANALYSIS], ['mission', MISSION]]) {
      for (const f of ['goals.md', 'large-plan.md', 'operations-log.md を Read']) assert.ok(!t.includes(f), `${name}: ${f}`);
    }
  });
  test('行数の目安は350行(公式の文書の500行未満の範囲)', () => assert.ok(ANALYSIS.split('\n').length <= ANALYSIS_MAX_LINES));
});

describe('目標の決心(2026-11-22)', () => {
  const D = level2(ANALYSIS, '## 目標の決心');
  test('mission-analysis に「目標の決心」の節がある', () => assert.ok(D.length > 0));
  test('任務分析のあと、目標の決心を求めて止まる。決心の前は計画のサブエージェントを起動しない', () => {
    assert.match(D, /任務分析のあと、目標の決心を求めて止まります/);
    assert.match(D, /目標の決心を受けるまで、計画のためのサブエージェントを起動しません/);
  });
  test('決心は「承認」か、直す点や案を書くかで表す。選択肢の画面は使わない', () => {
    assert.match(D, /「承認」とだけ入力するか、直す点や自分の案を書くかで決心します/);
    assert.match(D, /直す点や案が書かれたら、それを決心として扱い、反映した内容を示してから次に進みます/);
    assert.match(D, /選択肢の画面は使いません/);
  });
  test('直す点が規律と食い違うときは、改めて目標の決心を求める', () => {
    assert.match(D, /規律に合わせて改め、改めた点と理由を示して、改めて目標の決心を求めます/);
  });
  test('計画の決心を直す点で表したときは、反映した計画を示し、改めて「承認」を求める', () => {
    assert.match(D, /反映した計画を示し、改めて「承認」とだけ入力してもらいます/);
  });
  test('省いてよい場合(すべて指揮官の指定にあるとき)と、省いたことの報告', () => {
    assert.match(D, /すべての望成目標の優先順位と損耗限度/);
    assert.match(D, /メインセッションが足した目標が無い/);
    assert.match(D, /省いたことと理由を、任務分析の報告と作戦記録に書きます/);
    assert.match(D, /大規模の評価基準を指揮官が示していないときは、省けません/);
  });
  test('大規模では評価基準も目標の決心で決める。「承認は待たずに示す」はやめる', () => {
    assert.match(D, /大規模では、行動方針を比べる評価基準も、目標の決心で決めてもらいます/);
    assert.doesNotMatch(ANALYSIS, /承認は待たずに示します/);
  });
  test('目標の決心だけでは unit を起動できない(Hooks)', () => assert.match(D, /目標の決心だけでは unit を起動できません/));
  test('承認の回数', () => {
    assert.match(D, /中規模は目標と計画の2回\(省いたときは1回\)/);
    assert.match(D, /大規模は目標、計画、中間報告のあとの節目ごと/);
  });
  test('損耗限度は、目標の決心で与えた裁量', () => assert.match(GOALS, /損耗限度は、指揮官が目標の決心で前もって与えた裁量/));
  test('作戦記録の欄の書き方(4つの書き出し)', () => {
    for (const w of ['「未決心」', '「承認: 」', '「修正: 」', '「省略: 」']) assert.ok(D.includes(w), w);
  });
  test('雛形の承認の欄を、目標の決心と計画の決心に分ける', () => {
    assert.match(TPL, /^## 承認\n### 目標の決心\n未決心/m);
    assert.match(TPL, /^### 計画の決心$/m);
  });
  test('大規模の手続き:計画の決心を1回で受ける(目標の決心はその前)', () => {
    assert.match(LARGE, /計画の決心を1回で受けます/);
    assert.doesNotMatch(LARGE, /承認を1回で受けます/);
  });
  test('mission の段階3と7', () => {
    assert.match(stepOf('3. 目標の決心'), /目標の決心を求めて止まります/);
    assert.match(stepOf('7. 計画の決心'), /大規模では、推奨案と比較の結果を、計画とあわせて示します/);
  });
  test('行数の目安(350行)と1行200字', () => {
    assert.ok(ANALYSIS.split('\n').length <= ANALYSIS_MAX_LINES);
  });
});

describe('任務分析の報告の見せ方(0.2.1。2026-11-22 指揮官の決定)', () => {
  const out = sectionOf(ANALYSIS, '## 任務分析の成果物');
  const tpl = (TPL ? [TPL, TPL] : null)[1];
  const D = level2(ANALYSIS, '## 目標の決心');
  test('ふつうの場合(目標を書かずに依頼):報告に2つの欄を出さない', () => {
    assert.match(out, /目標を書かずに依頼されたとき\(ふつうの場合\)は、報告にこの2つの欄を出しません/);
    assert.doesNotMatch(out, /欄を必ず設けます/);
  });
  test('目標の一つ一つに根拠を短く添える(依頼の言葉を引くか、推測と理由)', () => {
    assert.match(out, /必成目標と望成目標の一つ一つに、根拠を短く添えます/);
    assert.match(out, /「依頼の『〇〇』から」と、依頼の言葉を引いて書きます/);
    assert.match(out, /「推測」と書き、その理由を一言添えます/);
  });
  test('例外の場合の条件と、2つの欄の見出し', () => {
    assert.match(out, /企図の中に、目標の区分\(必成目標、望成目標\)、優先順位、損耗限度、時期的順位のどれかを述べた文があるとき/);
    assert.match(out, /「あなたが書いた目標から改めた点」: 改めた点と理由を書きます。無ければ「なし」と書きます/);
  });
  test('2つの欄は冒頭ではなく、必成目標と望成目標の案のすぐあとに置く', () => {
    assert.match(out, /報告の冒頭ではなく、必成目標と望成目標の案のすぐあとに、この順で置きます/);
  });
  test('報告に「指揮官の指定」「区分を改めた点」の見出しを出す決まりは残さない', () => {
    assert.doesNotMatch(out, /「指揮官の指定」「区分を改めた点」の順で、見出しを付けて書きます/);
    assert.doesNotMatch(MISSION, /「指揮官の指定」と「区分を改めた点」\(理由つき。無ければ「なし」\)を、この順で見出しを付けて必ず書きます/);
  });
  test('作戦記録の2つの欄は残し、目標が書かれていないときは「なし」と書く', () => {
    assert.match(out, /作戦記録の「### 指揮官の指定」と「### 区分を改めた点」の欄は、どちらの場合も書きます\(目標が書かれていないときは「なし」\)/);
    assert.match(tpl, /^### 指揮官の指定$/m);
    assert.match(tpl, /^### 区分を改めた点$/m);
  });
  test('雛形:2つの欄に、報告での見出しを添える。必成目標と望成目標に根拠を書く', () => {
    const line = (h) => tpl.slice(tpl.indexOf(h)).split('\n')[1];
    assert.match(line('### 指揮官の指定'), /報告では「あなたが書いた目標\(原文\)」として示す/);
    assert.match(line('### 区分を改めた点'), /報告では「あなたが書いた目標から改めた点」として示す/);
    assert.match(line('### 必成目標'), /根拠/);
    assert.match(line('### 望成目標'), /根拠/);
  });
  test('目標の決心で示すもの:根拠と、例外の場合の2つ', () => {
    assert.match(D, /必成目標と望成目標\(優先順位、損耗限度、時期的順位、根拠を含む\)/);
    assert.match(D, /企図に目標が書かれていたときは、「あなたが書いた目標\(原文\)」と「あなたが書いた目標から改めた点」も示します/);
  });
  test('省いてよい条件は変えない(作戦記録の欄で判断する)', () => {
    assert.match(D, /条件の1つ目は、作戦記録の「区分を改めた点」が「なし」で、メインセッションが足した目標が無いことです/);
    assert.match(D, /どれも作戦記録の「指揮官の指定」の欄にあることです/);
  });
  test('規律は緩めない(言い換えない、損耗限度を付け替えない)', () => {
    assert.match(GOALS, /指揮官が企図で示した区分と損耗限度は、言い換えずにそのまま使います/);
    assert.match(GOALS, /指揮官が示していない望成目標に、指揮官が示した損耗限度を付け替えません/);
  });
  test('mission の段階2と3も同じ形', () => {
    const s2 = stepOf('2. 任務分析');
    assert.match(s2, /目標の一つ一つに、根拠/);
    assert.match(s2, /目標を書かずに依頼されたときは、この2つを出しません/);
    assert.match(s2, /目標の案のすぐあとに「あなたが書いた目標\(原文\)」と「あなたが書いた目標から改めた点」/);
    const s3 = stepOf('3. 目標の決心');
    assert.doesNotMatch(s3, /区分を改めた点とその理由、大規模/);
  });
  test('行の長さと行数の目安', () => {
    for (const l of ANALYSIS.split('\n')) assert.ok(l.length <= 200, l.slice(0, 40));
    assert.ok(ANALYSIS.split('\n').length <= ANALYSIS_MAX_LINES);
  });
  test('版は 0.2.1', () => assert.equal(JSON.parse(read('.claude-plugin', 'plugin.json')).version, '0.2.1'));
});

describe('任務分析の報告の並び(0.2.1。中規模の実地で、2つの欄が目標の前に出たことへの直し)', () => {
  const out = sectionOf(ANALYSIS, '## 任務分析の成果物');
  test('報告の並びを、目標の案 → あなたが書いた目標(原文) → あなたが書いた目標から改めた点 の順で示す', () => {
    assert.match(out, /報告の並び: 言い直し、規模、推測した点、速報事項、必成目標と望成目標の案、「あなたが書いた目標\(原文\)」、「あなたが書いた目標から改めた点」、決心の求め/);
    assert.match(out, /目標の案より前に置きません/);
  });
  test('例外の場合も、目標の一つ一つに根拠を添える', () => {
    assert.match(out, /例外の場合も、目標の一つ一つに根拠を添えます/);
  });
  test('ふつうの場合は、2つの欄を出さなかったことにも触れない', () => {
    assert.match(out, /出さなかったことにも触れません/);
  });
  test('mission の段階2も、目標の案より前に置かない', () => {
    assert.match(stepOf('2. 任務分析'), /目標の案より前に置きません/);
  });
});
