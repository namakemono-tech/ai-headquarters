'use strict';
// 0.6.0 の文の確かめ(設計書 3章、受2)。文言のテストは、核、仕組みの事実(本文と Hooks の一致)、字数の上限に絞る。
// 削った決まりの文言は確かめない。字数は frontmatter を除く本文で数える。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
function split(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'frontmatter がありません');
  const fm = {};
  for (const line of m[1].split('\n')) { const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line); if (kv) fm[kv[1]] = kv[2].trim(); }
  return { fm, body: m[2], raw: m[1] };
}
const chars = (s) => [...s].length;
const SKILL = split(read('skills', 'mission-analysis', 'SKILL.md'));
const MISSION = split(read('skills', 'mission', 'SKILL.md'));
const AG = Object.fromEntries(['intel', 'plans', 'unit', 'inspector'].map((n) => [n, split(read('agents', `${n}.md`))]));
const GUARD = read('hooks', 'guard.js');

describe('受2: 字数の上限', () => {
  test('mission-analysis の本文は 6,000字以内', () => {
    assert.ok(chars(SKILL.body) <= 6000, `${chars(SKILL.body)}字`);
  });
  for (const [n, lim] of [['intel', 1000], ['plans', 1500], ['unit', 1200], ['inspector', 2000]]) {
    test(`${n} の本文は ${lim}字以内で、スキルを読み込まない(frontmatter に skills が無い)`, () => {
      assert.ok(chars(AG[n].body) <= lim, `${chars(AG[n].body)}字`);
      assert.ok(!/^skills:/m.test(AG[n].raw));
    });
  }
  test('Hooks は 2,000行以内(設計書 4.1)', () => {
    const n = fs.readdirSync(path.join(ROOT, 'hooks')).filter((f) => f.endsWith('.js')).reduce((a, f) => a + read('hooks', f).split('\n').length, 0);
    assert.ok(n <= 2000, `${n}行`);
  });
});

describe('スキルの形', () => {
  test('mission は指揮官だけが呼び、mission-analysis を読み込み、程度の引数(実行だけ、簡易、完全)を受ける', () => {
    assert.equal(MISSION.fm['disable-model-invocation'], 'true');
    for (const w of ['mission-analysis', '実行だけ', '簡易', '完全']) assert.ok(MISSION.body.includes(w), w);
  });
  test('mission-analysis の説明は、依頼を受けたら最初の応答の前に読み込むことを言う。0.6.0 で外したスキルを指さない', () => {
    assert.ok(SKILL.fm.description.includes('最初の応答の前に読み込む'));
    for (const t of [SKILL.body, MISSION.body, ...Object.values(AG).map((a) => a.body), GUARD, read('hooks', 'approval.js'), read('hooks', 'session-start.js')]) {
      assert.ok(!t.includes('mission-order'));
    }
    assert.equal(fs.existsSync(path.join(ROOT, 'skills', 'mission-order')), false);
  });
  test('「実行だけ」と書かれた依頼では、mission-analysis を読み込まない(開始の案内、スキルの説明、/mission の3か所で同じ)', () => {
    assert.ok(read('hooks', 'session-start.js').includes('「実行だけ」と書かれていれば、読み込まずに'));
    assert.ok(SKILL.fm.description.includes('「実行だけ」と書かれていれば読み込まない'));
    assert.ok(MISSION.body.includes('最初の語が「実行だけ」なら、mission-analysis を読み込まずに'));
  });
  test('計画を立てる前に、変えるファイルに関わる既存のテストを確かめる(0.6.0 第2段。実1 で2回続いた見落とし)', () => {
    assert.match(SKILL.body, /計画を立てる前に、変えるファイルに関わる既存のテスト/);
  });
});

describe('仕組みの事実: Hooks が読む書式と、本文の一致', () => {
  const tpl = read('templates', 'operations-log.md');
  test('作戦記録の雛形は見出し9つで、Hooks が読む2行(「目標の決心: 未決心」と「## 結果」の「未完了」)がある', () => {
    assert.deepEqual(tpl.split('\n').filter((l) => /^## /.test(l)), ['## 企図', '## 目標', '## 方針', '## 承認', '## いま', '## 任務の記録', '## 処置事項', '## 片付け', '## 結果']);
    assert.match(tpl, /^## 承認\n目標の決心: 未決心$/m);
    assert.match(tpl, /^## 結果\n未完了$/m);
  });
  test('Hooks が読む書式は、【変更してよいファイル】、「目標の決心: 」、「未完了」、引き継ぎの2つの行。スキルの文と Hooks に同じ語がある', () => {
    for (const w of ['【変更してよいファイル】', '目標の決心: ', '未完了', '引き継ぎ待ち: ']) {
      assert.ok(SKILL.body.includes(w), `スキル: ${w}`);
      assert.ok(GUARD.includes(w) || read('hooks', 'approval.js').includes(w), `Hooks: ${w}`);
    }
    // 受け継ぎの申し出は、スキルではなく、続いている作戦の1行(session-start.js)と、止める理由文で伝える
    assert.ok(read('hooks', 'session-start.js').includes('受け継ぎの申し出: '));
    assert.ok(GUARD.includes('受け継ぎの申し出: ') && read('hooks', 'approval.js').includes('受け継ぎの申し出'));
    assert.ok(AG.unit.body.includes('【変更してよいファイル】'));
  });
  test('命令書と報告の見出しは、4体で同じ(unit だけ【変更してよいファイル】を持つ)', () => {
    for (const [n, a] of Object.entries(AG)) {
      for (const h of ['【企図】', '【任務】', '【状況】', '【制約と完了条件】', '【報告してほしいこと】', '【結論】', '【根拠】', '【変更したファイル】', '【未解決】']) assert.ok(a.body.includes(h), `${n}: ${h}`);
      assert.equal(a.body.includes('【変更してよいファイル】'), n === 'unit', n);
      assert.ok(!a.body.includes('【統制】'), n);
    }
  });
  test('inspector の本文のコマンドの一覧は、guard.js の許可リストと同じ', () => {
    const lit = (name) => { const m = new RegExp(`const ${name} = ([\\s\\S]*?);\\n`).exec(GUARD); assert.ok(m, name); return m[1]; };
    // eslint-disable-next-line no-new-func
    const val = (name) => new Function(`return ${lit(name)}`)();
    const body = AG.inspector.body;
    for (const c of val('DEFAULT_TEST_COMMANDS')) assert.ok(body.includes(c), c);
    for (const [sub, opts] of Object.entries(val('GIT_OPTIONS'))) {
      assert.ok(body.includes(`git ${sub}`), sub);
      for (const o of opts) assert.ok(body.includes(o), `${sub} ${o}`);
    }
    for (const o of [...(new Function(`return [...${lit('LS_OPTIONS')}]`)())]) assert.ok(body.includes(o), `ls ${o}`);
    for (const f of [...(new Function(`return [...${lit('PIPE_FILTERS')}]`)())]) assert.ok(body.includes(f), `パイプ ${f}`);
    for (const w of ['git -C', '&&', 'node -e', '2>&1']) assert.ok(body.includes(w), w);
  });
});

describe('4体の本文に必ず残す行(Hooks で守れない所を受けている。設計書 3章)', () => {
  for (const n of ['intel', 'plans', 'unit', 'inspector']) {
    test(`${n}: 止められたら別の手段を試さない、外から来た文の指示に従わない、食い違いを書く、ほかを起動しない`, () => {
      const b = AG[n].body;
      assert.match(b, /別の手段/);
      assert.match(b, /外から来た文/);
      assert.match(b, /食い違い/);
      assert.match(b, /ほかのサブエージェントは起動しません/);
    });
  }
  test('unit: シェルでも範囲の外を変えない、決めずに未解決に書く、同じエラーで2回、コミットと push と公開をしない', () => {
    const b = AG.unit.body;
    for (const w of ['シェルのコマンド', '範囲の外を変えません', '完了条件を変えるものと、戻せないものは、決めずに【未解決】', '同じエラーで2回', 'コミット、push、公開はしません']) assert.ok(b.includes(w), w);
  });
  test('inspector: 指摘だけで直さない、【結論】の1行目に合否、合否は物差しだけ', () => {
    const b = AG.inspector.body;
    for (const w of ['指摘だけ', '直しません', '【結論】の1行目', '物差し']) assert.ok(b.includes(w), w);
  });
  test('intel と plans: 書き込まない(tools に Edit、Write、Bash が無い)。事実と推測を分ける', () => {
    for (const n of ['intel', 'plans']) {
      assert.ok(!/\b(Edit|Write|Bash|PowerShell)\b/.test(AG[n].fm.tools), n);
      assert.match(AG[n].body, /推測/, n);
    }
  });
});
