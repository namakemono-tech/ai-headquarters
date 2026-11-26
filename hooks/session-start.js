'use strict';
// SessionStart(0.6.0): 進め方のスキルを読み込む1行と、続いている作戦があることの1行を入れる。
// 設定ファイルに役ごとのモデル(models)があれば、その1行を足す。何があっても exit 0。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// 0.5.0 までの形の作戦記録の移し方(guard.js と同じ文)
const MIGRATE = (op) => `書き直すより、次の形で移すことを勧めます。(1) ${op} の「## 結果」の最初の行を、ここまでの結果と「残りは次の作戦に移す」に書き換えて閉じる。(2) 残りの仕事を、次の番号の作戦記録として新しい雛形(mission-analysis の「作戦記録」の章。見出し9つ)で立て、「## 企図」に「経過: ${op}(0.5.0 の形の記録)」の1行だけを置く。(3) 新しい作戦の目標と方針を、ふつうの作戦と同じく、目標の決心と計画の決心で指揮官に示し、それぞれ「承認」とだけ入力してもらう。`;

// 設定ファイル(.ai-headquarters/config.json)の models から、4体の役の名前と、モデルの名前らしい値だけを拾って1行にする
function modelsLine() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.ai-headquarters', 'config.json'), 'utf8'));
    const m = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg.models : null;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const pairs = ['intel', 'plans', 'unit', 'inspector']
      .filter((r) => typeof m[r] === 'string' && /^[A-Za-z0-9._\[\]-]{1,60}$/.test(m[r]))
      .map((r) => `${r}=${m[r]}`);
    if (!pairs.length) return null;
    return `設定ファイルの役ごとのモデル: ${pairs.join('、')}。この役を起動するときは、Agent の呼び出しの model にこの名前を指定してください(指揮官がその場で別のモデルを指示したときを除く)。`;
  } catch { return null; }
}

// 続いている作戦(最新の作戦記録の「## 結果」が「未完了」で、計画の決心の記録があり、このセッションはまだその作戦に関わっていない)
function continuingLine(sessionId) {
  try {
    const dir = path.join(ROOT, '.ai-headquarters', 'operations');
    const ms = fs.readdirSync(dir).map((n) => /^OP-(\d+)\.md$/i.exec(n)).filter(Boolean);
    if (!ms.length) return null;
    const m = ms.reduce((a, b) => (parseInt(b[1], 10) > parseInt(a[1], 10) ? b : a));
    const op = `OP-${String(parseInt(m[1], 10)).padStart(3, '0')}`;
    const text = fs.readFileSync(path.join(dir, m[0]), 'utf8');
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const i = lines.indexOf('## 結果');
    const res = i < 0 ? '' : (lines.slice(i + 1).find((l) => l !== '') || '');
    if (i >= 0 && res !== '' && !res.startsWith('未完了') && !res.startsWith('#')) return null;
    // 0.5.0 までの形(guard.js と同じ見分け方)。承認の記録が無くても知らせる(0.6.0 を入れたあと、最初に通る道のため)
    if (!/^目標の決心\s*[:：]/m.test(text) && (/^###\s*(時程|目標の決心|計画の決心)\s*$/m.test(text) || /^##\s*計画\s*$/m.test(text))) {
      return `${op} は 0.5.0 までの形の作戦記録で、続いています。0.6.0 では、この形の承認を受け継ぎません。${MIGRATE(op)}`;
    }
    let rows = [];
    try { rows = fs.readFileSync(path.join(ROOT, '.ai-headquarters', 'state', 'approvals.jsonl'), 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.operation === op); } catch { /* 無い */ }
    if (!rows.some((r) => ['plan', 'milestone', 'accept'].includes(r.kind))) return null;
    // --continue で続けた会話も開始の案内が起きるので、この作戦の記録にすでに出てくるセッションには出さない
    if (sessionId && rows.some((r) => r.session_id === sessionId)) return null;
    const last = [...rows].reverse().find((r) => ['offer', 'accept', 'cancel'].includes(r.kind));
    if (last && last.kind === 'offer') return `${op} は引き継ぎ待ちです。作戦記録の「## いま」までを読み、方針と任務の要点を指揮官に示してから続けてください。「承認」の入れ直しは要りません。`;
    return `${op} は続いています。このセッションは承認を持っていません。作戦記録の「## いま」までを読み、方針と任務の要点を指揮官に示し、「## いま」に「受け継ぎの申し出: 」の行を書いてから、「承認」を1回受けてください。`;
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
  const lines = [`【AI司令部】指揮官から作業の依頼を受けたら、最初の応答の前に ${skill} スキルを読み込み、その進め方で進めてください。依頼に進め方の程度が「実行だけ」と書かれていれば、読み込まずに、そのまま実行して報告してください(作戦記録は作りません)。`];
  const models = modelsLine();
  if (models) lines.push(models);
  const cont = continuingLine(sessionId);
  if (cont) lines.push(cont);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
} catch { /* 何もしない */ }
process.exitCode = 0;
