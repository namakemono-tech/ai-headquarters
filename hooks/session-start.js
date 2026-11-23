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

try {
  try { fs.readFileSync(0); } catch { /* 入力は使わない */ }
  // プラグイン版: 環境変数 CLAUDE_PLUGIN_ROOT があるか、プラグインの定義ファイルが隣にある
  let isPlugin = !!process.env.CLAUDE_PLUGIN_ROOT;
  if (!isPlugin) {
    try { isPlugin = fs.existsSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')); } catch { /* ZIP 版とみなす */ }
  }
  const skill = isPlugin ? 'ai-headquarters:mission-analysis' : 'mission-analysis';
  const order = isPlugin ? 'ai-headquarters:mission-order' : 'mission-order';
  const lines = [
    '【AI司令部】依頼を受けたら、作業の前に、変更するファイルを数えて規模(小・中・大)を決めてください。',
    '小=1〜2ファイル・調査不要・すぐ戻せる。3ファイル以上なら、一つ一つの変更がどれほど簡単でも中規模です(作った本人以外に点検させるため)。迷ったら大きい側です。',
    `中規模以上は、${skill} スキルで編成と手順を決めてください。小規模は、組み込みのサブエージェント(Explore など)も含めて使わず、メインセッションだけで進めます。`,
    '作戦中は、本製品の4体(intel、plans、unit、inspector)だけを使い、組み込みのサブエージェントは使いません。',
    '中規模以上では、承認を求める前に、作戦記録(.ai-headquarters/operations/OP-NNN.md)を作ってください。作戦記録が無いと、承認は記録されません。',
    '中規模以上では、任務分析のあとに目標の決心を、計画のあとに計画の決心を、指揮官に求めます。unit の起動には、計画の決心(指揮官が「承認」とだけ入力したこと)が必要です。',
    `中規模以上の任務分析の初めと、サブエージェントへの命令書を書く前に、${order} スキルを読み込んでください。命令書は、その型の見出しのとおりに書きます。`,
  ];
  const models = modelsLine();
  if (models) lines.push(models);
  const text = lines.join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
} catch { /* 何もしない */ }
process.exitCode = 0;
