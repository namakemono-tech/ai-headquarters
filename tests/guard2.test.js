'use strict';
// guard.js(PreToolUse / SubagentStart)の自動テスト。
// 実際に `node hooks/guard.js` を起動し、標準入力にJSONを渡して結果を確かめる。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const FP = require('./fingerprint-helper');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'g2-'));
const SUFFIX = '別の手段で同じことを試さず、『未解決』として報告してください';
const WIN = process.platform === 'win32';

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 後始末の失敗では落とさない */ }
});

let seq = 0;
function fix(files = {}) {
  const root = path.join(TMP, `f${process.pid}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
const config = (obj) => ({ '.ai-headquarters/config.json': obj });

function runRaw(stdin, root, env = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = 'INVALID'; }
  return { status: r.status, out, stderr: r.stderr, stdout: r.stdout };
}
function pre(root, { agent, tool, input = {}, session = 'S1', cwd }) {
  const o = {
    session_id: session,
    transcript_path: 'x',
    cwd: cwd || root,
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'tu1',
  };
  if (agent) { o.agent_id = 'agent-1'; o.agent_type = agent; }
  return runRaw(JSON.stringify(o), root);
}
const dec = (r) => (r.out && r.out.hookSpecificOutput ? r.out.hookSpecificOutput.permissionDecision : null);
const reason = (r) => (r.out && r.out.hookSpecificOutput ? r.out.hookSpecificOutput.permissionDecisionReason : '');
const updated = (r) => (r.out && r.out.hookSpecificOutput ? r.out.hookSpecificOutput.updatedInput : undefined);
const sh = (root, agent, command, tool = 'Bash') => pre(root, { agent, tool, input: { command } });
const ed = (root, agent, rel, tool = 'Edit') =>
  pre(root, { agent, tool, input: tool === 'NotebookEdit' ? { notebook_path: path.join(root, rel) } : { file_path: path.join(root, rel) } });

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const exists = (root, rel) => fs.existsSync(path.join(root, rel));


// 点検(2回目)の指摘への追加テスト
describe('点検の指摘 1: 包みは直後の1語だけをコマンド名として見る', () => {
  for (const c of ['time npm run format', 'env CI=1 npm run format', 'nohup python app.py format', 'sudo -u root npm run format', 'timeout 5 npm run format', 'xargs -n1 echo rm -rf']) {
    test(`止めない: ${c}`, () => {
      const root = fix();
      assert.equal(dec(sh(root, null, c)), null, c);
      assert.equal(dec(sh(root, 'other:a', c)), null, c);
    });
  }
  for (const c of ['cmd /c rd /s x', 'sudo rm -rf x', 'xargs rm -rf', 'bash -c "rm -rf x"', 'timeout 5 rm -rf x', 'sudo -u root rm -rf x', 'env -i FOO=1 git push -f', 'time rm -rf x',
    'eval "rm -rf x"', 'powershell -Command "iex \'rm -r x\'"']) {
    test(`止める: ${c}`, () => {
      const root = fix();
      assert.equal(dec(sh(root, null, c)), 'ask', c);
      assert.equal(dec(sh(root, 'unit', c)), 'deny', c);
    });
  }
  test('-EncodedCommand の中身も照合する', () => {
    const root = fix();
    const enc = Buffer.from('Remove-Item -Recurse x', 'utf16le').toString('base64');
    assert.equal(dec(sh(root, null, `powershell -NoProfile -EncodedCommand ${enc}`, 'PowerShell')), 'ask');
    assert.equal(dec(sh(root, 'unit', `pwsh -enc ${enc}`, 'PowerShell')), 'deny');
    const ok = Buffer.from('Get-Date', 'utf16le').toString('base64');
    assert.equal(dec(sh(root, null, `powershell -EncodedCommand ${ok}`, 'PowerShell')), null);
  });
});

describe('点検の指摘 2: ヒアドキュメントと複数行の引用符', () => {
  const commit = 'git commit -m "$(cat <<\'EOF\'\nFormat output\n.env note\nrm -r mention\nEOF\n)"';
  // 0.6.0(伺5): コミットそのものは、メインに確認、サブエージェントは拒否。本文の .env や rm -r の文字は、理由に出さない(読み違えない)
  test('標準のコミットの書き方は、コミットとしてだけ扱う(本文を読み違えない)', () => {
    const root = fix();
    const m = sh(root, null, commit);
    assert.equal(dec(m), 'ask');
    assert.ok(reason(m).includes('git commit') && !reason(m).includes('破壊的') && !reason(m).includes('保護'), reason(m));
    assert.equal(dec(sh(root, 'other:a', commit)), 'deny');
    assert.equal(dec(sh(root, 'unit', commit)), 'deny');
  });
  for (const q of ["'EOF'", '"EOF"', 'EOF']) {
    test(`ヒアドキュメント ${q} の本文は見ない`, () => {
      const root = fix();
      assert.equal(dec(sh(root, null, `cat <<${q}\nrm -rf x\n.env\nEOF`)), null);
    });
  }
  test('<<- の終端はタブ付きでもよい', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'cat <<-EOF\n\trm -rf x\n\tEOF\necho done')), null);
    assert.equal(dec(sh(root, null, 'cat <<-EOF\n\trm -rf x\n\tEOF\nrm -rf y')), 'ask');
  });
  test('ヒアドキュメントの出力先は照合する', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'cat <<EOF > .env\nhello\nEOF')), 'ask');
    assert.equal(dec(sh(root, 'unit', 'cat <<EOF > .env\nhello\nEOF')), 'deny');
    assert.equal(dec(sh(root, null, 'cat > .env <<EOF\nhello\nEOF')), 'ask');
  });
  test('シェルに渡すヒアドキュメントは本文も見る', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'bash <<EOF\nrm -rf x\nEOF')), 'ask');
  });
  test('終端の後ろの行は普通に見る', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'cat <<EOF\nhi\nEOF\ngit push -f')), 'ask');
  });
  test('引用符の中の << で後続の行を飲み込まない', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'echo "x <<a"\nrm -rf y\na')), 'ask');
    assert.equal(dec(sh(root, null, "echo 'x <<a'\nrm -rf y\na")), 'ask');
  });
  test('引用符の中の改行・つなぎ記号では区切らない', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'echo "a\nrm -rf x\nb"')), null);
    assert.equal(dec(sh(root, null, 'echo "a; rm -rf x"')), null);
    const c = sh(root, null, 'git commit -m "fix; git push -f && done"');
    assert.equal(dec(c), 'ask');
    assert.ok(reason(c).includes('git commit') && !reason(c).includes('強制'), reason(c));
    assert.equal(dec(sh(root, null, "echo 'a | rm -rf x'")), null);
  });
  test('引用符の中でも $( ) とバッククォートは実行されるので見る', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'echo "$(rm -rf x)"')), 'ask');
    assert.equal(dec(sh(root, null, 'echo "`rm -rf x`"')), 'ask');
    assert.equal(dec(sh(root, null, "echo '$(rm -rf x)'")), null);
  });
  test('閉じていない引用符(アポストロフィ)の後ろのつなぎも見る', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, "echo it's ; rm -rf x")), 'ask');
  });
  test('インスペクターの記号の検査は引用符の中にも当たったまま', () => {
    const root = fix();
    assert.equal(dec(sh(root, 'inspector', 'pytest "a\nb"')), 'deny');
    assert.equal(dec(sh(root, 'inspector', 'npm test <<EOF\nx\nEOF')), 'deny');
  });
});

describe('点検の指摘 3: cd の追跡', () => {
  const mk = () => fix({ '.ai-headquarters/operations/OP-001.md': 'x', '.ai-headquarters/state/approval.json': '{}' });
  for (const c of [
    'cd .ai-headquarters && echo {} > state/approval.json', 'cd .ai-headquarters && mv operations ../old', 'cd .ai-headquarters && rm -rf operations',
    'cd .ai-headquarters/state && rm approval.json', 'cd ./.ai-headquarters; rm operations/OP-001.md', 'pushd .ai-headquarters && rm -r operations',
    'bash -c "cd .ai-headquarters && rm -rf operations"', 'cd .ai-headquarters/operations && rm -f *', 'cd .ai-headquarters && echo x > config.json',
    'cd $X && rm -rf operations', 'cd $X && echo {} > state/approval.json', 'cd src && cd ../.ai-headquarters && rm -r operations',
  ]) {
    test(`deny(メインを含む): ${c}`, () => {
      assert.equal(dec(sh(mk(), null, c)), 'deny');
    });
  }
  test('PowerShell の Set-Location / sl', () => {
    assert.equal(dec(sh(mk(), null, 'Set-Location .ai-headquarters; Remove-Item -Recurse operations', 'PowerShell')), 'deny');
    assert.equal(dec(sh(mk(), null, 'sl .ai-headquarters; Set-Content state\\approval.json x', 'PowerShell')), 'deny');
  });
  test('関係の無い cd は止めない', () => {
    const root = mk();
    assert.equal(dec(sh(root, null, 'cd src && rm old.txt')), null);
    assert.equal(dec(sh(root, null, 'cd src && echo x > state/foo.txt')), null);
    assert.equal(dec(sh(root, null, 'cd .ai-headquarters && cat config.json')), null);
  });
});

describe('点検の指摘 4・9: 命令書の範囲の読み方と、unit の関門', () => {
  const ok = () => fix({
    '.ai-headquarters/operations/OP-001.md': 'a',
    '.ai-headquarters/state/approvals.jsonl': FP.planRow('a', 'S1', 'OP-001'),
  });
  const call = (root, prompt, agent = null, type = 'ai-headquarters:unit') =>
    pre(root, { agent, tool: 'Agent', input: { subagent_type: type, prompt, description: 'd' } });
  const realistic = [
    '【任務番号】OP-001-1', '【目的】コンポーネントを足す', '【変更してよいファイル】',
    '- src/a.js: 関数を追加', '- src/components', '- `src/b.js`, `src/c.js`', '- src/d.js — 新規', '- src/e.js - 修正', '* src/f.js (新規作成)', '・src/g.js（任意）',
    '- lib/h.js、lib/i.js', '- `src/**/*.test.js`', '', '【完了条件】', '- src/z.js が動く',
  ].join('\n');
  test('現実的な書き方を読める', () => {
    const root = ok();
    assert.equal(dec(call(root, realistic)), null);
    const s = readJson(root, '.ai-headquarters/state/unit-scope.json');
    assert.deepEqual(s.entries, ['src/a.js', 'src/components', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js', 'src/f.js', 'src/g.js', 'lib/h.js', 'lib/i.js', 'src/**/*.test.js']);
    for (const f of ['src/a.js', 'src/components/Button.tsx', 'src/components/deep/x.css', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js', 'src/f.js', 'src/g.js', 'lib/h.js', 'lib/i.js', 'src/q/r.test.js']) {
      assert.equal(dec(ed(root, 'unit', f, 'Edit')), null, f);
    }
    for (const f of ['src/z.js', 'src/componentsX/a.js', 'src/a.jsx', 'src/other.js']) assert.equal(dec(ed(root, 'unit', f, 'Edit')), 'deny', f);
  });
  test('波かっこの中のカンマでは分けない', () => {
    const root = ok();
    assert.equal(dec(call(root, '【変更してよいファイル】\n- src/{a,b}.js')), null);
    assert.deepEqual(readJson(root, '.ai-headquarters/state/unit-scope.json').entries, ['src/{a,b}.js']);
  });
  test('Windows のドライブ付きパスのコロンは説明の区切りにしない', () => {
    const root = ok();
    assert.equal(dec(call(root, `【変更してよいファイル】\n- ${path.join(root, 'src', 'w.js')}: 追加`)), null);
    assert.equal(dec(ed(root, 'unit', 'src/w.js', 'Write')), null);
  });
  test('Agent(unit) の関門は呼び出し元を問わない(未知のサブエージェントも)', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'a' });
    const r = call(root, realistic, 'other:thing');
    assert.equal(dec(r), 'deny');
    assert.ok(reason(r).includes('承認'));
    const root2 = ok();
    assert.equal(dec(call(root2, realistic, 'other:thing')), null);
    assert.equal(readJson(root2, '.ai-headquarters/state/unit-lock.json').status, 'reserved');
    assert.equal(dec(call(root2, realistic, 'other:thing')), 'deny');
  });
  test('4役が Agent を呼ぶのは従来どおり deny', () => {
    const root = ok();
    for (const a of ['unit', 'intel', 'plans', 'inspector']) assert.equal(dec(call(root, realistic, a)), 'deny');
    assert.equal(exists(root, '.ai-headquarters/state/unit-lock.json'), false);
  });
});

describe('点検の指摘 5・6: 読み取りは通し、作戦記録の丸ごと上書きは止める', () => {
  const mk = () => fix({ '.ai-headquarters/operations/OP-001.md': 'x', '.ai-headquarters/config.json': '{}', '.ai-headquarters/state/approval.json': '{}' });
  for (const c of [
    'git add .ai-headquarters/config.json', 'git add .ai-headquarters', 'git status .ai-headquarters/state', 'git diff -- .ai-headquarters/config.json', 'git log -- .ai-headquarters',
    'git show HEAD:.ai-headquarters/config.json', 'git blame .ai-headquarters/config.json', 'git ls-files .ai-headquarters/state', 'jq . .ai-headquarters/state/approval.json',
    'head -5 .ai-headquarters/config.json', 'tail .ai-headquarters/config.json', 'less .ai-headquarters/config.json', 'grep x .ai-headquarters/state/approval.json',
    'rg x .ai-headquarters', 'wc -l .ai-headquarters/config.json', 'type .ai-headquarters\\config.json', 'Select-String x .ai-headquarters/config.json', 'cat .ai-headquarters/state/approval.json',
    'ls .ai-headquarters/state',
  ]) {
    test(`メインは通す: ${c}`, () => {
      assert.equal(dec(sh(mk(), null, c, /^(type|Select)/.test(c) ? 'PowerShell' : 'Bash')), null);
    });
  }
  for (const c of ['git checkout .ai-headquarters/config.json', 'git commit -a .ai-headquarters/config.json', 'sed -i s/a/b/ .ai-headquarters/config.json', 'git diff --output=.ai-headquarters/state/x', 'cat x > .ai-headquarters/config.json']) {
    test(`書き込みになるものは deny: ${c}`, () => assert.equal(dec(sh(mk(), null, c)), 'deny'));
  }
  const OP = '.ai-headquarters/operations/OP-001.md';
  for (const [c, tool] of [
    [`Set-Content ${OP} x`, 'PowerShell'], [`Set-Content -Path ${OP} -Value x`, 'PowerShell'], [`sc ${OP} x`, 'PowerShell'], [`'x' | Out-File ${OP}`, 'PowerShell'],
    [`cp new.md ${OP}`, 'Bash'], [`copy new.md ${OP.replace(/\//g, '\\')}`, 'Bash'], [`Copy-Item new.md ${OP}`, 'PowerShell'], [`mv new.md ${OP}`, 'Bash'], [`Move-Item new.md ${OP}`, 'PowerShell'],
    [`sed -i s/a/b/ ${OP}`, 'Bash'], [`sed -i.bak s/a/b/ ${OP}`, 'Bash'], [`echo x | tee ${OP}`, 'Bash'], [`echo x > ${OP}`, 'Bash'], [`Clear-Content ${OP}`, 'PowerShell'],
  ]) {
    test(`既存の作戦記録を丸ごと上書き: ${c}`, () => {
      assert.equal(dec(sh(mk(), null, c, tool)), 'deny');
      assert.equal(dec(sh(mk(), 'other:a', c, tool)), 'deny');
    });
  }
  for (const [c, tool] of [
    [`echo x >> ${OP}`, 'Bash'], [`Add-Content ${OP} x`, 'PowerShell'], [`echo x | tee -a ${OP}`, 'Bash'], [`'x' | Out-File -Append ${OP}`, 'PowerShell'],
    [`cp ${OP} backup.md`, 'Bash'], [`cat ${OP}`, 'Bash'], [`sed s/a/b/ ${OP}`, 'Bash'], ['echo x > .ai-headquarters/operations/OP-002.md', 'Bash'], ['Set-Content .ai-headquarters/operations/OP-002.md x', 'PowerShell'],
  ]) {
    test(`メインは通す: ${c}`, () => assert.equal(dec(sh(mk(), null, c, tool)), null, c));
  }
});

describe('点検の指摘 7: git clean と .ai-headquarters', () => {
  const withOps = () => fix({ '.ai-headquarters/operations/OP-001.md': 'x' });
  for (const c of ['git clean -fd', 'git clean -fdx', 'git clean -fX', 'git clean -f -d', 'git clean -xdf', 'git clean -fd .ai-headquarters', 'git clean -fd .', 'git clean -fd -- .ai-headquarters/operations', 'git clean --force -d', 'bash -c "git clean -fd"']) {
    test(`作戦記録があれば deny: ${c}`, () => assert.equal(dec(sh(withOps(), null, c)), 'deny'));
  }
  test('作戦記録に当たらない指定・作戦記録が無いときは ask', () => {
    assert.equal(dec(sh(withOps(), null, 'git clean -fd src/')), 'ask');
    assert.equal(dec(sh(withOps(), null, 'git clean -f')), 'ask');
    assert.equal(dec(sh(fix(), null, 'git clean -fd')), 'ask');
  });
});

describe('点検の指摘 8: SubagentStart は絶対に失敗しない', () => {
  const run = (stdin, root) => spawnSync(process.execPath, [GUARD, 'subagent-start'], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  test('壊れた入力・空・null でも exit 0', () => {
    const root = fix();
    for (const s of ['{bad', '', 'null', '[]', '12']) {
      const r = run(s, root);
      assert.equal(r.status, 0, JSON.stringify(s));
      assert.equal(r.stdout, '');
    }
  });
  test('通常の入力は従来どおり running に切り替える', () => {
    const root = fix({ '.ai-headquarters/state/unit-lock.json': { session_id: 'S1', status: 'reserved', created_at: Date.now() } });
    const r = run(JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'S1', agent_type: 'ai-headquarters:unit', agent_id: 'q1', cwd: root }), root);
    assert.equal(r.status, 0);
    assert.equal(readJson(root, '.ai-headquarters/state/unit-lock.json').status, 'running');
  });
  test('PreToolUse の壊れた入力は引数なしなら従来どおり exit 2', () => {
    assert.equal(runRaw('{bad', fix()).status, 2);
  });
  test('hooks.json に mode 引数がある', () => {
    const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    assert.deepEqual(h.hooks.SubagentStart[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/hooks/guard.js', 'subagent-start']);
    assert.equal(h.hooks.SubagentStart[0].hooks[0].onFailure, undefined);
    assert.equal(h.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  });
});

describe('点検の指摘 10・11: 照合の計算量と rm の短いオプション', () => {
  test('**/ が12個並ぶパターンでも1秒以内', () => {
    const pat = '**/'.repeat(12) + 'zzz.secret';
    const root = fix(config({ protect: { add: [pat, '**/**/**/a/**/b/**/c/**/d.txt'] } }));
    const deep = Array.from({ length: 40 }, () => 'a').join('/') + '/file.txt';
    const t0 = Date.now();
    assert.equal(dec(ed(root, null, deep, 'Write')), null);
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
    assert.equal(dec(ed(root, null, deep.replace('file.txt', 'zzz.secret'), 'Write')), 'ask');
  });
  test('範囲の照合でも同様', () => {
    const root = fix({
      '.ai-headquarters/operations/OP-001.md': 'a', '.ai-headquarters/state/approvals.jsonl': FP.planRow('a', 'S1', 'OP-001'),
    });
    const prompt = '【変更してよいファイル】\n- ' + '**/'.repeat(12) + 'x.js';
    assert.equal(dec(pre(root, { tool: 'Agent', input: { subagent_type: 'unit', prompt } })), null);
    const deep = Array.from({ length: 40 }, () => 'a').join('/') + '/y.js';
    const t0 = Date.now();
    assert.equal(dec(ed(root, 'unit', deep, 'Write')), 'deny');
    assert.ok(Date.now() - t0 < 3000);
  });
  for (const c of ['rm -rfvId build', 'rm -vIdfr build', 'rm -fvR build', 'rm -dfivr x']) {
    test(`長い短縮オプションの束: ${c}`, () => {
      assert.equal(dec(sh(fix(), null, c)), 'ask');
    });
  }
  for (const c of ['rm -Force x', 'rm -vf x', 'rm -fv x', 'rm -Confirm:$false x', 'rm -f -v x']) {
    test(`再帰ではない: ${c}`, () => assert.equal(dec(sh(fix(), null, c)), null, c));
  }
});

describe('inspector が止める記号の理由文は、実装のとおり(0.4.0。動きは変えない)', () => {
  for (const c of ['npm test $X', 'npm test (a)', 'npm test a)', 'npm test {a}', 'npm test }']) {
    test(`止める: ${c}`, () => {
      const r = sh(fix(), 'inspector', c);
      assert.equal(dec(r), 'deny');
      const why = reason(r);
      for (const s of ['$', '(', ')', '{', '}']) assert.ok(why.includes(`${s} `) || why.includes(`${s}、`) || why.includes(`${s})`), `${s}: ${why}`);
      assert.match(why, /それぞれ単独でも/);
      assert.ok(!why.includes('$( '), why);
    });
  }
});
