'use strict';
// guard.js(PreToolUse / SubagentStart)の自動テスト。
// 実際に `node hooks/guard.js` を起動し、標準入力にJSONを渡して結果を確かめる。
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp', 'g1-'));
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

describe('入力の検証', () => {
  test('壊れた標準入力は exit 2', () => {
    const root = fix();
    assert.equal(runRaw('{not json', root).status, 2);
    assert.equal(runRaw('', root).status, 2);
    assert.equal(runRaw('null', root).status, 2);
  });
  test('対象外のイベントは何もせず exit 0', () => {
    const root = fix();
    const r = runRaw(JSON.stringify({ hook_event_name: 'Stop', session_id: 'S1' }), root);
    assert.equal(r.status, 0);
    assert.equal(r.out, null);
  });
  test('普通の操作で .ai-headquarters/ を作らない', () => {
    const root = fix();
    assert.equal(dec(ed(root, null, 'src/a.js')), null);
    assert.equal(dec(sh(root, null, 'echo hi')), null);
    assert.equal(dec(sh(root, 'ai-headquarters:unit', 'npm run build')), null);
    assert.equal(exists(root, '.ai-headquarters'), false);
  });
});

describe('読み取り専用の役 × ツール', () => {
  for (const agent of ['intel', 'plans', 'inspector', 'ai-headquarters:intel', 'ai-headquarters:plans', 'ai-headquarters:inspector']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      test(`${agent} の ${tool} は deny`, () => {
        const root = fix();
        const r = ed(root, agent, 'src/a.js', tool);
        assert.equal(r.status, 0);
        assert.equal(dec(r), 'deny');
        if (/inspector/.test(agent)) assert.ok(reason(r).includes(SUFFIX));
      });
    }
    test(`${agent} が Agent を呼ぶのは deny`, () => {
      const root = fix();
      assert.equal(dec(pre(root, { agent, tool: 'Agent', input: { subagent_type: 'unit', prompt: 'x' } })), 'deny');
    });
  }
  for (const agent of ['intel', 'ai-headquarters:plans']) {
    for (const tool of ['Bash', 'PowerShell']) {
      test(`${agent} の ${tool} は何でも deny`, () => {
        const root = fix();
        assert.equal(dec(sh(root, agent, 'ls', tool)), 'deny');
        assert.equal(dec(sh(root, agent, 'git status', tool)), 'deny');
      });
    }
  }
  test('メインセッションの通常編集は素通り', () => {
    const root = fix();
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(dec(ed(root, null, 'src/a.js', tool)), null);
  });
  test('agent_id が無ければ agent_type があってもメイン扱い(役割制限なし)', () => {
    const root = fix();
    const r = pre(root, { tool: 'Edit', input: { file_path: path.join(root, 'a.js') } });
    assert.equal(dec(r), null);
    const o = {
      session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
      agent_type: 'ai-headquarters:intel', tool_input: { file_path: path.join(root, 'a.js') },
    };
    assert.equal(dec(runRaw(JSON.stringify(o), root)), null);
  });
});

describe('unit は通常のファイル以外に Agent を呼べない', () => {
  test('unit の Agent は deny(接尾辞つき)', () => {
    const root = fix();
    const r = pre(root, { agent: 'unit', tool: 'Agent', input: { subagent_type: 'intel', prompt: 'x' } });
    assert.equal(dec(r), 'deny');
    assert.ok(reason(r).includes(SUFFIX));
  });
});

describe('inspector の許可リスト(テストコマンド)', () => {
  const okCmds = [
    'npm test', 'pnpm test', 'yarn test', 'node --test', 'node --test tests/a.test.js', 'pytest', 'pytest tests/test_a.py::test_x',
    'go test ./...', 'cargo test', 'npm test src/a.test.js',
  ];
  for (const tool of ['Bash', 'PowerShell']) {
    for (const c of okCmds) {
      test(`${tool}: ${c} は通す(何も返さない)`, () => {
        const root = fix();
        const r = sh(root, 'ai-headquarters:inspector', c, tool);
        assert.equal(r.status, 0);
        assert.equal(dec(r), null);
      });
    }
  }
  const ngCmds = [
    'ls', 'cat package.json', 'npm install', 'npm run build', 'node script.js', 'node --test --import ./x.js', 'npm test --coverage',
    'npm test -- --coverage', 'pytest -k foo', 'go test -run X', 'npm test && echo hi', 'npm test || true', 'npm test; ls', 'npm test | tee o',
    'npm test & ls', 'npm test > out.txt', 'npm test >> out.txt', 'pytest < in.txt', 'npm test $(whoami)', 'npm test `whoami`',
    'npm test\nls', 'npm test\r\nls', 'pytest "a;b"', "pytest 'a|b'", 'pytest "a&b"', 'pytest "a>b"', 'FOO=1 npm test', 'npm test \\--import=x',
    "pytest '-'-import=x", 'pytest tests/{a,b}.py', 'pytest $X', 'pytest (ls)',
  ];
  for (const c of ngCmds) {
    test(`ng: ${JSON.stringify(c)} は deny`, () => {
      const root = fix();
      const r = sh(root, 'inspector', c);
      assert.equal(dec(r), 'deny');
      assert.ok(reason(r).includes(SUFFIX));
    });
  }
  test('設定の allowedOptions に書いたオプションだけ許す', () => {
    const root = fix(config({ inspector: { allowedOptions: ['--coverage', '-k'] } }));
    assert.equal(dec(sh(root, 'inspector', 'npm test --coverage')), null);
    assert.equal(dec(sh(root, 'inspector', 'pytest -k foo')), null);
    assert.equal(dec(sh(root, 'inspector', 'pytest --import x')), 'deny');
    assert.equal(dec(sh(root, 'inspector', 'pytest --coverage=x')), 'deny');
  });
  test('設定の testCommands で独自のテストコマンドを足せる', () => {
    const root = fix(config({ inspector: { testCommands: ['make check', 'bun test'] } }));
    assert.equal(dec(sh(root, 'inspector', 'make check')), null);
    assert.equal(dec(sh(root, 'inspector', 'bun test a.test.ts')), null);
    assert.equal(dec(sh(root, 'inspector', 'make deploy')), 'deny');
  });
  test('壊れた設定ファイルは既定値で動く', () => {
    const root = fix({ '.ai-headquarters/config.json': '{oops' });
    assert.equal(dec(sh(root, 'inspector', 'npm test')), null);
    assert.equal(dec(sh(root, 'inspector', 'npm test --x')), 'deny');
  });
});

describe('inspector の git 許可リスト', () => {
  const pass = [
    'git status', 'git status -s', 'git status --short', 'git status --porcelain', 'git log --oneline', 'git log --oneline -n5',
    'git log -n 5', 'git log --stat', 'git log --format=%h', 'git log --format=%h -- src/a.js', 'git show --stat HEAD',
    'git show --name-only abc123', 'git diff', 'git diff --stat', 'git diff --name-only', 'git diff --name-status HEAD~1',
    'git diff --cached', 'git diff --staged --stat', 'git diff main..feature -- src/a.js', 'git show HEAD:src/a.js',
  ];
  for (const c of pass) {
    test(`通す: ${c}`, () => {
      const root = fix();
      const r = sh(root, 'ai-headquarters:inspector', c);
      assert.equal(r.status, 0);
      assert.notEqual(dec(r), 'deny', reason(r));
    });
  }
  const block = [
    'git -c core.pager=x diff', 'git -c x diff', 'git -C . status', 'git --git-dir=.git status', 'git --work-tree=. diff',
    'git --exec-path=x status', 'git diff --output=x.txt', 'git diff --output x.txt', 'git diff --ext-diff', 'git diff --textconv',
    'git log --ext-diff', 'git branch', 'git commit -m x', 'git checkout main', 'git push', 'git diff -p', 'git status -b',
    'git log --format="%h|%s"', 'git log --graph', 'git show --ext-diff HEAD', 'git', 'git status && ls', 'git diff -c',
    'git log --pretty=oneline', 'git diff --no-index a b', 'git show -s', 'git status --ignored',
  ];
  for (const c of block) {
    test(`止める: ${c}`, () => {
      const root = fix();
      const r = sh(root, 'inspector', c);
      assert.equal(dec(r), 'deny');
      assert.ok(reason(r).includes(SUFFIX));
    });
  }
  test('PowerShell でも同じ照合', () => {
    const root = fix();
    assert.notEqual(dec(sh(root, 'inspector', 'git status -s', 'PowerShell')), 'deny');
    assert.equal(dec(sh(root, 'inspector', 'git -c x diff', 'PowerShell')), 'deny');
  });
  test('git diff/log/show は updatedInput で --no-ext-diff --no-textconv を付ける', () => {
    const root = fix();
    for (const [cmd, expected] of [
      ['git diff --stat', 'git diff --no-ext-diff --no-textconv --stat'],
      ['git log --oneline -n5', 'git log --no-ext-diff --no-textconv --oneline -n5'],
      ['git show HEAD', 'git show --no-ext-diff --no-textconv HEAD'],
      ['git diff', 'git diff --no-ext-diff --no-textconv'],
    ]) {
      const r = pre(root, { agent: 'inspector', tool: 'Bash', input: { command: cmd, description: 'd' } });
      assert.equal(dec(r), 'allow', cmd);
      assert.deepEqual(updated(r), { command: expected, description: 'd' });
    }
  });
  test('git status は書き換え不要なので何も返さない', () => {
    const root = fix();
    const r = sh(root, 'inspector', 'git status -s');
    assert.equal(r.out, null);
  });
  test('inspector でも保護パスは止まる', () => {
    const root = fix();
    assert.equal(dec(sh(root, 'inspector', 'git diff .env')), 'deny');
  });
});

describe('保護パス', () => {
  const protectedFiles = ['.env', '.env.local', 'app/.env.production', 'server.pem', 'k/private.key', 'a.p12', 'a.pfx', 'a.jks', 'a.keystore', 'id_rsa',
    'id_rsa.pub', '.ssh/id_ed25519', '.npmrc', '.netrc', 'secrets.toml', 'credentials', 'credentials.json', 'x/credentials.yml', 'secrets.yaml', '.secrets'];
  for (const f of protectedFiles) {
    test(`メインは ask / サブエージェントは deny: ${f}`, () => {
      const root = fix();
      assert.equal(dec(ed(root, null, f, 'Write')), 'ask');
      const r = ed(root, 'other-plugin:thing', f, 'Write');
      assert.equal(dec(r), 'deny');
      assert.ok(!reason(r).includes(SUFFIX));
      const u = ed(root, 'ai-headquarters:unit', f, 'Edit');
      assert.equal(dec(u), 'deny');
      assert.ok(reason(u).includes(SUFFIX));
    });
  }
  for (const f of ['.env.example', '.env.sample', '.env.template', 'src/credentialsService.ts', 'process.env', 'environment.ts', 'config.json', 'keys.md', 'src/secrets.ts']) {
    test(`保護しない: ${f}`, () => {
      const root = fix();
      assert.equal(dec(ed(root, null, f, 'Write')), null);
    });
  }
  test('Windows のバックスラッシュ絶対パス', () => {
    const root = fix();
    const p = path.join(root, 'sub', '.env').split('/').join('\\');
    const r = pre(root, { tool: 'Write', input: { file_path: p } });
    assert.equal(dec(r), 'ask');
  });
  test('NotebookEdit の notebook_path も照合する', () => {
    const root = fix();
    assert.equal(dec(ed(root, null, 'secrets.json', 'NotebookEdit')), 'ask');
  });
  // 大文字小文字を無視するのは、ファイルの名前の大文字小文字を区別しない Windows と Mac(guard.js の CASE_INSENSITIVE)
  if (WIN || process.platform === 'darwin') {
    test('Windows と Mac では大文字小文字を無視する', () => {
      const root = fix();
      assert.equal(dec(ed(root, null, '.ENV', 'Write')), 'ask');
      assert.equal(dec(ed(root, null, 'Server.PEM', 'Write')), 'ask');
      assert.equal(dec(ed(root, null, '.AI-Headquarters/Config.json', 'Write')), 'deny');
    });
  }
  if (WIN) {
    test('末尾のドットや空白で保護を外れない', () => {
      const root = fix();
      assert.equal(dec(pre(root, { tool: 'Write', input: { file_path: path.join(root, '.env.') } })), 'ask');
    });
  }
  test('Bash: echo x>.env', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'echo x>.env')), 'ask');
    assert.equal(dec(sh(root, 'ai-headquarters:unit', 'echo x>.env')), 'deny');
    assert.equal(dec(sh(root, 'ai-headquarters:unit', 'echo x >> .env', 'PowerShell')), 'deny');
  });
  test('Bash: 各種の書き方', () => {
    const root = fix();
    for (const c of ['cat .env', 'cat < .env', 'cp .env /tmp/x', 'type .\\.env', 'Get-Content .env', 'git rm --cached .env', 'curl --data-binary=@.env x',
      'cat "app/.env"', "cat 'key.pem'", 'tee --output=.env', 'echo a&&cat .env', 'cat C:\\\\x\\\\.env', 'echo $(cat .env)', 'echo `cat id_rsa`']) {
      assert.equal(dec(sh(root, null, c)), 'ask', c);
    }
  });
  test('Bash: 保護対象に当たらない例', () => {
    const root = fix();
    for (const c of ['echo process.env', 'node -e "console.log(process.env.HOME)"', 'cat .env.example', 'cat credentialsService.ts', 'ls -la', 'npm run build', 'git status']) {
      assert.equal(dec(sh(root, null, c)), null, c);
    }
  });
  test('設定の protect.add(ファイル名・パス・フォルダ・**)', () => {
    const root = fix(config({ protect: { add: ['*.secret', 'config/prod.json', 'private/', '**/vault.json'] } }));
    assert.equal(dec(ed(root, null, 'a/b/x.secret', 'Write')), 'ask');
    assert.equal(dec(ed(root, null, 'config/prod.json', 'Write')), 'ask');
    assert.equal(dec(ed(root, null, 'other/config/prod.json', 'Write')), null);
    assert.equal(dec(ed(root, null, 'private/deep/er/file.txt', 'Write')), 'ask');
    assert.equal(dec(ed(root, null, 'x/y/vault.json', 'Write')), 'ask');
    assert.equal(dec(ed(root, null, 'vault.json', 'Write')), 'ask');
    assert.equal(dec(ed(root, null, 'src/ok.txt', 'Write')), null);
    assert.equal(dec(sh(root, 'ai-headquarters:unit', 'cat private/a.txt')), 'deny');
    assert.equal(dec(ed(root, 'unit', 'a/x.secret', 'Write')), 'deny');
  });
  test('設定の protect.exclude で既定の保護を外せる', () => {
    const root = fix(config({ protect: { exclude: ['*.pem', 'id_rsa*'] } }));
    assert.equal(dec(ed(root, null, 'a.pem', 'Write')), null);
    assert.equal(dec(ed(root, null, 'id_rsa', 'Write')), null);
    assert.equal(dec(ed(root, null, '.env', 'Write')), 'ask');
  });
  test('exclude では設定・状態の保護を外せない', () => {
    const root = fix(config({ protect: { exclude: ['.ai-headquarters/config.json', '.ai-headquarters/state/', '.ai-headquarters/**', '*'] } }));
    assert.equal(dec(ed(root, null, '.ai-headquarters/config.json', 'Write')), 'deny');
    assert.equal(dec(ed(root, null, '.ai-headquarters/state/approval.json', 'Write')), 'deny');
    assert.equal(dec(ed(root, null, '.ai-headquarters/state/approval.json', 'Edit')), 'deny');
  });
  test('プロジェクト外の絶対パスでもファイル名の保護は効く', () => {
    const root = fix();
    const other = path.join(path.dirname(root), 'elsewhere', '.env');
    assert.equal(dec(pre(root, { tool: 'Write', input: { file_path: other } })), 'ask');
    assert.equal(dec(pre(root, { tool: 'Write', input: { file_path: path.join(path.dirname(root), 'elsewhere', 'ok.txt') } })), null);
  });
});

describe('作戦記録・設定・状態の保護', () => {
  test('設定・状態への書き込みはメインでも deny', () => {
    const root = fix();
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      assert.equal(dec(ed(root, null, '.ai-headquarters/config.json', tool)), 'deny');
      assert.equal(dec(ed(root, null, '.ai-headquarters/state/approval.json', tool)), 'deny');
      assert.equal(dec(ed(root, null, '.ai-headquarters/state/unit-lock.json', tool)), 'deny');
    }
  });
  test('Bash でも設定・状態への書き込みは deny(メインを含む)', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'echo {} > .ai-headquarters/state/approval.json')), 'deny');
    assert.equal(dec(sh(root, null, 'echo {}>.ai-headquarters/config.json')), 'deny');
    assert.equal(dec(sh(root, null, 'Set-Content .ai-headquarters\\config.json x', 'PowerShell')), 'deny');
    assert.equal(dec(sh(root, null, 'cp x .ai-headquarters/state/approval.json')), 'deny');
  });
  test('Bash の読み取りだけのコマンドは通す', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'cat .ai-headquarters/config.json')), null);
    assert.equal(dec(sh(root, null, 'ls .ai-headquarters/state')), null);
    assert.equal(dec(sh(root, null, 'Get-Content .ai-headquarters/config.json', 'PowerShell')), null);
  });
  for (const c of [
    'mv .ai-headquarters x', 'mv .ai-headquarters/ x', 'mv .ai-headquarters/operations x', 'mv .ai-headquarters/operations/ x',
    'rm .ai-headquarters/operations/OP-001.md', 'rm -f .ai-headquarters/operations/OP-001.md', 'rm -rf .ai-headquarters', 'del .ai-headquarters\\operations\\OP-001.md',
    'Remove-Item -Recurse .ai-headquarters', 'Remove-Item .ai-headquarters\\operations\\OP-001.md', 'Move-Item .ai-headquarters/operations old', 'move .ai-headquarters x',
    'cmd /c rd /s .ai-headquarters', 'rm .ai-headquarters/operations/*', 'rm -r .ai-headquarters/*', 'rm .ai-headquarters/config.json', 'rm -r .ai-headquarters/state',
    'bash -c "rm .ai-headquarters/operations/OP-001.md"', 'ri .ai-headquarters/operations', 'git rm -r .ai-headquarters/operations', 'echo a; mv .ai-headquarters/operations o',
  ]) {
    test(`削除・移動は deny(メインを含む): ${c}`, () => {
      const root = fix({ '.ai-headquarters/operations/OP-001.md': 'x' });
      const r = sh(root, null, c, /^(Remove|ri |Move|Set)/.test(c) ? 'PowerShell' : 'Bash');
      assert.equal(dec(r), 'deny');
    });
  }
  test('作戦記録に関係しない rm は止めない(rm file)', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'x' });
    assert.equal(dec(sh(root, null, 'rm old.log')), null);
    assert.equal(dec(sh(root, null, 'mv a.txt b.txt')), null);
  });
  test('Write は既存の作戦記録に deny、新規は通す、Edit はメインなら通す', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'x' });
    assert.equal(dec(ed(root, null, '.ai-headquarters/operations/OP-001.md', 'Write')), 'deny');
    assert.equal(dec(ed(root, null, '.ai-headquarters/operations/OP-002.md', 'Write')), null);
    assert.equal(dec(ed(root, null, '.ai-headquarters/operations/OP-001.md', 'Edit')), null);
    assert.equal(dec(ed(root, null, '.ai-headquarters/operations/OP-001.md', 'MultiEdit')), null);
  });
  test('サブエージェントは .ai-headquarters/ 配下に書けない', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'x' });
    for (const agent of ['ai-headquarters:unit', 'unit', 'other:thing']) {
      assert.equal(dec(ed(root, agent, '.ai-headquarters/operations/OP-001.md', 'Edit')), 'deny');
      assert.equal(dec(ed(root, agent, '.ai-headquarters/operations/OP-009.md', 'Write')), 'deny');
      assert.equal(dec(ed(root, agent, '.ai-headquarters/notes.md', 'Write')), 'deny');
      assert.equal(dec(sh(root, agent, 'echo x > .ai-headquarters/notes.md')), 'deny');
    }
    assert.ok(reason(ed(root, 'unit', '.ai-headquarters/notes.md', 'Write')).includes(SUFFIX));
  });
  test('シェルのリダイレクトで既存の作戦記録を丸ごと上書きするのは deny', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'x' });
    assert.equal(dec(sh(root, null, 'echo x > .ai-headquarters/operations/OP-001.md')), 'deny');
    assert.equal(dec(sh(root, null, 'echo x >> .ai-headquarters/operations/OP-001.md')), null);
  });
});

describe('破壊的コマンド', () => {
  const destructive = [
    'rm -rf x', 'rm -fr x', 'rm -r x', 'rm -R x', 'rm -Rf x', 'rm --recursive x', 'rm --recursive --force x', 'RM -RF x', '/bin/rm -rf x',
    'Remove-Item -Recurse x', 'remove-item x -recurse', 'Remove-Item -Recurse -Force x', 'Remove-Item -r x', 'ri -r x', 'rd /s x', 'rd /s /q x', 'rmdir /s /q x',
    'del /s x', 'del /s/q x', 'DEL /S x', 'rm -Recurse x', 'del -Recurse x',
    'git push --force', 'git push -f origin main', 'git push --force-with-lease', 'git push origin +main', 'git -C . push --force', 'git -c a=b push -f',
    'git reset --hard', 'git reset --hard HEAD~1', 'git clean -f', 'git clean -fd', 'git clean -xdf', 'git clean --force', 'git checkout -- .', 'git restore .',
    'git branch -D x', 'git branch -fD x', 'format C:', 'FORMAT d: /q', 'find . -name x -delete', 'find . -exec rm -rf {} ;',
    'cmd /c rd /s x', 'cmd.exe /d /c "rd /s /q x"', 'cmd /c "del /s x"', 'bash -c "rm -rf x"', "sh -c 'rm -rf x'", 'bash -lc "echo a && rm -rf x"',
    'pwsh -c "Remove-Item -Recurse x"', 'powershell -Command "rm -r x"', 'powershell -NoProfile -Command Remove-Item -Recurse x', 'pwsh -Command "ls; ri -r x"',
    'sudo rm -rf x', 'sudo -u root rm -rf x', 'env FOO=1 rm -rf x', 'echo a | xargs rm -rf', 'xargs -I{} rm -rf {}', 'nohup rm -rf x', 'FOO=1 rm -rf x',
    'ls && rm -rf x', 'echo hi; git push -f', 'echo (rm -rf x)', 'echo $(rm -rf x)', 'echo `rm -rf x`', 'ls\nrm -rf x', 'true || git reset --hard', 'ls & rm -rf x',
    'cd x && cmd /c rd /s y', 'sudo bash -c "git push --force"', 'env bash -c "rm -rf x"',
  ];
  for (const c of destructive) {
    test(`止める: ${JSON.stringify(c)}`, () => {
      const root = fix();
      const tool = /^(Remove|remove|ri |pwsh|powershell)/.test(c) ? 'PowerShell' : 'Bash';
      assert.equal(dec(sh(root, null, c, tool)), 'ask', 'main');
      const r = sh(root, 'ai-headquarters:unit', c, tool);
      assert.equal(dec(r), 'deny', 'sub');
      assert.ok(reason(r).includes(SUFFIX));
      assert.equal(dec(sh(root, 'other:agent', c, tool)), 'deny', 'unknown sub');
    });
  }
  const harmless = [
    'git log --format=%h', 'npm run format', 'rm file.txt', 'rm -f file.txt', 'git push origin main', 'git push', 'git reset --soft HEAD~1', 'git reset HEAD file',
    'git status', 'Remove-Item -Force x.txt', 'Remove-Item x.txt', 'echo rm -rf', 'git branch -d x', 'git branch', 'git checkout main', 'git checkout -b x', 'git restore file.txt',
    'git clean -n', 'git commit -m "format"', 'ls format', 'echo format', 'del x.txt', 'rd x', 'find . -name x', 'git log --format="%h"', 'prettier --write .', 'node format.js',
    'git restore --staged .', 'npm run rm', 'sudo apt install foo',
  ];
  for (const c of harmless) {
    test(`止めない: ${c}`, () => {
      const root = fix();
      const r = sh(root, null, c);
      assert.equal(dec(r), null, reason(r));
      assert.equal(dec(sh(root, 'other:agent', c)), null);
    });
  }
  test('PowerShell ツールにも同じ照合', () => {
    const root = fix();
    assert.equal(dec(sh(root, null, 'Remove-Item -Recurse C:\\x', 'PowerShell')), 'ask');
    assert.equal(dec(sh(root, 'unit', 'git push --force', 'PowerShell')), 'deny');
  });
  test('メインは ask、メッセージは日本語', () => {
    const root = fix();
    const r = sh(root, null, 'rm -rf x');
    assert.equal(dec(r), 'ask');
    assert.match(reason(r), /[ぁ-んァ-ン一-龥]/);
  });
});

describe('承認の関門・予約・範囲', () => {
  const UNIT_PROMPT = [
    '【任務番号】OP-001-1', '【目的】テスト', '【変更してよいファイル】', '- src/a.js', '・src/lib/**/*.js', '', '  * docs/readme.md', '【完了条件】', '- 動く', '- other/not-scope.js',
  ].join('\n');
  const agentCall = (root, session = 'S1', prompt = UNIT_PROMPT, type = 'ai-headquarters:unit') =>
    pre(root, { tool: 'Agent', session, input: { subagent_type: type, prompt, description: 'd' } });
  const approved = (extra = {}) => fix({
    '.ai-headquarters/operations/OP-001.md': 'a',
    '.ai-headquarters/operations/OP-002.md': 'b',
    '.ai-headquarters/state/approval.json': { session_id: 'S1', operation: 'OP-002', plan: '2026-11-22T00:00:00Z' },
    ...extra,
  });

  test('作戦記録の無い状態では deny(承認を促す)', () => {
    const root = fix();
    const r = agentCall(root);
    assert.equal(dec(r), 'deny');
    assert.ok(reason(r).includes('承認'));
    assert.equal(exists(root, '.ai-headquarters'), false);
  });
  test('承認の記録が無ければ deny', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'a' });
    const r = agentCall(root);
    assert.equal(dec(r), 'deny');
    assert.ok(reason(r).includes('承認'));
    assert.equal(exists(root, '.ai-headquarters/state/unit-lock.json'), false);
  });
  test('別セッションの承認は deny', () => {
    const root = approved();
    assert.equal(dec(agentCall(root, 'OTHER')), 'deny');
  });
  test('古い作戦番号の承認は deny', () => {
    const root = fix({
      '.ai-headquarters/operations/OP-001.md': 'a', '.ai-headquarters/operations/OP-002.md': 'b',
      '.ai-headquarters/state/approval.json': { session_id: 'S1', operation: 'OP-001', plan: '2026-11-22T00:00:00Z' },
    });
    const r = agentCall(root);
    assert.equal(dec(r), 'deny');
    assert.ok(reason(r).includes('承認'));
  });
  test('作戦番号は数値で比べる(OP-9 と OP-10)', () => {
    const root = fix({
      '.ai-headquarters/operations/OP-9.md': 'a', '.ai-headquarters/operations/OP-10.md': 'b',
      '.ai-headquarters/state/approval.json': { session_id: 'S1', operation: 'OP-10', plan: '2026-11-22T00:00:00Z' },
    });
    assert.equal(dec(agentCall(root)), null);
  });
  test('壊れた承認ファイルは deny', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'a', '.ai-headquarters/state/approval.json': '{bad' });
    assert.equal(dec(agentCall(root)), 'deny');
  });
  test('承認済みなら通り、予約と範囲が書かれる', () => {
    const root = approved();
    const r = agentCall(root);
    assert.equal(r.status, 0);
    assert.equal(dec(r), null);
    const lock = readJson(root, '.ai-headquarters/state/unit-lock.json');
    assert.equal(lock.status, 'reserved');
    assert.equal(lock.session_id, 'S1');
    const scope = readJson(root, '.ai-headquarters/state/unit-scope.json');
    assert.equal(scope.valid, true);
    assert.deepEqual(scope.entries, ['src/a.js', 'src/lib/**/*.js', 'docs/readme.md']);
    assert.deepEqual(fs.readdirSync(path.join(root, '.ai-headquarters/state')).sort(), ['approval.json', 'unit-lock.json', 'unit-scope.json']);
  });
  test('素の名前 unit も同じ関門にかかる', () => {
    const root = fix({ '.ai-headquarters/operations/OP-001.md': 'a' });
    assert.equal(dec(agentCall(root, 'S1', UNIT_PROMPT, 'unit')), 'deny');
  });
  test('unit 以外の Agent 呼び出しは素通り(関門なし)', () => {
    const root = fix();
    for (const t of ['ai-headquarters:intel', 'ai-headquarters:plans', 'inspector', 'general-purpose', 'other:unit2', 'Explore']) {
      assert.equal(dec(agentCall(root, 'S1', 'x', t)), null, t);
    }
    assert.equal(exists(root, '.ai-headquarters'), false);
  });
  test('2体目の unit は deny', () => {
    const root = approved();
    assert.equal(dec(agentCall(root)), null);
    const r = agentCall(root);
    assert.equal(dec(r), 'deny');
    assert.ok(reason(r).includes('同時に1体'));
  });
  test('実行中の unit がいても2体目は deny', () => {
    const root = approved();
    assert.equal(dec(agentCall(root)), null);
    const lockPath = '.ai-headquarters/state/unit-lock.json';
    const l = readJson(root, lockPath);
    fs.writeFileSync(path.join(root, lockPath), JSON.stringify({ ...l, status: 'running', started_at: Date.now() - 5 * 60000 }));
    assert.equal(dec(agentCall(root)), 'deny');
  });
  const withLock = (lock) => approved({ '.ai-headquarters/state/unit-lock.json': lock });
  test('2分より古い reserved は無効として置き換える', () => {
    const root = withLock({ session_id: 'S1', status: 'reserved', created_at: Date.now() - 3 * 60000 });
    assert.equal(dec(agentCall(root)), null);
    const l = readJson(root, '.ai-headquarters/state/unit-lock.json');
    assert.equal(l.status, 'reserved');
    assert.ok(Date.now() - l.created_at < 60000);
  });
  test('2分以内の reserved は有効', () => {
    const root = withLock({ session_id: 'S1', status: 'reserved', created_at: Date.now() - 30000 });
    assert.equal(dec(agentCall(root)), 'deny');
  });
  test('30分より古い running は無効として置き換える', () => {
    const root = withLock({ session_id: 'S1', status: 'running', created_at: Date.now() - 40 * 60000, started_at: Date.now() - 31 * 60000, agent_id: 'x' });
    assert.equal(dec(agentCall(root)), null);
  });
  test('30分以内の running は有効', () => {
    const root = withLock({ session_id: 'S1', status: 'running', created_at: Date.now() - 20 * 60000, started_at: Date.now() - 20 * 60000, agent_id: 'x' });
    assert.equal(dec(agentCall(root)), 'deny');
  });
  test('別のセッションの記録は新しくても無効として置き換える', () => {
    const root = withLock({ session_id: 'OLD', status: 'running', created_at: Date.now(), started_at: Date.now(), agent_id: 'x' });
    assert.equal(dec(agentCall(root)), null);
    assert.equal(readJson(root, '.ai-headquarters/state/unit-lock.json').session_id, 'S1');
  });
  test('壊れた予約ファイルは古ければ置き換える', () => {
    const root = approved({ '.ai-headquarters/state/unit-lock.json': '{bad' });
    const p = path.join(root, '.ai-headquarters/state/unit-lock.json');
    const old = new Date(Date.now() - 10 * 60000);
    fs.utimesSync(p, old, old);
    assert.equal(dec(agentCall(root)), null);
  });
  test('同時に2つ起動しても片方だけが通る', async () => {
    const root = approved();
    const make = () => new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, [GUARD], { env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : null));
      c.stdin.end(JSON.stringify({
        session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent',
        tool_input: { subagent_type: 'ai-headquarters:unit', prompt: UNIT_PROMPT },
      }));
    });
    const res = await Promise.all([make(), make(), make()]);
    assert.equal(res.filter((x) => x === null).length, 1, JSON.stringify(res));
    assert.equal(res.filter((x) => x === 'deny').length, 2);
  });
  test('SubagentStart で reserved が running に切り替わる', () => {
    const root = approved();
    assert.equal(dec(agentCall(root)), null);
    const r = runRaw(JSON.stringify({ session_id: 'S1', hook_event_name: 'SubagentStart', agent_id: 'ag-77', agent_type: 'ai-headquarters:unit', cwd: root }), root);
    assert.equal(r.status, 0);
    const l = readJson(root, '.ai-headquarters/state/unit-lock.json');
    assert.equal(l.status, 'running');
    assert.equal(l.agent_id, 'ag-77');
    assert.equal(typeof l.started_at, 'number');
    assert.equal(l.session_id, 'S1');
  });
  test('SubagentStart: 別セッション・unit 以外・予約なしでは何もせず exit 0', () => {
    const root = approved();
    assert.equal(dec(agentCall(root)), null);
    const before = fs.readFileSync(path.join(root, '.ai-headquarters/state/unit-lock.json'), 'utf8');
    for (const o of [
      { session_id: 'OTHER', agent_type: 'unit', agent_id: 'a' },
      { session_id: 'S1', agent_type: 'ai-headquarters:intel', agent_id: 'a' },
    ]) {
      const r = runRaw(JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root, ...o }), root);
      assert.equal(r.status, 0);
    }
    assert.equal(fs.readFileSync(path.join(root, '.ai-headquarters/state/unit-lock.json'), 'utf8'), before);
    const empty = fix();
    const r = runRaw(JSON.stringify({ hook_event_name: 'SubagentStart', cwd: empty, session_id: 'S1', agent_type: 'unit', agent_id: 'a' }), empty);
    assert.equal(r.status, 0);
    assert.equal(exists(empty, '.ai-headquarters'), false);
  });
  test('SubagentStart: 状態ファイルが壊れていても exit 0', () => {
    const root = fix({ '.ai-headquarters/state/unit-lock.json': '{bad' });
    const r = runRaw(JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root, session_id: 'S1', agent_type: 'unit', agent_id: 'a' }), root);
    assert.equal(r.status, 0);
  });

  describe('範囲の照合', () => {
    const start = (root, prompt = UNIT_PROMPT) => {
      assert.equal(dec(agentCall(root, 'S1', prompt)), null);
    };
    test('範囲内は通し、範囲外は deny', () => {
      const root = approved();
      start(root);
      for (const tool of ['Edit', 'Write', 'MultiEdit']) {
        assert.equal(dec(ed(root, 'ai-headquarters:unit', 'src/a.js', tool)), null, tool);
        assert.equal(dec(ed(root, 'unit', 'src/lib/x/y/z.js', tool)), null);
        assert.equal(dec(ed(root, 'unit', 'src/lib/top.js', tool)), null);
        assert.equal(dec(ed(root, 'unit', 'docs/readme.md', tool)), null);
      }
      for (const rel of ['src/b.js', 'src/lib/x.ts', 'other/not-scope.js', 'a.js', 'lib/src/a.js', 'docs/readme.md.bak']) {
        const r = ed(root, 'ai-headquarters:unit', rel, 'Edit');
        assert.equal(dec(r), 'deny', rel);
        assert.ok(reason(r).includes(SUFFIX));
      }
    });
    test('Windows のバックスラッシュ絶対パスで照合', () => {
      const root = approved();
      start(root);
      const p = path.join(root, 'src', 'a.js').split('/').join('\\');
      assert.equal(dec(pre(root, { agent: 'unit', tool: 'Edit', input: { file_path: p } })), null);
      const q = path.join(root, 'src', 'zzz.js').split('/').join('\\');
      assert.equal(dec(pre(root, { agent: 'unit', tool: 'Edit', input: { file_path: q } })), 'deny');
    });
    test('NotebookEdit も照合', () => {
      const root = approved();
      start(root, '【変更してよいファイル】\n- nb/a.ipynb');
      assert.equal(dec(ed(root, 'unit', 'nb/a.ipynb', 'NotebookEdit')), null);
      assert.equal(dec(ed(root, 'unit', 'nb/b.ipynb', 'NotebookEdit')), 'deny');
    });
    test('unit のシェルは範囲の照合をしない', () => {
      const root = approved();
      start(root);
      assert.equal(dec(sh(root, 'unit', 'npm test')), null);
      assert.equal(dec(sh(root, 'unit', 'echo x > other/file.txt')), null);
      assert.equal(dec(sh(root, 'unit', 'Set-Content other/file.txt x', 'PowerShell')), null);
    });
    test('範囲内でも保護パスは deny', () => {
      const root = approved();
      start(root, '【変更してよいファイル】\n- .env\n- src/a.js');
      assert.equal(dec(ed(root, 'unit', '.env', 'Write')), 'deny');
    });
    test('【変更してよいファイル】が無ければ、起動を止め、unit の書き込みも全部 deny(2026-11-22)', () => {
      const root = approved();
      assert.equal(dec(agentCall(root, 'S1', '【任務番号】OP-1\n【目的】x')), 'deny');
      assert.equal(fs.existsSync(path.join(root, '.ai-headquarters/state/unit-scope.json')), false);
      assert.equal(fs.existsSync(path.join(root, '.ai-headquarters/state/unit-lock.json')), false);
      assert.equal(dec(ed(root, 'unit', 'src/a.js', 'Write')), 'deny');
      assert.equal(dec(ed(root, 'unit', 'a.txt', 'Edit')), 'deny');
    });
    test('セクションが空でも、起動を止める', () => {
      const root = approved();
      assert.equal(dec(agentCall(root, 'S1', '【変更してよいファイル】\n\n   \n【完了条件】\n- src/a.js')), 'deny');
      assert.equal(fs.existsSync(path.join(root, '.ai-headquarters/state/unit-scope.json')), false);
      assert.equal(dec(ed(root, 'unit', 'src/a.js', 'Write')), 'deny');
    });
    test('範囲の記録が無ければ deny', () => {
      const root = fix();
      assert.equal(dec(ed(root, 'unit', 'src/a.js', 'Write')), 'deny');
    });
    test('壊れた範囲の記録は deny', () => {
      const root = fix({ '.ai-headquarters/state/unit-scope.json': '{bad' });
      assert.equal(dec(ed(root, 'unit', 'src/a.js', 'Write')), 'deny');
    });
    test('次の unit の起動で範囲が置き換わる', () => {
      const root = approved();
      start(root);
      fs.unlinkSync(path.join(root, '.ai-headquarters/state/unit-lock.json'));
      start(root, '【変更してよいファイル】\n- other/x.js');
      assert.equal(dec(ed(root, 'unit', 'other/x.js', 'Write')), null);
      assert.equal(dec(ed(root, 'unit', 'src/a.js', 'Write')), 'deny');
    });
    test('見出しの後ろに同じ行で書いたパスも拾う / 箇条書きの種類', () => {
      const root = approved();
      start(root, '【変更してよいファイル】src/one.js\n1. src/two.js\n● src/three.js\n* `src/four.js`\n【報告】\n- no.js');
      assert.deepEqual(readJson(root, '.ai-headquarters/state/unit-scope.json').entries, ['src/one.js', 'src/two.js', 'src/three.js', 'src/four.js']);
    });
    test('先頭が ./ や絶対パスのエントリも正規化する', () => {
      const root = approved();
      start(root, `【変更してよいファイル】\n- ./src/a.js\n- ${path.join(root, 'src', 'abs.js')}`);
      assert.equal(dec(ed(root, 'unit', 'src/a.js', 'Write')), null);
      assert.equal(dec(ed(root, 'unit', 'src/abs.js', 'Write')), null);
    });
    test('スラッシュの無いエントリはプロジェクト直下だけ', () => {
      const root = approved();
      start(root, '【変更してよいファイル】\n- README.md');
      assert.equal(dec(ed(root, 'unit', 'README.md', 'Write')), null);
      assert.equal(dec(ed(root, 'unit', 'sub/README.md', 'Write')), 'deny');
    });
    test('フォルダ(末尾 /)のエントリは中のすべてに当たる', () => {
      const root = approved();
      start(root, '【変更してよいファイル】\n- src/feature/');
      assert.equal(dec(ed(root, 'unit', 'src/feature/a/b.js', 'Write')), null);
      assert.equal(dec(ed(root, 'unit', 'src/other.js', 'Write')), 'deny');
    });
    test('プロジェクト外のパスは deny', () => {
      const root = approved();
      start(root, '【変更してよいファイル】\n- **');
      const p = path.join(path.dirname(root), 'outside.js');
      assert.equal(dec(pre(root, { agent: 'unit', tool: 'Write', input: { file_path: p } })), 'deny');
    });
  });
});

describe('種類を判別できないエージェント', () => {
  for (const agent of ['general-purpose', 'Explore', 'other-plugin:builder']) {
    test(`${agent}: 役割制限なし・共通の規律だけ`, () => {
      const root = fix();
      assert.equal(dec(ed(root, agent, 'src/a.js', 'Write')), null);
      assert.equal(dec(sh(root, agent, 'ls -la')), null);
      assert.equal(dec(sh(root, agent, 'npm install')), null);
      assert.equal(dec(pre(root, { agent, tool: 'Agent', input: { subagent_type: 'intel', prompt: 'x' } })), null);
      assert.equal(dec(ed(root, agent, '.env', 'Write')), 'deny');
      assert.equal(dec(sh(root, agent, 'rm -rf x')), 'deny');
      assert.equal(dec(ed(root, agent, '.ai-headquarters/config.json', 'Write')), 'deny');
    });
  }
  test('名前が似ているだけのものは役として扱わない', () => {
    const root = fix();
    for (const a of ['ai-headquarters:unit2', 'myunit', 'x:ai-headquarters:intel', 'intel2', 'other:inspector']) {
      assert.equal(dec(ed(root, a, 'src/a.js', 'Write')), null, a);
    }
  });
});

describe('出力の形', () => {
  test('deny は hookSpecificOutput の形式で exit 0', () => {
    const root = fix();
    const r = ed(root, 'intel', 'a.js');
    assert.equal(r.status, 0);
    assert.equal(r.out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /[ぁ-んァ-ン一-龥]/);
  });
  test('strictest: inspector の git diff で保護パスなら updatedInput ではなく deny', () => {
    const root = fix();
    const r = sh(root, 'inspector', 'git diff -- .env');
    assert.equal(dec(r), 'deny');
    assert.equal(updated(r), undefined);
  });
  test('tool_input が無い/想定外でもクラッシュしない', () => {
    const root = fix();
    const r = runRaw(JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash' }), root);
    assert.equal(r.status, 0);
    assert.equal(dec(r), null);
    const r2 = runRaw(JSON.stringify({ session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'a', agent_type: 'inspector' }), root);
    assert.equal(dec(r2), 'deny');
  });
  test('CLAUDE_PROJECT_DIR が無ければ cwd を使う', () => {
    const root = fix();
    const o = { session_id: 'S1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, '.env') } };
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(o), encoding: 'utf8', env });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });
});
