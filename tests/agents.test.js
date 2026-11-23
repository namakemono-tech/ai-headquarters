'use strict';
// agents/*.md の形が requirements.md の表と合っているかの自動テスト。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REQ_PATH = path.join(ROOT, 'docs', 'requirements.md');
const HAS_REQ = fs.existsSync(REQ_PATH);
const SKIP_REQ = HAS_REQ ? false : '要件の原本(非公開)が無いため省略';
const REQ = HAS_REQ ? fs.readFileSync(REQ_PATH, 'utf8').replace(/\r\n/g, '\n') : '';
const NAMES = ['intel', 'plans', 'unit', 'inspector'];

// 簡単な frontmatter の読み取り(スカラー、"key:" の後の「- 値」のリスト、[a, b] の形に対応)
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter がありません');
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) { (out[key] = Array.isArray(out[key]) ? out[key] : []).push(item[1].trim()); continue; }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1];
    const val = kv[2].trim();
    if (val === '') out[key] = [];
    else if (/^\[.*\]$/.test(val)) out[key] = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else out[key] = val;
  }
  return out;
}
const toolList = (v) => (Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const load = (n) => parseFrontmatter(fs.readFileSync(path.join(ROOT, 'agents', `${n}.md`), 'utf8').replace(/\r\n/g, '\n'));

// requirements.md の「各エージェントの定義」の表を読む
function readTable() {
  const start = REQ.indexOf('## 各エージェントの定義');
  assert.ok(start >= 0);
  const rows = {};
  const lines = REQ.slice(start).split('\n');
  for (const line of lines.slice(1)) {
    if (/^## /.test(line)) break;
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length < 6 || !NAMES.includes(cells[1])) continue;
    const model = /^(haiku|sonnet|opus)/.exec(cells[4]);
    assert.ok(model, `model を読み取れません: ${cells[4]}`);
    rows[cells[1]] = { tools: cells[3].split(',').map((s) => s.trim()), model: model[1] };
  }
  return rows;
}

const TABLE = HAS_REQ ? readTable() : {};

describe('frontmatter の読み取り', () => {
  for (const n of NAMES) {
    test(`${n}.md が存在し、frontmatter を読み取れる`, () => {
      assert.ok(fs.existsSync(path.join(ROOT, 'agents', `${n}.md`)));
      const fm = load(n);
      assert.ok(fm.description && fm.description.length > 20);
    });
  }
});

describe('requirements.md の表との一致', { skip: SKIP_REQ }, () => {
  test('表から4体の行を読み取れている', () => {
    assert.deepEqual(Object.keys(TABLE).sort(), [...NAMES].sort());
  });
  for (const n of NAMES) {
    test(`${n}: name、tools、model`, () => {
      const fm = load(n);
      assert.equal(fm.name, n);
      assert.deepEqual(toolList(fm.tools).sort(), [...TABLE[n].tools].sort());
      assert.equal(fm.model, TABLE[n].model);
    });
  }
});

describe('共通の決まり', () => {
  for (const n of NAMES) {
    test(`${n}: skills に mission-order がある`, () => {
      assert.ok([].concat(load(n).skills || []).includes('mission-order'));
    });
    test(`${n}: hooks、permissionMode、mcpServers が無い`, () => {
      const fm = load(n);
      for (const k of ['hooks', 'permissionMode', 'mcpServers']) assert.ok(!(k in fm), k);
    });
    test(`${n}: Agent ツールを持たない`, () => {
      assert.ok(!toolList(load(n).tools).includes('Agent'));
    });
  }
  for (const n of ['intel', 'plans', 'inspector']) {
    test(`${n}: 書き込み系のツールを持たない`, () => {
      const tools = toolList(load(n).tools);
      for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent']) assert.ok(!tools.includes(t), t);
    });
  }
});

// ---------------------------------------------------------------- 本文の確認

const SKILL = fs.readFileSync(path.join(ROOT, 'skills', 'mission-order', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const GUARD = fs.readFileSync(path.join(ROOT, 'hooks', 'guard.js'), 'utf8').replace(/\r\n/g, '\n');
const body = (n) => fs.readFileSync(path.join(ROOT, 'agents', `${n}.md`), 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
const heads = (s) => [...s.matchAll(/【([^】]+)】/g)].map((m) => m[1]);
const skillBlocks = [...SKILL.slice(SKILL.indexOf('## 命令書'), SKILL.indexOf('## 計画書')).matchAll(/```text\n([\s\S]*?)```/g)].map((m) => [...m[1].matchAll(/^【([^】]+)】/gm)].map((x) => x[1]));
// 命令書と報告の型(0.2.0 で間に「完了条件の分け方」の型が入ったため、中身で見分ける)
const ORDER = skillBlocks.find((b) => b.includes('企図'));
const REPORT = skillBlocks.find((b) => b.includes('結論'));

describe('本文の命令書と報告の型', () => {
  test('SKILL.md から命令書と報告の型を読み取れている', () => {
    assert.ok(ORDER.includes('任務番号') && REPORT.includes('結論'));
  });
  for (const n of NAMES) {
    const isUnit = n === 'unit';
    test(`${n}: 命令書の並びが SKILL.md と同じ`, () => {
      const m = /^命令書は(.*?)の並びで/m.exec(body(n));
      assert.ok(m);
      const expected = ORDER.filter((h) => isUnit || h !== '変更してよいファイル');
      assert.deepEqual(heads(m[1]), expected);
    });
    test(`${n}: 報告の並びが SKILL.md と同じ(【実施内容】は unit だけ)`, () => {
      const m = /^報告は(.*?)の順/m.exec(body(n));
      assert.ok(m);
      // 【実施内容】は unit だけ。【目標の達成】は unit と inspector に必須で、intel と plans は分けた完了条件を受けたときだけ書く
      // 【物差しの外の指摘】は inspector だけ(0.4.0)
      const expected = REPORT.filter((h) => (isUnit || h !== '実施内容') && (isUnit || n === 'inspector' || h !== '目標の達成') && (n === 'inspector' || h !== '物差しの外の指摘'));
      assert.deepEqual(heads(m[1]), expected);
      if (isUnit) assert.match(body(n), /【実施内容】には、変更したファイルの一覧を必ず書きます/);
      else assert.match(body(n), /【実施内容】は unit だけの欄なので書きません/);
    });
    test(`${n}: 頼まれていなくても食い違いを報告する`, () => {
      assert.match(body(n), /頼まれていなくても、計画と実態の食い違いや、隠れた前提に気づいたら/);
    });
    test(`${n}: description に「使わない」があり、ASCII の ": " を含まない`, () => {
      const d = load(n).description;
      assert.ok(d.includes('使わない'));
      assert.ok(!d.includes(': '));
    });
  }
  test('inspector: Hooks か Claude Code の権限に止められたら別の手段を試さず「未解決」(同じ行。点検の中1)', () => {
    assert.match(body('inspector'), /^Hooks か Claude Code の権限に操作を止められたら、別の手段\(ほかのシェル、ほかのツール\)を試さず、「未解決」として報告します/m);
  });
  test('unit: Hooks に止められたら別の手段を試さない(「未解決」として報告する節の中)', () => {
    // 点検の中1: 止めた主体に Claude Code の権限を入れ、必成目標でも望成目標でも、ほかのシェルやツールで試さない
    assert.match(body('unit'), /「未解決」として報告します。\n(?:- .*\n)*- Hooks か Claude Code の権限に操作を止められたとき。必成目標でも望成目標でも、別の手段\(ほかのシェル、ほかのツール.*\)で同じことを試しません/);
  });
  test('inspector: git の節に設定ファイルの文言が無い', () => {
    const g = /^- 読み取り専用の git[\s\S]*?(?=^- 次の記号)/m.exec(body('inspector'));
    assert.ok(g);
    assert.ok(!g[0].includes('設定'));
  });
  test('unit: 同じエラーで2回失敗したら未解決', () => {
    assert.match(body('unit'), /同じエラーで2回失敗したとき/);
  });
  test('unit: シェルでも範囲外を変えない', () => {
    assert.match(body('unit'), /シェルのコマンド.*でも、範囲外のファイルを変えません/);
    assert.ok(!body('unit').includes('範囲の照合はシェルにはかからない'));
  });
  for (const n of ['intel', 'plans']) {
    test(`${n}: 変更を頼まれたら変更せず案と理由を書く`, () => {
      assert.match(body(n), /ファイルの変更を頼まれたら、変更しません。直す案を【結論】に、変更できない理由を【未解決・懸念】に/);
    });
  }
  test('inspector: 反対検討では【状況】の計画書を読み、点検では合否を書く', () => {
    assert.match(body('inspector'), /【状況】に全文が写されています/);
    assert.match(body('inspector'), /【結論】の1行目に、合格か不合格かを書きます/);
  });
  // ---------------- 0.2.0
  for (const n of ['intel', 'plans']) {
    test(`${n}: 完了条件が必成と望成に分かれた命令書を受けたときだけ【目標の達成】を書く`, () => {
      assert.match(body(n), /【完了条件】が必成と望成に分かれた命令書を受けたときは、【根拠】の次に【目標の達成】を書きます/);
    });
  }
  test('unit: 必成を終えてから望成に着手し、損耗限度で止め、【目標の達成】に書く', () => {
    const b = body('unit');
    assert.match(b, /必成を終えてから望成に着手します/);
    assert.match(b, /損耗限度\(試行の回数\)に達したら、繰り返さずに止め/);
    assert.ok(!b.includes('時間'), '損耗限度の時間はやめた(0.4.0)');
    assert.match(b, /【目標の達成】には、必成と望成のそれぞれについて/);
  });
  test('intel: 状況の特質を5つの観点で整理し、敵の可能行動は5つまで、最も起こりやすいものと最も痛いもの', () => {
    const b = body('intel');
    for (const h of ['任務の特質', '地形', '敵の可能行動', '我', '時間']) assert.ok(b.includes(`【${h}】`), h);
    assert.match(b, /5つまで/);
    assert.match(b, /最も起こりやすいもの/);
    assert.match(b, /起きたら最も痛いもの/);
    assert.match(b, /自分たちでは制御できず、任務の達成に影響する外部の要因/);
  });
  test('plans: 行動方針を2〜3案作る。計画書は作らない。1案だけなら理由を書く', () => {
    const b = body('plans');
    assert.match(b, /行動方針を2〜3案/);
    for (const h of ['目標', '行動方針', '1案だけの理由']) assert.ok(b.includes(`【${h}】`), h);
    assert.match(b, /計画書は作りません/);
    assert.match(b, /評価の材料になる事実/);
  });
  test('plans の description: 行動方針案を返し、大規模で使う', () => {
    const d = load('plans').description;
    assert.ok(d.includes('行動方針'));
    assert.ok(d.includes('大規模'));
  });
  test('inspector: 行動方針の分析は、案ごとの表と致命的な弱点。全案を1回で', () => {
    const b = body('inspector');
    assert.match(b, /「我の行動」「敵の可能行動が起こす問題」「こちらの対処」/);
    assert.ok(b.includes('【行動方針の分析】') && b.includes('【致命的な弱点】'));
    assert.match(b, /すべての案を、1回でまとめて分析します/);
  });
  test('inspector: 合否は点検の物差しだけで決め、重さを付け、物差しの外は【物差しの外の指摘】に書く(0.4.0)', () => {
    const b = body('inspector');
    assert.match(b, /合否は、点検の物差しだけで決めます。物差しは、命令書の【完了条件】の必成\(物1 などの番号つき\)と、いつも入る2つ\(【制約】を守ったこと、既存の動作を壊していないこと\)です/);
    assert.match(b, /重: このまま進むと必成目標を達成できない、または後の任務が誤った前提で進む。中: 進めるが、あとで直す手戻りが出る。軽: 進んでも支障がない/);
    assert.match(b, /不合格の理由にせず、【物差しの外の指摘】に重さと根拠を付けて書きます/);
    assert.match(b, /行動方針の分析と計画の反対検討では「なし」と書きます/);
    assert.match(b, /望成の未達成だけでは不合格にせず/);
  });
  test('inspector: 止める記号は、実装のとおり $ ( ) { } を単独で並べる(0.4.0 で食い違いを確かめた)', () => {
    assert.match(body('inspector'), /&&、\|\|、;、\|、&、>、>>、<、\$、\(、\)、\{、\}、バッククォート、改行/);
  });
  test('plans: 報告の記入例は plans の本文にある(0.4.0 で mission-order から移した)', () => {
    const b = body('plans');
    assert.match(b, /^## 記入例\(報告\)$/m);
    assert.match(b, /記入例は下の「記入例\(報告\)」に従います/);
  });
  test('agents: 4体のまま', () => {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).sort(), ['inspector.md', 'intel.md', 'plans.md', 'unit.md']);
  });
  test('SKILL.md: inspector の反対検討では計画書の全文を【】を外して【状況】に写す', () => {
    assert.match(SKILL, /unit の命令書では、計画書を貼らず/);
    assert.match(SKILL, /inspector の反対検討の命令書では、計画書の全文を、見出しの【】を外して/);
  });
});

describe('inspector の本文と guard.js の一致', () => {
  const literal = (name) => {
    const m = new RegExp('const ' + name + ' = ([\\s\\S]*?);\\n').exec(GUARD);
    assert.ok(m, name);
    return new Function(`return ${m[1]}`)();
  };
  const TEST_CMDS = literal('DEFAULT_TEST_COMMANDS');
  const GIT_OPTS = literal('GIT_OPTIONS');
  const b = body('inspector');
  test('テストのコマンドが DEFAULT_TEST_COMMANDS と一致', () => {
    const m = /^- テストのコマンド: (.*?)。/m.exec(b);
    assert.ok(m);
    assert.deepEqual(m[1].split('、').map((s) => s.trim()), TEST_CMDS);
  });
  for (const sub of ['diff', 'status', 'log', 'show']) {
    test(`git ${sub} のオプションが GIT_OPTIONS と一致`, () => {
      const m = new RegExp(`^ {2}- git ${sub}: (.*)$`, 'm').exec(b);
      assert.ok(m);
      const opts = m[1].replace(/(.*)/, (s) => s.replace(/(\(.*\))/, '')).split('、').map((s) => s.trim()).filter(Boolean);
      assert.deepEqual(opts, GIT_OPTS[sub]);
    });
  }
  test('止まる記号が guard.js の照合と合っている', () => {
    const src = GUARD.slice(GUARD.indexOf('function inspectorCheck'));
    const m = /\|\|\[([^\]]+)\]/.exec(src);
    assert.ok(m);
    const fromGuard = new Set([...m[1].replace(/\\[nr]/g, '\n')].map((c) => (c === '`' ? 'バッククォート' : c === '\n' ? '改行' : c)));
    const line = /^- 次の記号を含むコマンドは.*: (.*)$/m.exec(b)[1];
    const fromBody = new Set(line.replace(/。$/, '').split('、').map((s) => s.trim()).filter((s) => s.length === 1 || s === 'バッククォート' || s === '改行'));
    assert.deepEqual([...fromBody].sort(), [...fromGuard].sort());
  });
});

describe('hooks.json', () => {
  test('PreToolUse の matcher に Agent と Task がある', () => {
    const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const parts = h.hooks.PreToolUse[0].matcher.split('|');
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'Task']) assert.ok(parts.includes(t), t);
  });
});

describe('unit: 権限や Hooks で止められた望成目標(2026-11-21)', () => {
  const u = body('unit');
  test('未解決として報告する場合の例外として、望成目標は試行1回と数えて捨てる', () => {
    const sec = u.slice(u.indexOf('## 未解決として報告する場合'));
    assert.match(sec, /望成目標のための操作が止められたときは、あわせて試行1回と数えます。損耗限度に達したら、【目標の達成】に「捨てた」と書き、何の権限があれば達成できたかを書きます/);
    assert.doesNotMatch(sec, /ただし、望成目標/, '望成目標を「未解決」の例外にしない(点検の中1)');
  });
});

describe('inspector: 監察の合否と確かめ方(2026-11-22)', () => {
  const i = body('inspector');
  test('既存の動作を壊していないことの確かめ方は、inspector が決めて【根拠】に書く', () => {
    assert.match(i, /既存の動作を壊していないことをどう確かめるか\(テストを実行する、コードを読むなど\)は、自分で決め、確かめ方と結果を【根拠】に書きます/);
    assert.doesNotMatch(i, /既存のテストが通ることなど/);
  });
  test('要件にもある', { skip: SKIP_REQ }, () => {
    assert.match(REQ, /既存の動作を壊していないことをどう確かめるか\(テストを実行する、コードを読むなど\)は、inspector が決めて報告する/);
    assert.match(REQ, /「テストを実行すること」を望成目標にしたときは、規律と食い違わないので、区分を改めずにそのまま扱う/);
    assert.doesNotMatch(REQ, /既存のテストが通ることなど/);
  });
});

describe('unit: 欄が読み取れない命令書では起動されない(2026-11-22)', () => {
  test('起動されない場面の決まり(欄が読み取れないまま書き込みを止められる)を残さない', () => {
    assert.doesNotMatch(body('unit'), /読み取れないとき。この場合、Hooks が書き込みをすべて止めます/);
  });
});
