import { describe, expect, it } from 'vitest';
import type { AskDto } from '@task-pilot/api-types';
import { AgentError, type AgentRunner } from '../src/agent/claude.ts';
import { ASK_STEP, askPrompt, localTime } from '../src/ask.ts';
import { buildServer } from '../src/http/server.ts';
import { Store } from '../src/store/db.ts';
import { TaskService } from '../src/tasks.ts';
import { FakeCatalog, makeEngine, manifest, PROFILES } from './helpers.ts';

/** Исполнитель агента теста: отвечает текстом по заданию и запоминает аргументы запусков; fail - падает с ошибкой. */
function runner(answer: (prompt: string) => string, fail?: string) {
  const calls: string[][] = [];
  const run: AgentRunner['run'] = async (input) => {
    calls.push(input.args);
    const sessionId = input.args[input.args.indexOf('--session-id') + 1]!;
    input.onEvent({ kind: 'init', sessionId, model: 'test' });
    // Вызов инструмента: у тихого агента он в ленту не попадает.
    input.onEvent({ kind: 'tool', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/steps/ci.wait/index.ts' } });
    if (fail) throw new AgentError(fail, { sessionId, isError: true, subtype: 'error', text: '', output: null, costUsd: 0.07, durationMs: 1, turns: 1, denials: [] });
    return { sessionId, isError: false, subtype: 'success', text: answer(input.args[input.args.indexOf('-p') + 1]!), output: null, costUsd: 0.12, durationMs: 5, turns: 2, denials: [] };
  };
  return { runner: { run }, calls };
}

function setup(o: { answer?: (prompt: string) => string; fail?: string } = {}) {
  const fake = runner(o.answer ?? (() => '**Шаг ждет сборку.** Проверьте план в Bamboo'), o.fail);
  const cat = new FakeCatalog().add(manifest('ci.wait', { title: 'Сборка' }), { run: async () => ({}) }).addPreset(['ci.wait']);
  const t = makeEngine(cat, ['secret-token-value-123'], undefined, { runner: fake.runner });
  const run = t.engine.createRun({ issueKey: 'TEAM-1' });
  // События вопроса и работы агента в ленте прогона: у тихого агента второго нет.
  const types = () => t.store.eventsPage(run.id, null, 100).events.map((e) => e.type).filter((type) => type.startsWith('ask.') || type.startsWith('agent.'));
  return { ...t, cat, run, calls: fake.calls, types };
}

describe('question of the owner about a run', () => {
  it('builds the task of the agent from the steps, the waiting, the feed, the code paths, earlier answers and the question', () => {
    const at = (h: number, m: number) => new Date(2026, 8, 25, h, m, 5).toISOString();
    const prompt = askPrompt({
      run: { id: 'r', issueKey: 'TEAM-2860', repoId: 'demo', standId: 'stable', presetId: 'full', dryRun: false, status: 'waiting', createdAt: at(10, 0), updatedAt: at(10, 0) },
      title: (id) => ({ 'git.prepare': 'Ветка', 'ci.wait': 'Сборка' })[id] ?? id,
      steps: [
        { runId: 'r', stepId: 'git.prepare', position: 0, selected: true, status: 'succeeded', note: null, error: null, startedAt: at(10, 1), finishedAt: at(10, 2), feedback: null, retryNote: null, params: {} },
        { runId: 'r', stepId: 'ci.wait', position: 1, selected: true, status: 'waiting', note: 'Ждет сборку', error: null, startedAt: at(10, 3), finishedAt: null, feedback: null, retryNote: null, params: {} },
      ],
      waiting: { stepId: 'ci.wait', since: at(10, 3), event: { kind: 'build', plan: 'CLOUD-SSO', revision: 'abcdef1234' } as never },
      events: [{ id: 1, runId: 'r', stepId: 'ci.wait', ts: at(10, 4), type: 'step.log', message: 'Сборка\nв очереди', data: null }],
      earlier: [{ id: 'a', runId: 'r', question: 'Что с веткой?', status: 'answered', answer: 'Ветка готова', error: null, costUsd: 0.1, createdAt: at(10, 2), answeredAt: at(10, 2) }],
      question: 'Почему стоит сборка?',
      root: '/pilot',
      worktree: '/wt/TEAM-2860',
      now: new Date(2026, 8, 25, 10, 30, 0),
    });
    expect(prompt).toContain('Ничего не меняешь, команд не запускаешь и вопросов владельцу не задаешь');
    expect(prompt).toContain('Прогон: пресет full, статус waiting, репозиторий demo, стенд stable. Сейчас 2026-09-25 10:30:00');
    expect(prompt).toContain('1. git.prepare "Ветка": succeeded, начат 2026-09-25 10:01:05, закончен 2026-09-25 10:02:05');
    expect(prompt).toContain('2. ci.wait "Сборка": waiting, начат 2026-09-25 10:03:05; заметка: Ждет сборку');
    expect(prompt).toContain('Ожидание события: шаг ci.wait ждет с 2026-09-25 10:03:05, событие {"kind":"build","plan":"CLOUD-SSO","revision":"abcdef1234"}');
    // Событие ленты одной строкой, со временем и шагом.
    expect(prompt).toContain('2026-09-25 10:04:05 [ci.wait] step.log: Сборка в очереди');
    expect(prompt).toContain('- код шага: /pilot/steps/<id шага>/');
    expect(prompt).toContain('- рабочая папка задачи: /wt/TEAM-2860');
    expect(prompt).toContain('Вопрос: Что с веткой?\nОтвет: Ветка готова');
    expect(prompt).toContain('<вопрос>\nПочему стоит сборка?\n</вопрос>');
    expect(localTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
  });

  it('answers with a read-only agent and keeps the question, the answer and its cost at the run, with events but no agent work in the feed', async () => {
    const t = setup();
    const asked = t.asks.ask(t.run.id, '  Почему стоит сборка? Токен secret-token-value-123  ');
    expect(asked).toMatchObject({ status: 'pending', question: 'Почему стоит сборка? Токен ***' });
    await t.asks.settled();
    expect(t.asks.list(t.run.id)).toEqual([expect.objectContaining({ status: 'answered', answer: '**Шаг ждет сборку.** Проверьте план в Bamboo', costUsd: 0.12, error: null })]);
    expect(t.types()).toEqual(['ask.asked', 'ask.answered']);
    const args = t.calls[0]!;
    // Только чтение: встроенные инструменты - чтение и поиск, вопросы владельцу и отчеты о ходе закрыты, модель sonnet.
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,ToolSearch');
    expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(expect.arrayContaining(['mcp__pipeline__ask_owner', 'mcp__pipeline__report_progress']));
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.5');
    expect(args[args.indexOf('-p') + 1]).toContain('<вопрос>\nПочему стоит сборка? Токен ***\n</вопрос>');
    // Сессия ответа видна в журнале агентов прогона под своим шагом, а не под шагом прогона.
    expect(t.store.agentSessionsOf(t.run.id).map((s) => s.stepId)).toEqual([ASK_STEP]);
  });

  it('takes no second question while the agent answers and gives the earlier answers to the next one', async () => {
    const t = setup({ answer: (p) => (p.includes('<вопрос>\nА дальше?') ? 'Второй ответ' : 'Первый ответ') });
    t.asks.ask(t.run.id, 'Что с веткой?');
    expect(() => t.asks.ask(t.run.id, 'И еще?')).toThrow('Агент еще отвечает на прошлый вопрос');
    await t.asks.settled();
    t.asks.ask(t.run.id, 'А дальше?');
    await t.asks.settled();
    expect(t.asks.list(t.run.id).map((a) => a.answer)).toEqual(['Первый ответ', 'Второй ответ']);
    expect(t.calls[1]![t.calls[1]!.indexOf('-p') + 1]).toContain('Вопрос: Что с веткой?\nОтвет: Первый ответ');
  });

  it('closes the question with the error of the agent and its partial cost', async () => {
    const t = setup({ fail: 'Лимит расхода сессии исчерпан' });
    t.asks.ask(t.run.id, 'Почему стоит сборка?');
    await t.asks.settled();
    expect(t.asks.list(t.run.id)).toEqual([expect.objectContaining({ status: 'failed', answer: null, error: 'Лимит расхода сессии исчерпан', costUsd: 0.07 })]);
    expect(t.types()).toEqual(['ask.asked', 'ask.failed']);
  });

  it('fails the questions the agent did not answer before a restart of the server', () => {
    const store = new Store(':memory:');
    const run = store.createRun({ issueKey: 'TEAM-1', repoId: 'demo', standId: null, presetId: 'full', dryRun: false }, []);
    store.createAsk(run.id, 'Почему стоит?');
    store.markInterrupted();
    expect(store.asksOf(run.id)).toEqual([expect.objectContaining({ status: 'failed', error: 'Сервер перезапустился, пока агент отвечал: спросите снова' })]);
  });

  it('is available over the API: a question gets 201 and the list, an empty question 400, an unknown run 404', async () => {
    const t = setup();
    const server = buildServer({ ...t, profiles: PROFILES, catalog: t.cat, tasks: new TaskService({ ...t, profiles: PROFILES }) });
    const LOCAL = { host: '127.0.0.1:5176', 'x-task-pilot': '1' };
    try {
      const asked = await server.inject({ method: 'POST', url: `/api/runs/${t.run.id}/asks`, headers: LOCAL, payload: { question: 'Почему стоит сборка?' } });
      expect(asked.statusCode).toBe(201);
      await t.asks.settled();
      const list = (await server.inject({ method: 'GET', url: `/api/runs/${t.run.id}/asks`, headers: LOCAL })).json() as AskDto[];
      expect(list.map((a) => [a.question, a.status])).toEqual([['Почему стоит сборка?', 'answered']]);
      expect((await server.inject({ method: 'POST', url: `/api/runs/${t.run.id}/asks`, headers: LOCAL, payload: { question: '   ' } })).statusCode).toBe(400);
      expect((await server.inject({ method: 'GET', url: '/api/runs/nope/asks', headers: LOCAL })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
