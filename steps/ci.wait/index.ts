import { existsSync } from 'node:fs';
import type { BambooPort, Build, BuildResult, Contour, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { branchFor, imageTag, renderTemplate, StepWaiting, timed } from '../../packages/step-kit/src/index.ts';
import { agentRules, buildCommand, buildEnv, buildRule, GIT_READ, readText } from '../_shared/agent.ts';
import { minutes, sinceOf, WAIT_MS } from '../_shared/wait.ts';

interface Target {
  /** id контура: по нему наблюдатель спрашивает Bamboo, пока шаг ждет. */
  contour: string;
  /** Как Bamboo контура называет образы сборок: по схеме тег образа сборки. */
  builds: Contour['builds'];
  bamboo: BambooPort;
  plan: string;
  branch: string;
  sha: string;
}

/** Строк лога упавшего задания, которые получает агент: причина падения обычно в самом конце. */
const LOG_LINES = 300;

const SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string', enum: ['code', 'infra', 'unknown'] },
    summary: { type: 'string', description: 'Причина и что сделано, 1-3 предложения' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['cause', 'summary', 'files'],
  additionalProperties: false,
};

/** Коммит, сборку которого ждем: опубликованный шагом "Коммит, пуш и PR", иначе вершина ветки на remote. */
async function commitOf(c: StepContext, branch: string): Promise<string> {
  const published = c.get<string>('commitSha');
  if (published && /^[0-9a-f]{40}$/.test(published)) return published;
  const r = await c.ports.git.tryRun(c.repo.path, ['ls-remote', c.repo.remote, `refs/heads/${branch}`]);
  const sha = r.code === 0 ? r.stdout.split(/\s/)[0] : undefined;
  if (!sha) throw new Error(`Ветки ${branch} нет на ${c.repo.remote}: сначала нужен шаг "Коммит, пуш и PR"`);
  return sha;
}

async function target(c: StepContext): Promise<Target> {
  if (!c.contour?.connected) throw new Error(`Контур ${c.contour?.title ?? c.repo.contour} еще не подключен${c.contour?.note ? `: ${c.contour.note}` : ''}`);
  const plan = c.repo.bamboo?.plan;
  if (!plan) throw new Error(`В профиле репозитория ${c.repo.id} нет bamboo.plan`);
  const branch = c.get<string>('branch') ?? branchFor(c.repo.branchPattern, c.run.issueKey);
  return { contour: c.contour.id, builds: c.contour.builds, bamboo: c.ports.bamboo(c.contour), plan, branch, sha: await commitOf(c, branch) };
}

function toBuild(b: BuildResult, t: Target): Build {
  return { key: b.key, number: b.number, plan: t.plan, branch: t.branch, revision: t.sha, tag: imageTag(t.plan, b.key, t.builds), url: b.url };
}

/**
 * Сборка упала: агент разбирает конец лога и, если причина в коде, чинит его в рабочей папке и проверяет
 * локальной сборкой. В CI исправление попадает повтором шага "Коммит, пуш и PR" через обычное подтверждение,
 * поэтому шаг в любом случае падает с объяснением, что делать дальше.
 */
async function failed(c: StepContext, t: Target, b: BuildResult): Promise<never> {
  const log = await t.bamboo.buildLog(b.key, LOG_LINES);
  const worktree = c.get<string>('worktree');
  if (!worktree || !existsSync(worktree)) {
    throw new Error(`Сборка ${b.key} упала: ${b.url}. Рабочей папки ветки нет, поэтому агент не разбирал лог: нужен шаг "Ветка"`);
  }
  const prompt = renderTemplate(readText(import.meta.url, './fix.md'), {
    key: c.run.issueKey,
    build: b.key,
    branch: t.branch,
    url: b.url,
    log: log.join('\n'),
    // Без локальной сборки в профиле разбор все равно нужен: причина падения видна в логе CI.
    check: c.repo.build?.command
      ? `проверь исправление локальной сборкой: \`${buildCommand(c.repo)}\``
      : 'локальная сборка в профиле репозитория не настроена, поэтому проверь исправление внимательным чтением кода',
  });
  const r = await c.agent.run({
    label: 'сборка ветки',
    prompt: `${prompt}\n\n${agentRules(c, true)}`,
    cwd: worktree,
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    allow: [...GIT_READ, ...(c.repo.build?.command ? buildRule(c.repo) : [])],
    env: c.repo.build?.command ? buildEnv(c.repo) : {},
    schema: SCHEMA,
  });
  const out = r.output as { cause?: string; summary?: string } | null;
  const summary = out?.summary?.trim() || 'агент не описал причину';
  const status = await c.ports.git.tryRun(worktree, ['status', '--porcelain']);
  const changed = status.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  if (out?.cause === 'code' && changed.length) {
    throw new Error(`Сборка ${b.key} упала: ${summary} Агент исправил код в рабочей папке (${changed.join(', ')}): повторите шаг "Коммит, пуш и PR", а затем этот шаг. ${b.url}`);
  }
  throw new Error(`Сборка ${b.key} упала, в коде агент ничего не менял: ${summary} ${b.url}`);
}

/**
 * Одна проверка сборки коммита: сначала ветки плана, которую Bamboo заводит сам после пуша, потом сборки этого
 * коммита. Зеленая сборка - выход шага, упавшую разбирает агент, а пока ветки или законченной сборки нет, шаг ждет:
 * наблюдатель продолжит его, когда Bamboo доберется до коммита. Срок ожидания считается от первой проверки.
 */
async function check(c: StepContext, t: Target): Promise<Record<string, unknown>> {
  const since = sinceOf(c, 'plan-branch', 'build');
  const branch = await t.bamboo.planBranch(t.plan, t.branch);
  if (!branch) {
    throw new StepWaiting(`Жду, пока Bamboo заведет ветку плана ${t.plan} для ${t.branch}`, {
      kind: 'plan-branch',
      contour: t.contour,
      plan: t.plan,
      branch: t.branch,
      ...timed(since, WAIT_MS.planBranch, `Bamboo за ${minutes(WAIT_MS.planBranch)} минут не завел ветку плана для ${t.branch}`),
    });
  }
  const b = (await t.bamboo.builds(branch.key, 10)).find((x) => x.revision === t.sha);
  c.log(`Bamboo: ${b ? `${b.key}: ${b.lifeCycle}` : 'сборка коммита еще не началась'}`);
  if (b?.lifeCycle === 'Finished') {
    if (b.state === 'Successful') return { build: toBuild(b, t) };
    return failed(c, t, b);
  }
  if (b?.lifeCycle === 'NotBuilt') throw new Error(`Сборка ${b.key} не выполнялась: ${b.url}`);
  throw new StepWaiting(`Жду сборку коммита ${t.sha.slice(0, 8)}: ${b ? `${b.key}, ${b.lifeCycle}` : 'сборка еще не началась'}`, {
    kind: 'build',
    contour: t.contour,
    planKey: branch.key,
    revision: t.sha,
    ...timed(since, WAIT_MS.build, `Сборка коммита ${t.sha.slice(0, 8)} не закончилась за ${minutes(WAIT_MS.build)} минут${b ? `: ${b.url}` : ''}`),
  });
}

/**
 * Сборка коммита ветки задачи в Bamboo. Шаг не опрашивает Bamboo сам: пока ветки плана или сборки нет, он ждет
 * события, а наблюдатель продолжает его, когда сборка закончилась. Зеленая сборка ложится в контекст, упавшую
 * разбирает агент.
 */
const step: StepModule = {
  async done(c) {
    const t = await target(c);
    const branch = await t.bamboo.planBranch(t.plan, t.branch);
    if (!branch) return null;
    const b = (await t.bamboo.builds(branch.key, 10)).find((x) => x.revision === t.sha);
    if (!b || b.lifeCycle !== 'Finished' || b.state !== 'Successful') return null;
    return { note: `Сборка ${b.key} коммита ${t.sha.slice(0, 8)} уже зеленая`, outputs: { build: toBuild(b, t) } };
  },

  async simulate(c) {
    const plan = c.repo.bamboo?.plan ?? '';
    const branch = c.get<string>('branch') ?? branchFor(c.repo.branchPattern, c.run.issueKey);
    return { build: { key: 'dry-run', number: 0, plan, branch, revision: 'dry-run', tag: null, url: '' } satisfies Build };
  },

  async run(c) {
    const t = await target(c);
    c.log(`Жду сборку коммита ${t.sha.slice(0, 8)} ветки ${t.branch} в плане ${t.plan}`);
    return check(c, t);
  },

  // Bamboo завел ветку плана или сборка закончилась: та же проверка, срок прежний.
  async resume(c) {
    return check(c, await target(c));
  },
};

export default step;
