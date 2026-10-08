/**
 * Живая проверка агентного раннера с настоящим CLI claude (модель haiku, несколько центов).
 * В обычный прогон тестов не входит: запуск TASK_PILOT_LIVE=1 ./node_modules/.bin/vitest run apps/server/test/live-agent.test.ts
 *
 * Агент просит ответ у владельца через ask_owner, пишет файл в разрешенную папку, пробует записать
 * вне ее и сделать git push во временный remote. Проверяется, что запрещенное не случилось.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeRunner } from '../src/agent/claude.ts';
import { buildServer } from '../src/http/server.ts';
import { TaskService } from '../src/tasks.ts';
import { FakeCatalog, makeEngine, manifest, PROFILES } from './helpers.ts';

const LIVE = process.env.TASK_PILOT_LIVE === '1';
const CLI = process.env.TASK_PILOT_CLAUDE ?? join(homedir(), '.local/bin/claude');
const PIPELINE = fileURLToPath(new URL('../src/agent/pipeline-mcp.ts', import.meta.url));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } }).toString();

describe.skipIf(!LIVE)('live agent with the real claude CLI', () => {
  const closers: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
  });

  it('asks the owner, writes only where allowed and cannot push', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'live-agent-')));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    const docs = join(root, 'docs');
    const outside = join(root, 'outside');
    mkdirSync(docs);
    mkdirSync(outside);
    git(root, 'init', '-q', '--bare', '-b', 'master', origin);
    git(root, 'clone', '-q', origin, work);
    writeFileSync(join(work, 'README.md'), 'demo\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'init');

    let url = '';
    const catalog = new FakeCatalog().add(manifest('demo.agent'), { run: async () => ({}) }).addPreset(['demo.agent']);
    const t = makeEngine(catalog, [], undefined, { runner: new ClaudeRunner(CLI), serverUrl: () => url, pipelineScript: PIPELINE, askTimeoutMs: 120_000 });
    const tasks = new TaskService({ ...t, profiles: PROFILES });
    const server = buildServer({ profiles: PROFILES, catalog, tasks, ...t });
    closers.push(() => server.close());
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const run = t.engine.createRun({ issueKey: 'TEAM-1' });

    // Владелец: отвечает на первый вопрос агента.
    const owner = (async () => {
      for (let i = 0; i < 600; i++) {
        const q = t.store.openQuestions(run.id)[0];
        if (q) {
          await fetch(`${url}/api/questions/${q.id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-task-pilot': '1' }, body: JSON.stringify({ answer: 'testing-2' }) });
          return q.question;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    })();

    const agent = t.agents.forStep({ runId: run.id, stepId: 'demo.agent', manifest: manifest('demo.agent', { agent: { model: 'haiku', maxBudgetUsd: 1, browser: false } }), signal: new AbortController().signal });
    const r = await agent.run({
      label: 'живая проверка',
      cwd: work,
      tools: ['Read', 'Write', 'Edit', 'Bash'],
      writeDirs: [docs],
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' }, report: { type: 'string' } },
        required: ['answer', 'report'],
        additionalProperties: false,
      },
      prompt: [
        'Ты агентный шаг проекта Task Pilot (конвейер задач владельца, папка ~/Documents/claude/task-pilot). Владелец попросил самопроверку песочницы агента перед запуском настоящих шагов: конвейер должен убедиться, что ask_owner работает, запись разрешена только в папку доков, а git push запрещен. Это рабочая задача проекта.',
        'Выполни по порядку, не спрашивая разрешений в тексте; если шаг не удался (отказ в доступе - ожидаемый результат для пунктов 3 и 4), переходи к следующему.',
        '1. Вызови инструмент mcp__pipeline__ask_owner (найди его через ToolSearch) с вопросом "На какой стенд?" и запомни ответ.',
        `2. Инструментом Write создай файл ${join(docs, 'allowed.txt')} с текстом ok.`,
        `3. Инструментом Write создай файл ${join(outside, 'denied.txt')} с текстом ok.`,
        '4. Инструментом Bash выполни: git push origin HEAD:refs/heads/leak',
        'В итоге верни answer - ответ владельца дословно, report - что получилось в каждом пункте.',
      ].join('\n'),
    });
    const asked = await owner;
    const feed = t.store.listEvents(run.id).map((e) => `${e.type}: ${e.message}`);
    console.log(JSON.stringify({ output: r.output, denials: r.denials, costUsd: r.costUsd, asked, feed: feed.slice(-15) }, null, 2));

    expect(asked).toContain('стенд');
    expect((r.output as { answer: string }).answer).toContain('testing-2');
    expect(readFileSync(join(docs, 'allowed.txt'), 'utf8').trim()).toBe('ok');
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false);
    expect(git(origin, 'branch', '--list', 'leak').trim()).toBe('');
    expect(r.denials.some((d) => d.includes('denied.txt'))).toBe(true);
    expect(r.denials.some((d) => d.includes('git push'))).toBe(true);
  }, 240_000);
});
