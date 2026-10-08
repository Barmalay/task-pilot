import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Catalog } from '../src/catalog/catalog.ts';
import { ROOT } from '../src/config.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): { steps: string; pipelines: string } {
  // Внутри проекта: так динамический импорт модулей шагов идет тем же путем, что и у настоящих шагов.
  const base = resolve(ROOT, '.data');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'catalog-test-'));
  dirs.push(root);
  const steps = join(root, 'steps');
  const pipelines = join(root, 'pipelines');
  mkdirSync(steps);
  mkdirSync(pipelines);
  return { steps, pipelines };
}

function writeStep(stepsDir: string, dir: string, yaml: string, code?: string): void {
  mkdirSync(join(stepsDir, dir), { recursive: true });
  writeFileSync(join(stepsDir, dir, 'step.yaml'), yaml);
  if (code) writeFileSync(join(stepsDir, dir, 'index.ts'), code);
}

const MANIFEST = (id: string) => `id: ${id}\ntitle: Демо\nhint: демо-шаг\nphase: task\nkind: code\n`;

describe('Catalog', () => {
  it('loads implemented and planned steps, presets and reports broken files without failing', async () => {
    const { steps, pipelines } = tempRoot();
    writeStep(steps, 'demo.one', MANIFEST('demo.one'), 'export default { async run() { return { ok: 1 }; } };\n');
    writeStep(steps, 'demo.bad', `${MANIFEST('demo.bad')}gates: publish\n`, 'export default { async run() { return {}; } };\n');
    writeStep(steps, 'demo.mismatch', MANIFEST('demo.other'), 'export default { async run() { return {}; } };\n');
    writeStep(steps, 'demo.norun', MANIFEST('demo.norun'), 'export default { value: 1 };\n');
    writeStep(steps, 'demo.loop', `${MANIFEST('demo.loop')}loop: { restart: [demo.one, demo.typo] }\n`, 'export default { async run() { return {}; } };\n');
    writeFileSync(
      join(steps, '_planned.yaml'),
      '- { id: demo.one, title: Демо, hint: план, phase: task, kind: code, stage: 2 }\n- { id: demo.later, title: Позже, hint: план, phase: qa, kind: agent, stage: 4 }\n',
    );
    writeFileSync(join(pipelines, 'p.yaml'), 'id: p\ntitle: П\nhint: пресет\nsteps: [demo.one, demo.later]\n');
    writeFileSync(join(pipelines, 'bad.yaml'), 'id: bad\ntitle: Б\nhint: пресет\nsteps: [nope.step]\n');

    const catalog = new Catalog(steps, pipelines);
    await catalog.load();

    expect(catalog.entry('demo.one')).toMatchObject({ implemented: true, stage: 2 });
    expect(await catalog.entry('demo.one')?.module?.run({} as never)).toEqual({ ok: 1 });
    expect(catalog.entry('demo.later')).toMatchObject({ implemented: false, stage: 4, manifest: { refresh: [] } });
    expect(catalog.preset('p')?.steps).toEqual(['demo.one', 'demo.later']);
    expect(catalog.preset('bad')).toBeUndefined();
    const files = catalog.errors().map((e) => e.file).sort();
    expect(files).toEqual(['pipelines/bad.yaml', 'steps/demo.bad/step.yaml', 'steps/demo.loop/step.yaml', 'steps/demo.mismatch/step.yaml', 'steps/demo.norun/index.ts']);
    expect(catalog.errors().find((e) => e.file === 'steps/demo.loop/step.yaml')?.message).toBe('петля перезапускает неизвестные шаги: demo.typo');
    expect(catalog.entry('demo.loop')?.manifest.loop).toEqual({ restart: ['demo.one', 'demo.typo'], max: 3 });
  });

  it('reports outputs without a contract and a step contract that repeats a shared one, and takes a contract of a new key from the step', async () => {
    const { steps, pipelines } = tempRoot();
    // Папка шагов теста лежит в .data/catalog-test-*/steps: step-kit на четыре уровня выше модуля.
    const kit = "'../../../../packages/step-kit/src/index.ts'";
    writeStep(steps, 'demo.shared', `${MANIFEST('demo.shared')}provides: [plan, status]\n`, 'export default { async run() { return {}; } };\n');
    writeStep(steps, 'demo.bare', `${MANIFEST('demo.bare')}provides: [greeting, status]\n`, 'export default { async run() { return {}; } };\n');
    writeStep(steps, 'demo.own', `${MANIFEST('demo.own')}provides: [greeting]\n`, `import { z } from ${kit};\nexport default { async run() { return {}; }, contracts: { greeting: z.string() } };\n`);
    writeStep(steps, 'demo.shadow', `${MANIFEST('demo.shadow')}provides: [plan]\n`, `import { z } from ${kit};\nexport default { async run() { return {}; }, contracts: { plan: z.string() } };\n`);
    const catalog = new Catalog(steps, pipelines);
    await catalog.load();
    expect(catalog.errors()).toEqual([
      { file: 'steps/demo.bare/step.yaml', message: 'нет контракта выходов greeting: опишите их в packages/step-kit/src/contracts.ts или в contracts модуля шага' },
      { file: 'steps/demo.shadow/index.ts', message: 'контракт уже есть в step-kit, свой не нужен: plan' },
    ]);
    expect(catalog.entry('demo.own')?.implemented).toBe(true);
  });

  it('reads a step as a chain step by default and reports a background step with a loop as an error', async () => {
    const { steps, pipelines } = tempRoot();
    const code = 'export default { async run() { return {}; } };\n';
    writeStep(steps, 'demo.one', MANIFEST('demo.one'), code);
    writeStep(steps, 'demo.wiki', `${MANIFEST('demo.wiki')}background: true\n`, code);
    writeStep(steps, 'demo.fix', `${MANIFEST('demo.fix')}background: true\nloop: { restart: [demo.one], title: по тесту }\n`, code);
    const catalog = new Catalog(steps, pipelines);
    await catalog.load();
    expect([catalog.entry('demo.one')?.manifest.background, catalog.entry('demo.wiki')?.manifest.background]).toEqual([false, true]);
    expect(catalog.errors()).toEqual([{ file: 'steps/demo.fix/step.yaml', message: 'фоновый шаг не может быть петлей: петля перезапускает шаги цепочки' }]);
  });

  it('shows a preset file whose step comes before its provider as an error, but keeps the preset loaded', async () => {
    const { steps, pipelines } = tempRoot();
    writeStep(steps, 'demo.one', `${MANIFEST('demo.one').replace('title: Демо', 'title: Сборка')}provides: [build]\n`, 'export default { async run() { return {}; } };\n');
    writeStep(steps, 'demo.two', `${MANIFEST('demo.two').replace('title: Демо', 'title: Деплой')}requires: [build]\n`, 'export default { async run() { return {}; } };\n');
    writeFileSync(join(pipelines, 'p.yaml'), 'id: p\ntitle: П\nhint: пресет\nsteps: [demo.two, demo.one]\n');
    const catalog = new Catalog(steps, pipelines);
    await catalog.load();
    expect(catalog.errors()).toEqual([{ file: 'pipelines/p.yaml', message: 'порядок шагов: шаг "Деплой" требует build, который дает шаг "Сборка", стоящий позже' }]);
    expect(catalog.preset('p')?.steps).toEqual(['demo.two', 'demo.one']);
    expect(catalog.presetIssues('p')).toMatchObject([{ level: 'error', stepId: 'demo.two', key: 'build' }]);
  });

  it('keeps the steps apart: no file of a step imports a module of another step', () => {
    const dir = join(ROOT, 'steps');
    const offenders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .flatMap((d) =>
        readdirSync(join(dir, d.name))
          .filter((f) => f.endsWith('.ts') && existsSync(join(dir, d.name, f)))
          .flatMap((f) => [...readFileSync(join(dir, d.name, f), 'utf8').matchAll(/from '\.\.\/([a-z]+\.[a-z-]+)\//g)].map((m) => `steps/${d.name}/${f} -> ${m[1]}`)),
      );
    expect(offenders).toEqual([]);
  });

  it('picks up a changed step module on reload without a restart', async () => {
    const { steps, pipelines } = tempRoot();
    writeStep(steps, 'demo.one', MANIFEST('demo.one'), 'export default { async run() { return { v: 1 }; } };\n');
    const catalog = new Catalog(steps, pipelines);
    await catalog.load();
    writeFileSync(join(steps, 'demo.one', 'index.ts'), 'export default { async run() { return { v: 2 }; } };\n');
    await catalog.load();
    expect(await catalog.entry('demo.one')?.module?.run({} as never)).toEqual({ v: 2 });
  });

  it('picks up a changed helper module of a step on reload in a real Node process', () => {
    const { steps, pipelines } = tempRoot();
    writeStep(steps, 'demo.one', MANIFEST('demo.one'), "import { value } from './helper.ts';\nexport default { async run() { return { v: value }; } };\n");
    const helper = join(steps, 'demo.one', 'helper.ts');
    writeFileSync(helper, 'export const value = 1;\n');
    const probe = join(dirname(steps), 'probe.ts');
    writeFileSync(
      probe,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { Catalog } from ${JSON.stringify(join(ROOT, 'apps/server/src/catalog/catalog.ts'))};`,
        `const c = new Catalog(${JSON.stringify(steps)}, ${JSON.stringify(pipelines)});`,
        `await c.load();`,
        `const a = await c.entry('demo.one').module.run({});`,
        `writeFileSync(${JSON.stringify(helper)}, 'export const value = 2;\\n');`,
        `await c.load();`,
        `const b = await c.entry('demo.one').module.run({});`,
        `console.log(JSON.stringify([a.v, b.v]));`,
      ].join('\n'),
    );
    expect(execFileSync(process.execPath, [probe]).toString().trim()).toBe('[1,2]');
  });

  it('loads the real steps and presets of the project without errors', async () => {
    const catalog = new Catalog(join(ROOT, 'steps'), join(ROOT, 'pipelines'));
    await catalog.load();
    expect(catalog.errors()).toEqual([]);
    // Порядок шагов каждого пресета проекта сходится: ни ошибок, ни предупреждений.
    for (const p of catalog.presets()) expect(catalog.presetIssues(p.id), p.id).toEqual([]);
    for (const id of ['jira.start', 'git.prepare', 'task.analyze', 'code.implement', 'code.verify', 'code.publish']) expect(catalog.entry(id)?.implemented).toBe(true);
    expect(catalog.entry('code.publish')).toMatchObject({ stage: null, manifest: { gate: 'publish', agent: { model: 'sonnet' } } });
    // Анализ идет по коду свежей ветки, поэтому "Ветка" стоит перед ним.
    expect(catalog.preset('full')?.steps.slice(0, 6)).toEqual(['jira.start', 'git.prepare', 'task.analyze', 'code.implement', 'code.verify', 'code.publish']);
    // Шаги доработки, как доработка по тесту, работают, только когда есть что дорабатывать, и в счет цикла не входят.
    expect(catalog.preset('full')?.steps.filter((id) => !catalog.entry(id)?.manifest.loop).length).toBeLessThanOrEqual(15);
    expect(catalog.entry('qa.fix')).toMatchObject({ implemented: true, stage: 4, manifest: { loop: { max: 3, title: 'по тесту' } } });
    // Круги каждой петли панель контекста подписывает названием петли, а не id шага.
    for (const e of catalog.entries()) if (e.manifest.loop) expect(e.manifest.loop.title, e.manifest.id).toBeTruthy();
    const refresh = Object.fromEntries(catalog.entries().filter((e) => e.manifest.refresh.length).map((e) => [e.manifest.id, e.manifest.refresh]));
    expect(refresh).toEqual({ 'deploy.stand': ['stands'], 'qa.stand': ['artifacts'], 'qa.fix': ['artifacts'], 'qa.publish': ['artifacts'] });
    // Ответ на ревью наблюдатель запускает сам по новым замечаниям, доработку задачи - владелец с плашки изменений.
    const triggers = Object.fromEntries(catalog.entries().filter((e) => e.manifest.trigger).map((e) => [e.manifest.id, e.manifest.trigger]));
    expect(triggers).toEqual({ 'pr.address-review': { event: 'pr.review', auto: true }, 'task.rework': { event: 'issue.changed', auto: false } });
    // Вики и дашборд готовятся рядом с цепочкой, пока task.finish ждет мерж; разбор прогона - последний шаг цепочки.
    expect(catalog.entries().filter((e) => e.manifest.background).map((e) => e.manifest.id).sort()).toEqual(['monitor.dashboard', 'wiki.update']);
    expect(catalog.preset('full')?.steps.slice(-5)).toEqual(['pr.address-review', 'monitor.dashboard', 'wiki.update', 'task.finish', 'pilot.retro']);
    // Задачу по доске двигают четыре шага, каждый к своей вехе профиля доски, а владелец меняет это настройкой шага.
    const moves = Object.fromEntries(catalog.entries().flatMap((e) => Object.values(e.manifest.params).filter((p) => p.type === 'jiraStatus').map((p) => [e.manifest.id, p.milestone])));
    expect(moves).toEqual({ 'jira.start': 'inProgress', 'code.publish': 'review', 'qa.publish': 'testing', 'task.finish': 'merged' });
    // Доска учебной команды знает все вехи шагов.
    const board = parse(readFileSync(join(ROOT, 'examples', 'demo', 'profiles', 'jira.yaml'), 'utf8')) as { milestones: Record<string, string> };
    for (const m of Object.values(moves)) expect(board.milestones[m!], m).toBeTruthy();
    for (const id of ['full', 'rework']) {
      const list = catalog.preset(id)!.steps;
      expect(list.indexOf('qa.fix')).toBe(list.indexOf('qa.stand') + 1);
      // Движок идет по порядку: новый круг должен пройти повторяемые шаги раньше, чем снова дойдет до доработки.
      for (const s of catalog.entry('qa.fix')!.manifest.loop!.restart.filter((r) => list.includes(r))) expect(list.indexOf(s)).toBeLessThan(list.indexOf('qa.fix'));
    }
  });
});
