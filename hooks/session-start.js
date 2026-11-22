'use strict';
// SessionStart: 規模判定の短い案内を入れる。何があっても exit 0。
const fs = require('node:fs');
const path = require('node:path');

try {
  try { fs.readFileSync(0); } catch { /* 入力は使わない */ }
  // プラグイン版: 環境変数 CLAUDE_PLUGIN_ROOT があるか、プラグインの定義ファイルが隣にある
  let isPlugin = !!process.env.CLAUDE_PLUGIN_ROOT;
  if (!isPlugin) {
    try { isPlugin = fs.existsSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')); } catch { /* ZIP 版とみなす */ }
  }
  const skill = isPlugin ? 'ai-headquarters:mission-analysis' : 'mission-analysis';
  const order = isPlugin ? 'ai-headquarters:mission-order' : 'mission-order';
  const text = [
    '【AI司令部】依頼を受けたら、作業の前に、変更するファイルを数えて規模(小・中・大)を決めてください。',
    '小=1〜2ファイル・調査不要・すぐ戻せる。3ファイル以上なら、一つ一つの変更がどれほど簡単でも中規模です(作った本人以外に点検させるため)。迷ったら大きい側です。',
    `中規模以上は、${skill} スキルで編成と手順を決めてください。小規模は、組み込みのサブエージェント(Explore など)も含めて使わず、メインセッションだけで進めます。`,
    '作戦中は、本製品の4体(intel、plans、unit、inspector)だけを使い、組み込みのサブエージェントは使いません。',
    '中規模以上では、承認を求める前に、作戦記録(.ai-headquarters/operations/OP-NNN.md)を作ってください。作戦記録が無いと、承認は記録されません。',
    '中規模以上では、任務分析のあとに目標の決心を、計画のあとに計画の決心を、指揮官に求めます。unit の起動には、計画の決心(指揮官が「承認」とだけ入力したこと)が必要です。',
    `サブエージェントへの命令書を書く前に、${order} スキルを読み込んでください。命令書は、その型の見出しのとおりに書きます。`,
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
} catch { /* 何もしない */ }
process.exitCode = 0;
