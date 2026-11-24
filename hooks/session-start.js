'use strict';
// SessionStart: 規模判定の短い案内を入れる。設定ファイルに役ごとのモデル(models)があれば、その1行を足す(0.4.0)。何があっても exit 0。
const fs = require('node:fs');
const path = require('node:path');

// 設定ファイル(.ai-headquarters/config.json)の models から、4体の役の名前と、モデルの名前らしい値だけを拾って1行にする。
// 設定が無い、壊れている、使える値が1つも無いときは null(案内に足さない)
function modelsLine() {
  try {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.ai-headquarters', 'config.json'), 'utf8'));
    const m = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg.models : null;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const pairs = ['intel', 'plans', 'unit', 'inspector']
      .filter((r) => typeof m[r] === 'string' && /^[A-Za-z0-9._\[\]-]{1,60}$/.test(m[r]))
      .map((r) => `${r}=${m[r]}`);
    if (!pairs.length) return null;
    return `設定ファイルの役ごとのモデル: ${pairs.join('、')}。この役は、規模や任務の種類にかかわらず、起動のたびに Agent の呼び出しの model にこの名前を指定してください(指揮官がその作戦で指定したものが先です)。`;
  } catch { return null; }
}

// 続いている作戦の案内(0.5.0。12.14)。最新の作戦記録に「### 時程」があり、結果が「未完了」で、このセッションが承認を持っていないときだけ。
// 引き継ぎ待ち(あとに accept も cancel も無い offer)が残っていれば、入れ直しが要らないことを、無ければ申し出と「承認」1回を案内する
function continuingLine(sessionId) {
  try {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dir = path.join(root, '.ai-headquarters', 'operations');
    const ms = fs.readdirSync(dir).map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean);
    if (!ms.length) return null;
    const m = ms.reduce((a, b) => (parseInt(b[1], 10) > parseInt(a[1], 10) ? b : a));
    const op = `OP-${String(parseInt(m[1], 10)).padStart(3, '0')}`;
    const lines = fs.readFileSync(path.join(dir, m[0]), 'utf8').split(/\r?\n/).map((l) => l.trim());
    if (!lines.includes('### 時程')) return null;
    const i = lines.indexOf('## 結果');
    const res = i < 0 ? '' : (lines.slice(i + 1).find((l) => l !== '') || '');
    if (i >= 0 && res !== '' && !res.startsWith('未完了') && !res.startsWith('#')) return null;
    let rows = [];
    try { rows = fs.readFileSync(path.join(root, '.ai-headquarters', 'state', 'approvals.jsonl'), 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.operation === op); } catch { /* 無い */ }
    const holder = [...rows].reverse().find((r) => ['plan', 'milestone', 'accept'].includes(r.kind));
    // 計画の決心の前は、受け継ぐ承認が無いので出さない。承認を持つセッションと、この作戦ですでに動いたセッション(--continue で続けた会話。
    // 続けるたびに開始の案内が起きる)にも出さない(実地で、作戦記録を作ったセッションが「受け継ぎの申し出」を書いた)
    if (!holder || (sessionId && holder.session_id === sessionId)) return null;
    let mine = false;
    try { mine = fs.readFileSync(path.join(root, '.ai-headquarters', 'state', 'clock.jsonl'), 'utf8').split(/\r?\n/).some((l) => { try { const r = JSON.parse(l); return r.operation === op && r.session_id === sessionId; } catch { return false; } }); } catch { /* 無い */ }
    if (mine) return null;
    const last = [...rows].reverse().find((r) => ['offer', 'accept', 'cancel'].includes(r.kind));
    if (last && last.kind === 'offer') return `${op} は引き継ぎ待ちです。作戦記録を読み、計画と任務の要点を指揮官に示してから続けてください。『承認』の入れ直しは要りません。`;
    return `${op} は続いています。このセッションは承認を持っていません。作戦記録を読み、計画と任務の要点を指揮官に示し、『受け継ぎの申し出』を書いてから、『承認』を1回受けてください。`;
  } catch { return null; }
}

try {
  let sessionId = null;
  try { const inp = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); if (inp && typeof inp.session_id === 'string') sessionId = inp.session_id; } catch { /* 入力が無くても案内は出す */ }
  // プラグイン版: 環境変数 CLAUDE_PLUGIN_ROOT があるか、プラグインの定義ファイルが隣にある
  let isPlugin = !!process.env.CLAUDE_PLUGIN_ROOT;
  if (!isPlugin) {
    try { isPlugin = fs.existsSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')); } catch { /* ZIP 版とみなす */ }
  }
  const skill = isPlugin ? 'ai-headquarters:mission-analysis' : 'mission-analysis';
  const order = isPlugin ? 'ai-headquarters:mission-order' : 'mission-order';
  const lines = [
    '【AI司令部】依頼を受けたら、作業の前に、変更するファイルを数えて規模(小か、作戦か)を決めてください。',
    '小=1〜2ファイル・調査不要・すぐ戻せる。3ファイル以上、調査が要る、すぐには戻せない、のどれかなら作戦です(作った本人以外に点検させるため)。迷ったら作戦です。',
    `作戦では、${skill} スキルで編成と手順を決めてください。小は、組み込みのサブエージェント(Explore など)も含めて使わず、メインセッションだけで進めます。`,
    '作戦中は、本製品の4体(intel、plans、unit、inspector)だけを使い、組み込みのサブエージェントは使いません。',
    '作戦では、承認を求める前に、作戦記録(.ai-headquarters/operations/OP-NNN.md)を作ってください。作戦記録が無いと、承認は記録されません。',
    '作戦では、任務分析のあとに目標の決心を、計画のあとに計画の決心を、指揮官に求めます。unit の起動には、計画の決心(指揮官が「承認」とだけ入力したこと)が必要です。',
    `作戦の任務分析の初めと、サブエージェントへの命令書を書く前に、${order} スキルを読み込んでください。命令書は、その型の見出しのとおりに書きます。`,
  ];
  const models = modelsLine();
  if (models) lines.push(models);
  const cont = continuingLine(sessionId);
  if (cont) lines.push(cont);
  const text = lines.join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
} catch { /* 何もしない */ }
process.exitCode = 0;
