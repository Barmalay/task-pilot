import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eventDetails, toolCallOf } from '../src/feed.ts';
import { buildServer } from '../src/http/server.ts';
import { TaskService } from '../src/tasks.ts';
import { FakeCatalog, makeEngine, manifest, PROFILES } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SESSION = '0f5e8c6a-1b2c-4d3e-8f90-123456789abc';
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: unknown, structured?: unknown, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  ...(structured === undefined ? {} : { tool_use_result: structured }),
});

/** Журнал потока агента, как его пишет раннер: строки stream-json. */
function log(dataDir: string, lines: unknown[]): string {
  mkdirSync(join(dataDir, 'agent', SESSION), { recursive: true });
  const file = join(dataDir, 'agent', SESSION, 'stream.jsonl');
  writeFileSync(file, `${['not json', ...lines.map((l) => JSON.stringify(l))].join('\n')}\n`);
  return file;
}

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'feed-')));
  dirs.push(dir);
  return dir;
}

const PATCH = [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: [' class A {', '-  int x;', '+  int x = 1;', '+  int y;'] }];

describe('details of an agent tool call', () => {
  it('shows the diff of an edit with line numbers from the log', async () => {
    const file = log(temp(), [
      use('t1', 'Edit', { file_path: '/w/A.java', old_string: '  int x;', new_string: '  int x = 1;\n  int y;' }),
      result('t1', 'The file /w/A.java has been updated.', { filePath: '/w/A.java', oldString: '  int x;', newString: '  int x = 1;', originalFile: 'class A {\n  int x;\n}', structuredPatch: PATCH }),
    ]);
    expect(await toolCallOf(file, 't1')).toEqual({
      tool: 'Edit',
      input: { file_path: '/w/A.java', old_string: '  int x;', new_string: '  int x = 1;\n  int y;' },
      result: { isError: false, text: 'The file /w/A.java has been updated.', filePath: '/w/A.java', change: 'update', patch: PATCH },
    });
  });

  it('shows a new file as added lines and the tail of a long command output', async () => {
    const out = `${'x'.repeat(25_000)}\nBUILD SUCCESS`;
    const file = log(temp(), [
      use('w1', 'Write', { file_path: '/w/B.java', content: 'class B {}\n' }),
      result('w1', 'File created successfully at: /w/B.java', { type: 'create', filePath: '/w/B.java', content: 'class B {}\n', structuredPatch: [] }),
      use('b1', 'Bash', { command: 'mvn -o test', description: 'Сборка' }),
      result('b1', out, { stdout: out, stderr: '', interrupted: false, isImage: false }),
    ]);
    expect((await toolCallOf(file, 'w1'))?.result).toMatchObject({ change: 'create', filePath: '/w/B.java', patch: [{ newStart: 1, newLines: 2, lines: ['+class B {}', '+'] }] });
    const bash = (await toolCallOf(file, 'b1'))!.result!;
    expect(bash.stdout).toMatch(/^\.\.\. обрезано, еще \d+ символов\n/);
    expect(bash.stdout!.endsWith('BUILD SUCCESS')).toBe(true);
    expect(bash).toMatchObject({ clipped: true, stderr: '', interrupted: false });
  });

  it('lists the files a search found and keeps the error of a failed call', async () => {
    const file = log(temp(), [
      use('g1', 'Grep', { pattern: 'PassportToken', path: '/w/src' }),
      result('g1', 'Found 2 files', { filenames: ['/w/src/A.java', '/w/src/B.java'], numFiles: 2 }),
      use('e1', 'Bash', { command: 'git push' }),
      result('e1', [{ type: 'text', text: 'Permission to use Bash with command git push has been denied.' }], undefined, true),
    ]);
    expect((await toolCallOf(file, 'g1'))?.result).toMatchObject({ files: ['/w/src/A.java', '/w/src/B.java'] });
    expect((await toolCallOf(file, 'e1'))?.result).toEqual({ isError: true, text: 'Permission to use Bash with command git push has been denied.' });
    expect(await toolCallOf(file, 'nope')).toBeNull();
    expect(await toolCallOf(join(temp(), 'missing.jsonl'), 'g1')).toBeNull();
  });
});

describe('details of a feed event', () => {
  it('opens the call of an agent tool, the content of an approval and a question with its answer', async () => {
    const { engine, store, bus, dataDir } = makeEngine(new FakeCatalog().add(manifest('code.publish', { gate: 'publish' }), {
      async preview() {
        return { title: 'Коммит, пуш и PR', actions: ['Коммит в feature/TEAM-1'], payload: {}, texts: [{ id: 'msg', label: 'Сообщение коммита', text: 'TEAM-1 Вход', publish: true }] };
      },
      async run() {
        return {};
      },
    }).addPreset(['code.publish']));
    log(dataDir, [use('t1', 'Edit', { file_path: '/w/A.java', old_string: 'a', new_string: 'b' }), result('t1', 'ok', { filePath: '/w/A.java', structuredPatch: PATCH })]);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const tool = bus.emitEvent({ runId: run.id, stepId: 'code.implement', type: 'agent.tool', message: 'Edit: A.java', data: { tool: 'Edit', session: SESSION, toolUseId: 't1' } });
    const old = bus.emitEvent({ runId: run.id, stepId: 'code.implement', type: 'agent.tool', message: 'Edit: A.java' });
    const q = store.createQuestion({ runId: run.id, stepId: 'qa.stand', sessionId: null, question: 'Какой стенд?', options: ['stable'] });
    store.answerQuestion(q.id, 'stable');
    const asked = bus.emitEvent({ runId: run.id, stepId: 'qa.stand', type: 'question.asked', message: 'Агент спрашивает', data: { questionId: q.id } });
    const requested = store.listEvents(run.id).find((e) => e.type === 'approval.requested')!;

    expect(await eventDetails(store, dataDir, tool)).toMatchObject({ kind: 'tool', call: { tool: 'Edit', result: { patch: PATCH } } });
    expect(await eventDetails(store, dataDir, old)).toMatchObject({ kind: 'none', reason: expect.stringContaining('нет ссылки на журнал агента') });
    expect(await eventDetails(store, dataDir, requested)).toMatchObject({
      kind: 'approval',
      approval: { status: 'pending', preview: { title: 'Коммит, пуш и PR', texts: [{ label: 'Сообщение коммита', text: 'TEAM-1 Вход' }] } },
    });
    expect(await eventDetails(store, dataDir, asked)).toMatchObject({ kind: 'question', question: { question: 'Какой стенд?', options: ['stable'], status: 'answered', answer: 'stable' } });
  });

  it('gives the whole feed page by page and the details of one event over the API', async () => {
    const catalog = new FakeCatalog().add(manifest('s.one'), { run: async () => ({}) }).addPreset(['s.one']);
    const deps = makeEngine(catalog);
    const server = buildServer({ ...deps, profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }) });
    const LOCAL = { host: '127.0.0.1:5176', 'x-task-pilot': '1' };
    try {
      const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
      for (let i = 0; i < 5; i++) deps.bus.emitEvent({ runId: run.id, stepId: 's.one', type: 'step.log', message: `лог ${i}`, data: { i } });
      const newest = (await server.inject({ method: 'GET', url: `/api/runs/${run.id}/feed?limit=3`, headers: LOCAL })).json() as { events: { id: number; message: string }[]; more: boolean };
      expect(newest.events.map((e) => e.message)).toEqual(['лог 2', 'лог 3', 'лог 4']);
      expect(newest.more).toBe(true);
      const older = (await server.inject({ method: 'GET', url: `/api/runs/${run.id}/feed?limit=3&before=${newest.events[0]!.id}`, headers: LOCAL })).json() as { events: { message: string }[]; more: boolean };
      expect(older.events.map((e) => e.message)).toEqual(['Прогон TEAM-1: пресет "Пресет"', 'лог 0', 'лог 1']);
      expect(older.more).toBe(false);
      const details = await server.inject({ method: 'GET', url: `/api/runs/${run.id}/events/${newest.events[2]!.id}`, headers: LOCAL });
      expect(details.json()).toEqual({ kind: 'data', data: { i: 4 } });
      expect((await server.inject({ method: 'GET', url: `/api/runs/other/events/${newest.events[2]!.id}`, headers: LOCAL })).statusCode).toBe(404);
      expect((await server.inject({ method: 'GET', url: '/api/runs/unknown/feed', headers: LOCAL })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
