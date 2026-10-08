/**
 * Эталонные задачи: pnpm reference [DEMO-1|DEMO-2] [--script]. Демо во временной папке на своем порту проходит учебные
 * задачи по промптам и скиллам рабочей папки Task Pilot, еще не закоммиченным тоже: подтверждения принимает само, на
 * вопросы агента отвечает заготовкой и сверяет итог с ожидаемым. Агенты настоящие, CLI claude тратит лимит подписки
 * (около $1.5 за обе задачи); с --script вместо них сценарный агент, так проверяется сам прогон эталонов. Итог
 * печатается и сохраняется в .data/reference. Код выхода 1 - какая-то проверка не прошла.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './config.ts';
import { api, freePort, startDemo, type Child } from './demo/harness.ts';
import type { RunView } from './engine/engine.ts';
import type { RunTimingDto } from '@task-pilot/api-types';

/** Что известно об итоге эталонного прогона. */
export interface ReferenceFacts {
  status: string;
  context: Record<string, unknown>;
  /** Сколько вопросов агенты задали владельцу. */
  questions: number;
  /** Текст плана из task.analyze; null - плана нет. */
  plan: string | null;
}

/** Проверка итога: что проверяется и прошла ли; agent - имеет смысл только с настоящим агентом, сценарный так не умеет. */
export interface ReferenceCheck {
  name: string;
  ok: boolean;
  agent?: boolean;
}

/** Эталонная задача демо: пресет, ненужные шаги, ответ на вопрос агента и проверки итога. */
export interface Reference {
  key: string;
  title: string;
  preset: string;
  skip: string[];
  answer: string;
  checks(f: ReferenceFacts): ReferenceCheck[];
}

interface TestReport {
  failures?: number;
  errors?: number;
  changedTests?: { executed: boolean }[];
}

/** Эталоны: DEMO-1 - от плана до PR без вопросов, DEMO-2 - анализ, который должен спросить владельца. */
export const REFERENCES: Reference[] = [
  {
    key: 'DEMO-1',
    title: 'разность до PR',
    preset: 'code-pr',
    skip: [],
    answer: 'Решай по описанию задачи и критериям приемки.',
    checks: (f) => {
      const report = f.context.testReport as TestReport | undefined;
      return [
        { name: 'прогон дошел до конца', ok: f.status === 'completed' },
        { name: 'сборка и тесты зеленые', ok: !!report && report.failures === 0 && report.errors === 0 },
        { name: 'новый тест есть и выполнился', ok: !!report?.changedTests?.some((t) => t.executed) },
        { name: 'PR создан', ok: typeof (f.context.pr as { id?: unknown } | undefined)?.id === 'number' },
        { name: 'агент не спрашивал владельца: в задаче все сказано', ok: f.questions === 0 },
      ];
    },
  },
  {
    key: 'DEMO-2',
    title: 'вопрос при анализе',
    preset: 'code-pr',
    skip: ['code.implement', 'code.verify', 'code.publish'],
    answer: 'При делении на ноль бросать ArithmeticException с понятным сообщением.',
    checks: (f) => [
      { name: 'прогон дошел до конца', ok: f.status === 'completed' },
      // Сценарный агент на любую задачу отвечает одним планом без вопросов: эти проверки - только для настоящего.
      { name: 'агент спросил владельца о делении на ноль', ok: f.questions > 0, agent: true },
      { name: 'план учел ответ: ArithmeticException', ok: /ArithmeticException/.test(f.plan ?? ''), agent: true },
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Сколько ждать один эталон: агенты пишут план, код и тесты. */
const TIMEOUT_MS = 40 * 60_000;

/** Проводит эталонную задачу через демо: подтверждает шаги, отвечает на вопросы, ждет конца. */
async function drive(port: number, ref: Reference): Promise<{ facts: ReferenceFacts; costUsd: number; ms: number }> {
  const started = Date.now();
  const { id } = await api<{ id: string }>(port, 'POST', `/api/tasks/${ref.key}/open`, { presetId: ref.preset });
  for (const step of ref.skip) await api(port, 'PATCH', `/api/runs/${id}/steps/${step}`, { selected: false });
  await api(port, 'POST', `/api/runs/${id}/start`, {});
  const decided = new Set<string>();
  let questions = 0;
  for (;;) {
    const view = await api<RunView>(port, 'GET', `/api/runs/${id}`);
    if (view.approval?.blocked) throw new Error(`${ref.key}: подтверждение шага ${view.approval.stepId} заблокировано линтером`);
    if (view.approval && !decided.has(view.approval.id)) {
      decided.add(view.approval.id);
      await api(port, 'POST', `/api/approvals/${view.approval.id}`, { decision: 'approve' });
    }
    for (const q of view.questions) {
      questions++;
      await api(port, 'POST', `/api/questions/${q.id}/answer`, { answer: ref.answer });
    }
    if (!view.active && (view.run.status === 'completed' || view.run.status === 'failed')) {
      const plan = (view.context.plan as { file?: string } | undefined)?.file;
      const timing = await api<RunTimingDto>(port, 'GET', `/api/runs/${id}/timing`);
      return {
        facts: { status: view.run.status, context: view.context, questions, plan: plan && existsSync(plan) ? readFileSync(plan, 'utf8') : null },
        costUsd: timing.costUsd,
        ms: Date.now() - started,
      };
    }
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`${ref.key}: прогон не кончился за ${TIMEOUT_MS / 60_000} минут, статус ${view.run.status}`);
    await sleep(2000);
  }
}

async function main(argv: string[]): Promise<number> {
  const scripted = argv.includes('--script');
  const keys = argv.filter((a) => !a.startsWith('--'));
  const refs = keys.length ? REFERENCES.filter((r) => keys.includes(r.key)) : REFERENCES;
  if (!refs.length) {
    console.error(`Эталонов ${keys.join(', ')} нет, есть: ${REFERENCES.map((r) => r.key).join(', ')}`);
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), 'task-pilot-reference-'));
  const port = await freePort();
  let demo: Child | null = null;
  const results: { key: string; title: string; checks: ReferenceCheck[]; skipped: string[]; costUsd: number; minutes: number; error: string | null }[] = [];
  try {
    demo = await startDemo({ root, port, scripted });
    console.log(`Эталонные задачи${scripted ? ' со сценарным агентом' : ' с настоящими агентами'}: ${refs.map((r) => r.key).join(', ')}`);
    for (const ref of refs) {
      try {
        const r = await drive(port, ref);
        const checks = ref.checks(r.facts).filter((c) => !(scripted && c.agent));
        const skipped = ref.checks(r.facts).filter((c) => scripted && c.agent).map((c) => c.name);
        results.push({ key: ref.key, title: ref.title, checks, skipped, costUsd: r.costUsd, minutes: Math.round(r.ms / 6000) / 10, error: null });
      } catch (e) {
        results.push({ key: ref.key, title: ref.title, checks: [], skipped: [], costUsd: 0, minutes: 0, error: e instanceof Error ? e.message : String(e) });
      }
      const last = results.at(-1)!;
      console.log(`${last.key} (${last.title}): $${last.costUsd.toFixed(2)}, ${last.minutes} мин`);
      if (last.error) console.log(`  ✗ ${last.error}`);
      for (const c of last.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}`);
      for (const name of last.skipped) console.log(`  - ${name}: проверяется только с настоящим агентом`);
    }
  } finally {
    await demo?.stop();
    rmSync(root, { recursive: true, force: true });
  }
  const dir = join(ROOT, '.data', 'reference');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}${scripted ? '-script' : ''}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.error || r.checks.some((c) => !c.ok)).length;
  console.log(`Итог: эталонов ${results.length}, не прошли ${failed}, всего $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}. Отчет: ${file}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error('Эталонные задачи не прошли:', e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
