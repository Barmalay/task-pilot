import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepModule } from '@task-pilot/step-kit';
import { ROOT } from '../src/config.ts';
import { seatbeltSandbox } from '../src/integrations/sandbox.ts';
import { createShell } from '../src/integrations/shell.ts';
import { journalOf } from '../src/journal.ts';
import { checkPilot, checkSummary, copyPilotTree } from '../src/pilot.ts';
import { FakeCatalog, makeEngine, manifest } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

describe('journal of a run', () => {
  it('collects the owner corrections, answered questions, failures, denials and loop rounds, but not stops', async () => {
    let fail = true;
    const gated: StepModule = {
      async preview() {
        return { title: 'Коммит, пуш и PR', actions: [], payload: {} };
      },
      async prepare() {
        return {};
      },
      async run() {
        return {};
      },
    };
    const flaky: StepModule = {
      async run() {
        if (fail) throw new Error('Сборка упала: тест CalculatorTest, токен secret-token-123');
        return {};
      },
    };
    const cat = new FakeCatalog()
      .add(manifest('code.publish', { title: 'Коммит', gate: 'before' }), gated)
      .add(manifest('ci.wait', { title: 'Сборка ветки' }), flaky)
      .addPreset(['code.publish', 'ci.wait']);
    const { engine, store, bus, redact } = makeEngine(cat, ['secret-token-123']);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    await engine.decide(engine.view(run.id).approval!.id, 'rework', 'Заголовок о доработке');
    await engine.decide(engine.view(run.id).approval!.id, 'reject', 'не сейчас');
    await engine.start(run.id);
    await engine.decide(engine.view(run.id).approval!.id, 'approve');
    fail = false;
    store.updateStep(run.id, 'ci.wait', { status: 'failed', error: 'Остановлено владельцем' });
    bus.emitEvent({ runId: run.id, stepId: 'ci.wait', type: 'step.status', message: 'Сборка ветки: упал. Остановлено владельцем', data: { status: 'failed', error: 'Остановлено владельцем' } });
    bus.emitEvent({ runId: run.id, stepId: 'qa.fix', type: 'agent.denied', message: 'отказано', data: { denials: ['Bash(curl x)'] } });
    bus.emitEvent({ runId: run.id, stepId: 'qa.fix', type: 'loop.restart', message: 'круг', data: { round: 1, max: 3, steps: ['code.verify', 'qa.fix'] } });
    const answered = store.createQuestion({ runId: run.id, stepId: 'qa.stand', sessionId: null, question: 'Какой стенд?', options: [] });
    store.answerQuestion(answered.id, 'stable');
    store.createQuestion({ runId: run.id, stepId: 'qa.stand', sessionId: null, question: 'Без ответа?', options: [] });

    const j = journalOf(store, run.id, (id) => cat.entry(id)?.manifest.title ?? id, redact);
    expect(j.corrections.map((x) => [x.stepId, x.step, x.decision, x.title, x.comment])).toEqual([
      ['code.publish', 'Коммит', 'rework', 'Коммит, пуш и PR', 'Заголовок о доработке'],
      ['code.publish', 'Коммит', 'rejected', 'Коммит, пуш и PR', 'не сейчас'],
    ]);
    expect(j.failures.map((x) => [x.stepId, x.error])).toEqual([['ci.wait', 'Сборка упала: тест CalculatorTest, токен ***']]);
    expect(j.questions.map((x) => [x.stepId, x.question, x.answer])).toEqual([['qa.stand', 'Какой стенд?', 'stable']]);
    expect(j.denials.map((x) => [x.stepId, x.tools])).toEqual([['qa.fix', ['Bash(curl x)']]]);
    expect(j.loops.map((x) => [x.stepId, x.round, x.max])).toEqual([['qa.fix', 1, 3]]);
    // Запись ведет к своему событию ленты: по нему экран прогона открывает подробности.
    expect([...j.corrections, ...j.failures, ...j.denials, ...j.loops].map((x) => store.getEvent(run.id, x.eventId!)?.type)).toEqual([
      'approval.decided',
      'approval.decided',
      'step.status',
      'agent.denied',
      'loop.restart',
    ]);
    expect(j.questions[0]!.eventId).toBeUndefined();
  });

  it('records a retry of a failed step with the note to the agent and the error it answers, masking secrets', async () => {
    let fail = true;
    const cat = new FakeCatalog()
      .add(manifest('qa.fix', { title: 'Доработка по тесту', kind: 'agent' }), {
        async run() {
          if (fail) throw new Error('AC 3 кодом не исправить');
          return {};
        },
      })
      .addPreset(['qa.fix']);
    const { engine, store, redact } = makeEngine(cat, ['secret-token-123']);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    fail = false;
    await engine.retry(run.id, 'qa.fix', 'Окружение поправил, токен secret-token-123');
    const j = journalOf(store, run.id, (id) => cat.entry(id)?.manifest.title ?? id, redact);
    expect(j.corrections.map((x) => [x.stepId, x.step, x.decision, x.title, x.comment])).toEqual([['qa.fix', 'Доработка по тесту', 'retry', 'AC 3 кодом не исправить', 'Окружение поправил, токен ***']]);
  });
});

describe('check of Task Pilot edits', () => {
  it('copies the working tree without dependencies, data and personal files, linking each dependency', () => {
    const src = temp('pilot-src-');
    for (const f of ['steps/a/prompt.md', 'node_modules/vitest/index.js', 'node_modules/.bin/vitest', '.data/task-pilot.db', '.claude/notes.md', 'apps/server/node_modules/zod/index.js', 'x.log']) {
      mkdirSync(join(src, f, '..'), { recursive: true });
      writeFileSync(join(src, f), f);
    }
    const dest = copyPilotTree(src, join(temp('pilot-dest-'), 'copy'));
    expect(readFileSync(join(dest, 'steps/a/prompt.md'), 'utf8')).toBe('steps/a/prompt.md');
    expect(['.data', '.claude', 'x.log'].map((f) => existsSync(join(dest, f)))).toEqual([false, false, false]);
    expect(lstatSync(join(dest, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(dest, 'node_modules/vitest')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dest, 'apps/server/node_modules/zod')).isSymbolicLink()).toBe(true);
  });

  it('does not copy the .git file of a git worktree: git in the copy must not reach the real repository', () => {
    const src = temp('pilot-worktree-');
    writeFileSync(join(src, '.git'), 'gitdir: /somewhere/.git/worktrees/task-pilot-refactor\n');
    mkdirSync(join(src, 'steps'), { recursive: true });
    writeFileSync(join(src, 'steps', 'x.ts'), 'x');
    const dest = copyPilotTree(src, join(temp('pilot-dest-'), 'copy'));
    expect(existsSync(join(dest, 'steps', 'x.ts'))).toBe(true);
    expect(existsSync(join(dest, '.git'))).toBe(false);
  });

  it('sums up the output of vitest and tsc for the owner', () => {
    expect(checkSummary('vitest run steps', 0, ' Test Files  17 passed (17)\n      Tests  167 passed (167)\n', false)).toBe('Тесты: пройдено 167');
    expect(checkSummary('vitest run steps', 1, '      Tests  2 failed | 164 passed | 1 skipped (167)\n', false)).toBe('Тесты: пройдено 164, упало 2, пропущено 1');
    expect(checkSummary('vitest run steps', 1, 'Error: Cannot find module', false)).toBe('Тесты не запустились, код 1');
    expect(checkSummary('tsc -p steps --noEmit', 2, "a.ts(1,7): error TS2322: x\nb.ts(2,1): error TS2304: y\n", false)).toBe('Ошибок типов: 2');
    expect(checkSummary('tsc -p steps --noEmit', 0, '', false)).toBe('Типы в порядке');
    expect(checkSummary('vitest run steps', 1, '', true)).toBe('Не уложилось в 10 мин');
  });

  it.skipIf(!existsSync('/usr/bin/sandbox-exec'))(
    'runs the step tests on a sandboxed copy with the edit and leaves the working tree untouched',
    async () => {
      const shell = createShell({ sandbox: seatbeltSandbox({ home: homedir(), dataDir: temp('pilot-data-') }) });
      const file = 'packages/step-kit/src/diff.ts';
      const original = readFileSync(join(ROOT, file), 'utf8');
      const green = await checkPilot({ root: ROOT, shell, overlay: {}, tests: ['packages/step-kit/test/diff.test.ts'] });
      expect(green.results.map((r) => [r.ok, r.summary])).toEqual([
        [true, 'Типы в порядке'],
        [true, expect.stringMatching(/^Тесты: пройдено \d+$/)],
      ]);
      const broken = original.replace('if (!changed.length) return [];', 'return [];');
      const red = await checkPilot({ root: ROOT, shell, overlay: { [file]: broken }, tests: ['packages/step-kit/test/diff.test.ts'] });
      expect(red.ok).toBe(false);
      expect(red.results[1]?.summary).toMatch(/^Тесты: пройдено \d+, упало \d+$/);
      expect(readFileSync(join(ROOT, file), 'utf8')).toBe(original);
      await expect(checkPilot({ root: ROOT, shell, overlay: { '../outside.md': 'x' }, tests: [] })).rejects.toThrow('Путь ../outside.md вне Task Pilot');
    },
    60_000,
  );
});
