/**
 * Сквозные прогоны пресетов на учебном репозитории демо-режима: настоящие шаги из каталога, движок, git
 * и bare-remote, подменные Jira, Bitbucket, Bamboo и Kibana.
 *
 * "Код и PR" дополнительно собирает Maven в песочнице и публикует в bare-remote. Агент подменен сценарным
 * агентом демо-режима: он делает то, что сделал бы настоящий (пишет план, код с тестом, тексты публикации,
 * итоги теста на стенде), но без CLI. Нужны JDK 21 из javaHome личных настроек и зависимости учебного проекта
 * в ~/.m2: без них этот тест и тест "Доработки" пропускаются.
 *
 * "Тест на стенде" начинает с готовой ветки в remote: ждет ее сборку в подменном Bamboo, деплоит релиз
 * на учебный стенд после подтверждения и проверяет выкатку по подменной Kibana.
 *
 * "Доработка" проходит петлю доработки по тесту: первая реализация с ошибкой, тест на стенде ее находит,
 * доработка чинит код, и прогон заново проходит проверку, коммит, сборку, деплой и тест непройденного AC. Дальше
 * тот же прогон ждет мержа PR: ревьюер оставляет замечание, наблюдатель запускает ответ на ревью, исправление
 * уходит коммитом, ответ публикуется после пуша, а после мержа задача одним подтверждением доходит до вехи мержа
 * доски учебной команды.
 *
 * "Дашборд задачи" собирает дашборд учебной задачи одним подтверждением с живыми цифрами из подменных логов прода,
 * и дальше дашборд виден на обзоре, отдает данные за сутки, строки ведут к одной попытке входа, а алерт проверяется.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentService } from '../src/agent/service.ts';
import { Catalog } from '../src/catalog/catalog.ts';
import { DEMO_TEAM, loadConfig, ROOT, stepTeamOf } from '../src/config.ts';
import { demoBrowser, scriptedAgent } from '../src/demo/agent.ts';
import { DEMO_PROJECT, demoCi } from '../src/demo/ci.ts';
import { DEMO_KEY, DEMO_PR_AUTHOR, DEMO_REVIEW_COMMENT, demoConfig, demoJira, demoScm, seed } from '../src/demo/fixture.ts';
import { demoLogs } from '../src/demo/logs.ts';
import { memoryWiki } from '../src/demo/wiki.ts';
import { Engine } from '../src/engine/engine.ts';
import { EventBus } from '../src/engine/events.ts';
import { createGit } from '../src/integrations/git.ts';
import { seatbeltSandbox } from '../src/integrations/sandbox.ts';
import { createShell } from '../src/integrations/shell.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { createMonitorPort } from '../src/monitor/port.ts';
import { AttemptService } from '../src/monitor/attempts.ts';
import { MonitorService } from '../src/monitor/service.ts';
import { createPilotPort } from '../src/pilot.ts';
import { Store } from '../src/store/db.ts';
import { TaskService } from '../src/tasks.ts';
import { Watcher } from '../src/watch.ts';
import { throughWaits } from './helpers.ts';

const base = loadConfig({ ...process.env, TASK_PILOT_TEAM: DEMO_TEAM }, { otherTeam: true });
const javaHome = base.profiles.repos.find((r) => r.build?.javaHome)?.build?.javaHome;
const ready = !!javaHome && existsSync(javaHome) && existsSync(join(homedir(), '.m2/repository/org/junit/jupiter/junit-jupiter/5.11.4'));

/** Учебный репозиторий, движок с настоящим каталогом шагов и подменами внешних систем. */
async function setup(timing?: { buildMs: number; deployMs: number }, scenario: { bug?: boolean } = {}) {
  // PR ведет тест сам: замечание ревьюера и мерж только по его команде.
  const scmTiming = { reviewMs: -1, mergeMs: -1 };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cycle-')));
  const { origin, repo } = seed(root);
  const config = demoConfig(base, root, repo, 0);
  const store = new Store(':memory:');
  const redact = createRedactor([]);
  const bus = new EventBus(store, redact);
  const catalog = new Catalog(join(ROOT, 'steps'), join(ROOT, 'pipelines'));
  await catalog.load();
  expect(catalog.errors()).toEqual([]);
  const git = createGit();
  const jira = demoJira(config.profiles.jira);
  const ci = demoCi(origin, git, timing);
  const shell = createShell({ sandbox: seatbeltSandbox({ home: homedir(), dataDir: config.dataDir }) });
  const title = (stepId: string) => catalog.entry(stepId)?.manifest.title ?? stepId;
  const ports = {
    jira,
    git,
    shell,
    scm: demoScm(origin, git, scmTiming),
    bamboo: () => ci.bamboo,
    logs: () => ci.logs,
    browser: demoBrowser,
    wiki: memoryWiki(),
    pilot: createPilotPort({ root: config.root, skillsDir: join(root, 'skills'), store, redact, shell, title }),
    monitor: createMonitorPort({ profile: config.profiles.monitor, dir: join(root, 'dashboards'), logs: demoLogs() }),
  };
  const agent = scriptedAgent(scenario);
  const agents = new AgentService({
    store,
    bus,
    redact,
    runner: agent.runner,
    ownerMcp: { atlassian: { command: 'true', args: [], env: {} } },
    pipelineScript: '/dev/null',
    serverUrl: () => 'http://127.0.0.1:1',
    dataDir: config.dataDir,
    askTimeoutMs: 1000,
    mcpToolTimeoutMs: 2000,
  });
  const team = stepTeamOf(config);
  const engine = new Engine({ store, bus, catalog, profiles: config.profiles, ports, redact, agents, lint: { secrets: [] }, dataDir: config.dataDir, team });
  const tasks = new TaskService({ engine, store, bus, ports, profiles: config.profiles, redact });
  // Интервал 0: каждая проверка наблюдателя смотрит все ожидания, быстрые и медленные.
  const watcher = new Watcher({ store, engine, bus, ports, profiles: config.profiles, jira: () => config.profiles.jira, redact }, 0);
  /** Прогон после ожидания сборки, деплоя и выкатки: наблюдатель их видит и продолжает прогон. */
  const settle = (runId: string) => throughWaits({ engine, watcher, store }, runId);
  /** Перезапуск сервера: новые движок и наблюдатель над той же базой и теми же внешними системами. */
  const restart = async () => {
    await engine.shutdown(1000);
    const after = new EventBus(store, redact);
    const next = new Engine({ store, bus: after, catalog, profiles: config.profiles, ports, redact, agents, lint: { secrets: [] }, dataDir: config.dataDir, team });
    next.recover();
    const nextWatcher = new Watcher({ store, engine: next, bus: after, ports, profiles: config.profiles, jira: () => config.profiles.jira, redact }, 0);
    return { engine: next, settle: (runId: string) => throughWaits({ engine: next, watcher: nextWatcher, store }, runId) };
  };
  return { root, origin, repo, store, bus, engine, tasks, ci, agent, jira, scm: ports.scm, watcher, settle, restart, monitor: ports.monitor };
}

/** Ветка задачи с коммитом уже в remote, как после шага "Коммит, пуш и PR"; возвращает ее вершину. */
function pushedBranch(root: string, origin: string): string {
  const work = join(root, 'work');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work }).toString().trim();
  execFileSync('git', ['clone', '-q', origin, work]);
  git('switch', '-q', '-c', 'feature/DEMO-1');
  writeFileSync(join(work, 'NOTES.md'), 'правка задачи\n');
  git('add', '-A');
  git('-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', 'commit', '-qm', 'DEMO-1 Правка');
  git('push', '-q', 'origin', 'feature/DEMO-1');
  return git('rev-parse', 'HEAD');
}

describe.skipIf(!ready)('cycle "Код и PR" on the demo repository', () => {
  it('goes from the plan to a pushed branch, a PR and the review milestone of the board through two approvals', async () => {
    const { origin, repo, store, engine, tasks, agent } = await setup();
    const { id } = await tasks.open(DEMO_KEY, { reuse: false, presetId: 'code-pr' });
    const status = (stepId: string) => store.getStep(id, stepId)?.status;

    await engine.start(id);
    expect(status('jira.start')).toBe('already');
    expect(status('git.prepare')).toBe('succeeded');
    const plan = engine.view(id).approval!;
    expect(plan).toMatchObject({ stepId: 'task.analyze', blocked: false, preview: { title: 'Утвердить план' } });

    await engine.decide(plan.id, 'approve');
    expect(status('code.implement')).toBe('succeeded');
    expect(status('code.verify')).toBe('succeeded');
    expect(store.getContext(id).testReport).toMatchObject({ failures: 0, errors: 0, changedTests: [{ name: 'demo.CalculatorTest', executed: true }] });
    const publish = engine.view(id).approval!;
    expect(publish.stepId).toBe('code.publish');
    expect(publish.blocked).toBe(false);
    expect(publish.preview.actions).toEqual([
      'Коммит в feature/DEMO-1, файлов: 2 (src/main/java/demo/Calculator.java, src/test/java/demo/CalculatorTest.java)',
      'Пуш feature/DEMO-1 в origin, коммитов: 1 (новая ветка)',
      'Создать PR feature/DEMO-1 → master в DEMO/calculator',
      'Jira: In Progress → Review, переход "На ревью"',
    ]);

    await engine.decide(publish.id, 'approve');
    expect(engine.view(id).run.status).toBe('completed');
    const log = (args: string[]) => execFileSync('git', args, { cwd: origin }).toString().trim();
    expect(log(['log', '-1', '--format=%s', 'feature/DEMO-1'])).toBe('DEMO-1 Калькулятор считает разность');
    expect(log(['show', '--name-only', '--format=', 'feature/DEMO-1']).split('\n').sort()).toEqual(['src/main/java/demo/Calculator.java', 'src/test/java/demo/CalculatorTest.java']);
    expect(store.getContext(id)).toMatchObject({ pr: { id: 1001, to: 'master' }, status: 'Review' });
    // План остался в рабочих доках задачи и в коммит не попал.
    expect(readFileSync(join(repo, '.claude', DEMO_KEY, 'plan.md'), 'utf8')).toContain('subtract');
    expect(agent.prompts.map((p) => p.slice(0, 40))).toHaveLength(4);
  }, 180_000);
});

describe('cycle "Тест на стенде" on the demo repository', () => {
  it('waits for the branch build, deploys its release to the chosen stand after one approval and checks the rollout', async () => {
    const { root, origin, repo, store, engine, tasks, ci, jira, settle } = await setup({ buildMs: 30, deployMs: 30 });
    // Пресет начинается с готовой ветки: она уже в remote, как после шага "Коммит, пуш и PR".
    const sha = pushedBranch(root, origin);

    const { id } = await tasks.open(DEMO_KEY, { reuse: false, presetId: 'test-stand', standId: 'demo-1' });
    const status = (stepId: string) => store.getStep(id, stepId)?.status;
    await engine.start(id);
    // Сборку ждет не шаг, а наблюдатель: пока она идет, шаг и прогон ждут события.
    expect(status('ci.wait')).toBe('waiting');
    expect(engine.view(id).run.status).toBe('waiting');
    await settle(id);
    expect(status('ci.wait')).toBe('succeeded');
    expect(store.getContext(id).build).toMatchObject({ key: 'DEMO-CALC11-1', branch: 'feature/DEMO-1', revision: sha, tag: '1.0.1-11' });

    const deploy = engine.view(id).approval!;
    expect(deploy).toMatchObject({ stepId: 'deploy.stand', blocked: false, preview: { title: 'Деплой на demo-1' } });
    expect(deploy.preview.actions).toEqual([
      'Создать релиз feature-DEMO-1-1 из сборки DEMO-CALC11-1',
      'Деплой на demo-1 (Demo-Stand-1): заменить release-10 на feature-DEMO-1-1',
      'Проверить выкатку: под с образом 1.0.1-11 в demo-1 по логам и ответ https://demo-1.demo.invalid/health',
    ]);
    // До подтверждения на стенде ничего не меняется.
    expect((await ci.bamboo.versions(DEMO_PROJECT, 10)).map((v) => v.name)).toEqual(['release-10']);

    await engine.decide(deploy.id, 'approve');
    await settle(id);
    expect(status('deploy.stand')).toBe('succeeded');
    // Одно подтверждение на деплой: продолжение после ожидания деплоя и выкатки его не спрашивает.
    expect(store.listEvents(id).filter((e) => e.type === 'approval.requested' && e.stepId === 'deploy.stand')).toHaveLength(1);
    expect(store.getContext(id)).toMatchObject({ release: { name: 'feature-DEMO-1-1' }, deployedBuild: { stand: 'demo-1', build: 'DEMO-CALC11-1', tag: '1.0.1-11' } });
    const envs = await ci.bamboo.environments(DEMO_PROJECT);
    expect(envs.map((e) => [e.envName, e.version?.name])).toEqual([
      ['Demo-Stand-1', 'feature-DEMO-1-1'],
      ['Demo-Stand-2', 'release-10'],
    ]);
    expect((await ci.logs.pods('demo-calculator', ['demo-1'], 30))['demo-1']?.[0]?.tag).toBe('1.0.1-11');

    // Тест на стенде прошел без владельца: итоги, гайд и отчет на месте, публикация ждет подтверждения.
    expect(status('qa.stand')).toBe('succeeded');
    expect(store.getContext(id)).toMatchObject({ failedAc: [], qaReport: { stand: 'demo-1', build: '1.0.1-11', summary: 'Вычитание работает на стенде' } });
    expect(readFileSync(join(repo, '.claude', DEMO_KEY, 'qa-report.md'), 'utf8')).toContain('# Отчет');
    const publish = engine.view(id).approval!;
    expect(publish).toMatchObject({ stepId: 'qa.publish', blocked: false, preview: { title: 'Итоги в Jira: DEMO-1' } });
    expect(publish.preview.actions).toEqual([
      'Загрузить во вложения DEMO-1: 01-subtract.png, 02-negative.png, DEMO-1-qa-report.md',
      'Добавить комментарий с итогами в DEMO-1',
      'Jira: In Progress → Review, переход "На ревью"',
      'Jira: Review → Testing, переход "В тестирование"',
    ]);
    expect(await jira.attachments(DEMO_KEY)).toEqual([]);

    await engine.decide(publish.id, 'approve');
    expect(engine.view(id).run.status).toBe('completed');
    expect((await jira.attachments(DEMO_KEY)).map((a) => a.filename).sort()).toEqual(['01-subtract.png', '02-negative.png', 'DEMO-1-qa-report.md']);
    expect(store.getContext(id)).toMatchObject({ status: 'Testing', qaComment: { key: DEMO_KEY, rendered: { images: 2, unresolved: 0 } } });
  }, 60_000);

  it('keeps waiting for the build through a server restart and goes on by itself after the start', async () => {
    const { root, origin, store, engine, tasks, restart } = await setup({ buildMs: 300, deployMs: 30 });
    pushedBranch(root, origin);
    const { id } = await tasks.open(DEMO_KEY, { reuse: false, presetId: 'test-stand', standId: 'demo-1' });
    await engine.start(id);
    expect(store.getStep(id, 'ci.wait')?.status).toBe('waiting');
    const after = await restart();
    expect(store.getStep(id, 'ci.wait')).toMatchObject({ status: 'waiting', error: null });
    expect(store.getRun(id)?.status).toBe('waiting');
    await after.settle(id);
    expect(store.getStep(id, 'ci.wait')?.status).toBe('succeeded');
    expect(after.engine.view(id).approval).toMatchObject({ stepId: 'deploy.stand' });
  }, 60_000);
});

describe.skipIf(!ready)('cycle "Доработка" with a rework round after the stand test', () => {
  it('fixes the failed AC, answers the review after the push and walks the task to the merge milestone after the merge', async () => {
    const { origin, store, engine, tasks, jira, agent, scm, watcher, settle } = await setup({ buildMs: 30, deployMs: 30 }, { bug: true });
    const { id } = await tasks.open(DEMO_KEY, { reuse: false, presetId: 'rework', standId: 'demo-1' });
    const status = (stepId: string) => store.getStep(id, stepId)?.status;
    const approve = async (stepId: string) => {
      const a = engine.view(id).approval!;
      expect(a).toMatchObject({ stepId, blocked: false });
      await engine.decide(a.id, 'approve');
      await settle(id);
      return a;
    };

    await engine.start(id);
    await settle(id);
    await approve('code.publish');
    await approve('deploy.stand');
    // Первый тест на стенде нашел ошибку, доработка ее исправила, и прогон вернулся к проверке и коммиту.
    expect(store.getContext(id)).toMatchObject({ failedAc: ['2'], loops: { 'qa.fix': 1 }, qaFix: { round: 1, failed: ['2'], buildGreen: true } });
    expect(store.getContext(id).testReport).toMatchObject({ builds: 1, failures: 0, errors: 0 });
    expect(['qa.stand', 'qa.fix', 'ci.wait', 'deploy.stand'].map(status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    const fixPrompt = agent.prompts.find((p) => p.includes('шаг "Доработка по тесту"'))!;
    expect(fixPrompt).toContain('- AC 2 (не пройден): AC 2. Действие: вызов на стенде. Ожидалось: по AC. Факт: subtract(3, 5) вернул 2. Кадры: 02-negative.png');

    const commit = await approve('code.publish');
    expect(commit.preview.actions).toEqual([
      'Коммит в feature/DEMO-1, файлов: 2 (src/main/java/demo/Calculator.java, src/test/java/demo/CalculatorTest.java)',
      'Пуш feature/DEMO-1 в origin, коммитов: 1',
    ]);
    const deploy = await approve('deploy.stand');
    expect(deploy.preview.actions.slice(0, 2)).toEqual(['Создать релиз feature-DEMO-1-2 из сборки DEMO-CALC11-2', 'Деплой на demo-1 (Demo-Stand-1): заменить feature-DEMO-1-1 на feature-DEMO-1-2']);

    // Второй круг перепроверил только AC 2, петля закончилась, итоги ждут публикации.
    expect(agent.prompts.filter((p) => p.includes('шаг "Тест на стенде"')).at(-1)).toContain('Что проверить: только AC 2');
    expect(store.getStep(id, 'qa.fix')).toMatchObject({ status: 'already', note: 'Непройденных AC нет, не проверено 1: дорабатывать нечего' });
    expect(store.getContext(id).qaReport).toMatchObject({ build: '1.0.2-11', summary: 'Вычитание работает на стенде' });
    expect((store.getContext(id).qaReport as { results: { ac: string; result: string; files: string[] }[] }).results.map((r) => [r.ac, r.result, r.files.join()])).toEqual([
      ['1', 'пройден', '01-subtract.png'],
      ['2', 'пройден', '03-negative-fixed.png'],
      ['3', 'не проверен', ''],
    ]);
    const publish = await approve('qa.publish');
    expect(publish.preview.actions).toEqual([
      'Загрузить во вложения DEMO-1: 01-subtract.png, 03-negative-fixed.png, DEMO-1-qa-report.md',
      'Добавить комментарий с итогами в DEMO-1',
      'Jira: Review → Testing, переход "В тестирование"',
    ]);
    expect((await jira.attachments(DEMO_KEY)).map((a) => a.filename).sort()).toEqual(['01-subtract.png', '03-negative-fixed.png', 'DEMO-1-qa-report.md']);

    // Замечаний нет, PR не смержен: прогон ждет мержа, а не падает.
    expect(store.getStep(id, 'pr.address-review')?.status).toBe('already');
    expect(store.getStep(id, 'task.finish')).toMatchObject({ status: 'waiting', note: 'Жду мерж PR #1001: одобрили 0 из 1' });
    expect(engine.view(id).run.status).toBe('waiting');

    // Ревьюер оставил замечание: наблюдатель сообщает о нем, и движок по триггеру запускает ответ на ревью; исправление
    // идет через проверку и коммит.
    scm.comment(1001, DEMO_REVIEW_COMMENT);
    await watcher.tick();
    await settle(id);
    expect(store.getContext(id)).toMatchObject({ loops: { 'qa.fix': 1, 'pr.address-review': 1 }, prReview: { pr: 1001, pending: true } });
    const reviewPrompt = agent.prompts.find((p) => p.includes('шаг "Ответ на ревью"'))!;
    expect(reviewPrompt).toContain(`(общий комментарий): ${DEMO_REVIEW_COMMENT}`);
    const fixCommit = await approve('code.publish');
    expect(fixCommit.preview.actions).toEqual(['Коммит в feature/DEMO-1, файлов: 1 (src/test/java/demo/CalculatorTest.java)', 'Пуш feature/DEMO-1 в origin, коммитов: 1']);

    // Ответ публикуется после пуша, с коммитом исправления, и прогон снова ждет мержа.
    const replies = await approve('task.finish');
    const sha = (store.getContext(id).commitSha as string).slice(0, 8);
    expect(replies.preview.texts?.map((x) => x.text)).toEqual([`Добавил в тест вычитание нуля: subtract(5, 0). Исправлено в коммите ${sha}.`]);
    const pr = await scm.pullRequest({ contour: 'demo', project: 'DEMO', repo: 'calculator' }, 1001);
    expect(pr.comments[0]!.replies.map((r) => [r.author, r.text])).toEqual([[DEMO_PR_AUTHOR, replies.preview.texts![0]!.text]]);
    expect(store.getStep(id, 'task.finish')?.status).toBe('waiting');
    expect(store.getContext(id).prReview).toMatchObject({ pr: 1001, pending: false });

    // После мержа наблюдатель продолжает прогон, и одно подтверждение ведет задачу до вехи мержа.
    scm.merge(1001);
    await watcher.tick();
    await settle(id);
    const merged = await approve('task.finish');
    expect(merged.preview.actions).toEqual(['Jira: Testing → Done, переход "Смержено"']);
    expect(engine.view(id).run.status).toBe('completed');
    expect(store.getContext(id)).toMatchObject({ status: 'Done', merged: { pr: 1001 } });
    expect(store.listEvents(id).map((e) => e.type)).toEqual(expect.arrayContaining(['pr.review', 'pr.merged']));

    const log = execFileSync('git', ['log', '--format=%s', 'master..feature/DEMO-1'], { cwd: origin }).toString().trim().split('\n');
    expect(log).toEqual(['DEMO-1 Тест на вычитание нуля по замечанию ревью', 'DEMO-1 Разность может быть отрицательной', 'DEMO-1 Калькулятор считает разность']);
    expect(execFileSync('git', ['show', 'feature/DEMO-1:src/main/java/demo/Calculator.java'], { cwd: origin }).toString()).toContain('return a - b;');
  }, 300_000);
});

describe('cycle "Доработка" after the task changed in Jira', () => {
  it('reworks the plan by the change the watcher found and asks the owner to approve it', async () => {
    const { repo, store, engine, tasks, jira, watcher, agent } = await setup();
    const { id } = await tasks.open(DEMO_KEY, { reuse: false, presetId: 'code-pr' });
    // Время обновления задачи в подменной Jira - до миллисекунды: владелец двигает карточку позже, чем прогон ее прочитал.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [move] = await jira.getTransitions(DEMO_KEY);
    await jira.transition(DEMO_KEY, move!.id);
    await watcher.tick();
    expect(store.getContext(id).issueChanged).toMatchObject({ changes: [{ kind: 'status' }] });
    // Так делает кнопка "Доработать": прогон переходит на пресет доработки и запускает его шаг по изменению задачи.
    engine.setOptions(id, { presetId: 'rework' });
    await engine.retry(id, 'task.rework');
    expect(engine.view(id).approval).toMatchObject({ stepId: 'task.rework', blocked: false, preview: { title: 'Утвердить доработку плана' } });
    expect(agent.prompts.filter((p) => p.includes('шаг "Доработка задачи"'))).toHaveLength(1);
    expect(readFileSync(join(repo, '.claude', DEMO_KEY, 'plan.md'), 'utf8')).toContain('## Доработка');
  });
});

describe('cycle "Дашборд задачи" on the demo repository', () => {
  it('saves the dashboard of a task after one approval with live numbers and shows it on the overview, in a dashboard, the path of an attempt and an alert', async () => {
    const { store, bus, engine, tasks, jira, monitor } = await setup();
    const { id } = await tasks.open(DEMO_KEY, { reuse: false, presetId: 'monitor' });
    // Дашборд - фоновый шаг: цепочка пресета пуста и заканчивается сразу, а шаг готовит превью рядом с ней.
    await engine.start(id);
    await engine.settled(id);
    const a = engine.view(id).approval!;
    expect(a).toMatchObject({ stepId: 'monitor.dashboard', blocked: false });
    expect(a.preview.actions[0]).toBe('Сохранить дашборд "Калькулятор - вычитание" в dashboards/demo-1-calculator/dashboard.yaml: панелей 3, алертов 1');
    expect(a.preview.notes?.find((t) => t.id === 'live')?.text).toMatch(/^Вычитания: за час \d/);
    await engine.decide(a.id, 'approve');
    expect(engine.view(id).run.status).toBe('completed');
    expect(monitor.dashboards().dashboards.map((d) => d.id)).toEqual(['demo-1-calculator']);

    const service = new MonitorService({ port: monitor, profile: base.profiles.monitor, jira, jiraBaseUrl: base.profiles.jira.baseUrl, store, bus });
    const card = (await service.overview()).groups.flatMap((g) => g.cards).find((c) => c.dashboard?.id === 'demo-1-calculator')!;
    expect(card).toMatchObject({ task: { key: DEMO_KEY }, status: 'ok' });
    expect(card.headlines.map((h) => [h.title, h.error ?? null, h.spark.length])).toEqual([
      ['Вычитания', null, 24],
      ['Ошибки вычитания', null, 24],
    ]);
    const data = await service.data('demo-1-calculator', '24h');
    expect(data.panels.map((p) => p.value.type)).toEqual(['timeseries', 'stat', 'lines']);
    expect(data.deploys.map((d) => d.version)).toEqual(['1.0.273-master']);
    const lines = data.panels[2]!.value;
    if (lines.type !== 'lines') throw new Error('lines');
    const state = /state = ([A-Za-z0-9]{32})/.exec(lines.lines[0]!.message)![1]!;
    const path = await new AttemptService({ port: monitor }).path({ ids: [state], at: Date.now() });
    // По state находится калькулятор, а следующие круги по correlationId и flowState из его строк находят шлюз и аудит.
    expect(path.summary.services.map((s) => s.service)).toEqual(['calculator', 'gateway', 'audit']);
    expect(path.summary.services[0]!.lines).toBeGreaterThanOrEqual(5);
    expect(path.rounds).toBeGreaterThan(0);
    await service.tick();
    expect(store.monitorAlerts('demo-1-calculator')).toMatchObject([{ alertId: 'no-subtract', state: 'ok' }]);
  });
});
