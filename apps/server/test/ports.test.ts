import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScmMcp } from '../src/integrations/bitbucket-mcp.ts';
import { createWikiMcp, toPage } from '../src/integrations/confluence-mcp.ts';
import { sandboxProfile, seatbeltSandbox, type Sandbox } from '../src/integrations/sandbox.ts';
import { createShell } from '../src/integrations/shell.ts';
import { PROFILES } from './helpers.ts';

describe('shell port', () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'shell-data-')));
  const shell = createShell({ sandbox: seatbeltSandbox({ home: homedir(), dataDir }) });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'shell-')));

  it('returns the exit code, the combined output tail and writes the full log', async () => {
    const logFile = join(cwd, 'logs', 'build.log');
    const r = await shell.run('echo out; echo err >&2; echo "$GREETING"; exit 3', { cwd, env: { GREETING: 'привет' }, logFile });
    expect(r).toMatchObject({ code: 3, timedOut: false, aborted: false });
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(r.output).toContain('привет');
    expect(readFileSync(logFile, 'utf8')).toContain('привет');
  });

  it('stops a command that runs past its timeout together with its children', async () => {
    const started = Date.now();
    const r = await shell.run('sleep 20 & wait', { cwd, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('runs the build in a sandbox: no network, no writes outside allowed folders, no token files', async () => {
    const script = [
      "const fs = require('node:fs');",
      "const r = {};",
      "const t = (k, f) => { try { f(); r[k] = 'ok'; } catch (e) { r[k] = e.code; } };",
      "t('cwd', () => fs.writeFileSync('inside.txt', 'x'));",
      `t('home', () => fs.writeFileSync(${JSON.stringify(join(homedir(), '.task-pilot-shell-probe'))}, 'x'));`,
      `t('data', () => fs.readdirSync(${JSON.stringify(dataDir)}));`,
      `t('token', () => fs.readFileSync(${JSON.stringify(join(homedir(), '.claude.json'))}));`,
      "fetch('https://example.com').then(() => { r.net = 'ok'; }, (e) => { r.net = e.cause?.code ?? 'failed'; }).finally(() => console.log(JSON.stringify(r)));",
    ].join('\n');
    writeFileSync(join(cwd, 'probe.cjs'), script);
    const r = await shell.run('node probe.cjs', { cwd });
    const out = JSON.parse(r.output.trim().split('\n').at(-1)!) as Record<string, string>;
    expect(out.cwd).toBe('ok');
    expect(out.home).toBe('EPERM');
    expect(out.data).toBe('EPERM');
    if (existsSync(join(homedir(), '.claude.json'))) expect(out.token).toBe('EPERM');
    expect(out.net).not.toBe('ok');
    expect(existsSync(join(homedir(), '.task-pilot-shell-probe'))).toBe(false);
  });

  it('does not start a command without an available sandbox and says what is missing', async () => {
    let wrapped = 0;
    const absent: Sandbox = {
      available: () => false,
      missing: 'нет /usr/bin/sandbox-exec',
      wrap: (command) => {
        wrapped += 1;
        return { program: '/bin/sh', args: ['-c', command] };
      },
    };
    const marker = join(cwd, 'ran.txt');
    await expect(createShell({ sandbox: absent }).run(`touch ${marker}`, { cwd })).rejects.toThrow('Песочница сборки недоступна: нет /usr/bin/sandbox-exec, команда не запускалась');
    expect(wrapped).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // Seatbelt без sandbox-exec на месте недоступен и называет, чего нет.
    const moved = seatbeltSandbox({ home: homedir(), dataDir }, '/nonexistent/sandbox-exec');
    expect(moved.available()).toBe(false);
    expect(moved.missing).toBe('нет /nonexistent/sandbox-exec');
  });

  it('wraps the command into sandbox-exec with the profile for its folders', () => {
    const { program, args } = seatbeltSandbox({ home: '/h', dataDir: '/data' }).wrap('mvn -q test', { cwd: '/w', writeDirs: ['/d'] });
    expect(program).toBe('/usr/bin/sandbox-exec');
    expect(args).toEqual(['-p', sandboxProfile({ cwd: '/w', writeDirs: ['/d'], home: '/h', dataDir: '/data' }), '/bin/sh', '-c', 'mvn -q test']);
  });

  it('builds a profile that never allows outbound traffic by local address', () => {
    const p = sandboxProfile({ cwd: '/w', writeDirs: ['/d'], home: '/h', dataDir: '/data' });
    expect(p).toContain('(deny network*)');
    expect(p).not.toMatch(/network-outbound \(local ip/);
    expect(p).not.toMatch(/allow network\* \(local ip/);
    expect(p).toContain('(subpath "/w")');
    expect(p).toContain('(subpath "/d")');
    expect(p).toContain('(subpath "/h/.m2")');
    expect(p).toContain('(regex #"^\\/h\\/\\.claude\\.json")');
  });

  it('stops a command when the owner stops the run', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const r = await shell.run('sleep 20', { cwd, signal: controller.signal });
    expect(r.aborted).toBe(true);
  });
});

describe('Bitbucket port over MCP', () => {
  const ref = { contour: 'cloud', project: 'CLOUD', repo: 'gate' };
  const contours = [{ ...PROFILES.contours[0]!, mcp: { bitbucket: 'bitbucket' } }, PROFILES.contours[1]!];

  it('lists open pull requests of the branch through the server of the repository contour', async () => {
    const calls: unknown[] = [];
    const scm = createScmMcp(async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { branch: { name: 'feature/TEAM-1' }, open_pull_requests: [{ id: 262, title: 'TEAM-1 Вход', destination_branch: 'master' }] };
    }, contours);
    expect(await scm.openPullRequests(ref, 'feature/TEAM-1')).toEqual([
      { id: 262, title: 'TEAM-1 Вход', url: 'https://git.example.org/projects/CLOUD/repos/gate/pull-requests/262', to: 'master' },
    ]);
    expect(calls).toEqual([{ server: 'bitbucket', tool: 'get_branch', args: { workspace: 'CLOUD', repository: 'gate', branch_name: 'feature/TEAM-1' } }]);
  });

  it('reports a branch unknown to Bitbucket as null and passes other not found errors through', async () => {
    const missing = createScmMcp(async () => {
      throw new Error("bitbucket/get_branch: Branch 'feature/TEAM-1' not found in CLOUD/gate");
    }, contours);
    expect(await missing.openPullRequests(ref, 'feature/TEAM-1')).toBeNull();
    const wrongRepo = createScmMcp(async () => {
      throw new Error('bitbucket/get_branch: Not found: repository CLOUD/typo');
    }, contours);
    await expect(wrongRepo.openPullRequests(ref, 'feature/TEAM-1')).rejects.toThrow('Not found');
  });

  it('creates a pull request, omits an empty reviewer list and keeps the title from the request', async () => {
    let seen: Record<string, unknown> = {};
    const scm = createScmMcp(async (_server, _tool, args) => {
      seen = args;
      // Так отвечает настоящий сервер: без заголовка и цели.
      return { id: 270, version: 0, state: 'OPEN', web_url: 'https://git.example.org/pr/270' };
    }, contours);
    const pr = await scm.createPullRequest(ref, { title: 'TEAM-1 Вход', description: 'Описание', from: 'feature/TEAM-1', to: 'master', reviewers: [] });
    expect(pr).toEqual({ id: 270, title: 'TEAM-1 Вход', url: 'https://git.example.org/pr/270', to: 'master' });
    expect(seen).toEqual({ workspace: 'CLOUD', repository: 'gate', title: 'TEAM-1 Вход', description: 'Описание', source_branch: 'feature/TEAM-1', destination_branch: 'master' });
  });

  it('reads the state of a pull request: reviewers with their marks and comments with a flat thread of replies', async () => {
    const calls: unknown[] = [];
    const scm = createScmMcp(async (server, tool, args) => {
      calls.push({ server, tool, args });
      // Так отвечает настоящий сервер (PR #262): оценка в скобках у имени, ответы вложены.
      return {
        id: 262,
        title: 'TEAM-1 Вход',
        state: 'OPEN',
        author: 'Автор PR',
        web_url: 'https://git.example.org/pr/262',
        reviewers: ['Ревьюер Один (APPROVED)', 'Ревьюер Два'],
        active_comments: [
          {
            id: 7930,
            author: 'Ревьюер Один',
            text: 'Добавим дебаг логи?',
            created_on: '2026-09-22T08:24:39.280Z',
            is_inline: true,
            file_path: 'src/A.java',
            line_number: 182,
            state: 'OPEN',
            replies: [{ id: 7938, author: 'Автор PR', text: 'Лог уже есть', created_on: '2026-09-22T09:36:34.498Z', replies: [{ id: 7940, author: 'Ревьюер Один', text: 'Ок', created_on: '2026-09-22T10:00:00.000Z' }] }],
          },
          { id: 7929, author: 'Ревьюер Один', text: 'Добавил ключи в k8s?', created_on: '2026-09-22T08:22:48.798Z', is_inline: false, state: 'OPEN' },
        ],
      };
    }, contours);
    const pr = await scm.pullRequest(ref, 262);
    expect(pr).toMatchObject({ id: 262, state: 'OPEN', author: 'Автор PR', url: 'https://git.example.org/pr/262' });
    expect(pr.reviewers).toEqual([
      { name: 'Ревьюер Один', status: 'APPROVED' },
      { name: 'Ревьюер Два', status: 'UNAPPROVED' },
    ]);
    expect(pr.comments.map((c) => [c.id, c.file, c.line, c.replies.map((r) => r.id)])).toEqual([
      [7930, 'src/A.java', 182, [7938, 7940]],
      [7929, null, null, []],
    ]);
    expect(calls[0]).toEqual({ server: 'bitbucket', tool: 'get_pull_request', args: { workspace: 'CLOUD', repository: 'gate', pull_request_id: 262, include_file_changes: false, comment_limit: 100 } });
  });

  it('finds the newest pull request of a branch in any state', async () => {
    const scm = createScmMcp(
      async () => ({
        pull_requests: [
          { id: 250, title: 'TEAM-1 Старый', source_branch: 'feature/TEAM-1', state: 'DECLINED' },
          { id: 262, title: 'TEAM-1 Вход', source_branch: 'feature/TEAM-1', state: 'MERGED' },
          { id: 270, title: 'TEAM-2 Другое', source_branch: 'feature/TEAM-2', state: 'OPEN' },
        ],
      }),
      contours,
    );
    expect(await scm.findPullRequest(ref, 'feature/TEAM-1')).toMatchObject({ id: 262, title: 'TEAM-1 Вход' });
    expect(await scm.findPullRequest(ref, 'feature/TEAM-3')).toBeNull();
  });

  it('replies in the thread of a pull request comment', async () => {
    const calls: unknown[] = [];
    const scm = createScmMcp(async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { id: 8001 };
    }, contours);
    await scm.reply(ref, 262, 7929, 'Да, ключи в k8s-ansible');
    expect(calls).toEqual([
      { server: 'bitbucket', tool: 'add_comment', args: { workspace: 'CLOUD', repository: 'gate', pull_request_id: 262, parent_comment_id: 7929, comment_text: 'Да, ключи в k8s-ansible' } },
    ]);
  });

  it('refuses a contour without a Bitbucket server so requests never cross contours', async () => {
    const scm = createScmMcp(async () => ({}), contours);
    await expect(scm.openPullRequests({ ...ref, contour: 'core' }, 'x')).rejects.toThrow('не настроен MCP-сервер Bitbucket');
  });
});

describe('Confluence port over MCP', () => {
  /** Как confluence_get_page отвечает с include_metadata: тело markdown внутри metadata. */
  const PAGE = {
    metadata: {
      id: '639598705',
      title: 'Вынос входа по телефону в api',
      url: 'https://wiki.example.org/pages/viewpage.action?pageId=639598705',
      space: { key: 'TEAM', name: 'Команда' },
      version: 51,
      attachments: [],
      content: { value: '# Бизнес-контекст\n\nТекст страницы', format: 'markdown' },
    },
  };
  /** Как confluence_search отвечает на CQL: в content только начало текста. */
  const HIT = { id: '639598705', title: 'Вынос входа по телефону в api', space: { key: 'TEAM' }, version: 51, content: { value: 'Начало текста', format: 'view' } };

  it('reads a page with its version and markdown body from the metadata of the answer', () => {
    expect(toPage(PAGE)).toEqual({ id: '639598705', title: PAGE.metadata.title, space: 'TEAM', version: 51, url: PAGE.metadata.url, markdown: '# Бизнес-контекст\n\nТекст страницы' });
  });

  it('finds a page by its exact title and reads the whole body, not the search excerpt', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const wiki = createWikiMcp(async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 'confluence_search') return [{ ...HIT, id: '1', title: 'Вынос входа по телефону в api (черновик)' }, HIT];
      return PAGE;
    });
    expect((await wiki.findPage('TEAM', HIT.title))?.markdown).toBe('# Бизнес-контекст\n\nТекст страницы');
    expect(calls.map(([tool]) => tool)).toEqual(['confluence_search', 'confluence_get_page']);
    expect(calls[0]?.[1].query).toBe('type = page AND space = "TEAM" AND title = "Вынос входа по телефону в api"');
    expect(calls[1]?.[1]).toEqual({ page_id: '639598705', convert_to_markdown: true, include_metadata: true });
    expect(await createWikiMcp(async () => []).findPage('TEAM', 'Нет такой')).toBeNull();
  });

  it('creates and updates pages in markdown, the update with a version comment', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const wiki = createWikiMcp(async (tool, args) => {
      calls.push([tool, args]);
      return { page: { id: '7001', url: 'https://wiki.example.org/7001' } };
    });
    expect(await wiki.createPage({ space: 'TEAM', title: 'Новая', parentId: '42', markdown: '# Текст' })).toEqual({ id: '7001', url: 'https://wiki.example.org/7001' });
    await wiki.updatePage({ id: '7001', title: 'Новая', markdown: '# Текст 2', comment: 'TEAM-8: правка' });
    expect(calls).toEqual([
      ['confluence_create_page', { space_key: 'TEAM', title: 'Новая', content: '# Текст', content_format: 'markdown', parent_id: '42' }],
      ['confluence_update_page', { page_id: '7001', title: 'Новая', content: '# Текст 2', content_format: 'markdown', version_comment: 'TEAM-8: правка' }],
    ]);
  });
});
