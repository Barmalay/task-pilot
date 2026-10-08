import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitPort, Issue, LintIssue, PreviewText, PullRequestRef, RepoProfile, ScmRepoRef, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { branchFor, headsOf, pickBranch, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, GIT_READ, readText, sha256 } from '../_shared/agent.ts';
import { acOf, acText } from '../_shared/ac.ts';
import { customizeOnly } from '../_shared/ansible.ts';
import { approvedPlan } from '../_shared/plan.ts';
import { commitMessage, finishTexts, TEXTS_SCHEMA, textsOutput } from '../_shared/texts.ts';
import { parseWorktrees } from '../_shared/worktrees.ts';

const LABEL = 'тексты конфига деплоя';
/** Запуск агента, который вносит правку конфига в ветку задачи. */
const CONFIG_LABEL = 'конфиг деплоя';
/** Незаконченные операции git: коммитить и пушить поверх них нельзя. */
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'];
/** Файлы конфигурации сервиса: их изменения агент конфига получает в задании целиком. */
const SERVICE_CONFIG = /(^|\/)(application[^/]*\.(ya?ml|properties)|bootstrap[^/]*\.ya?ml|[^/]*\.env|Dockerfile)$/i;
/** Сколько строк изменений конфигурации сервиса идет в задание; остальное агент смотрит сам. */
const SERVICE_CONFIG_LINES = 300;

/** Итог агента, который вносит правку конфига. */
const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Что и для каких окружений добавлено или изменено, без значений секретов' },
    files: { type: 'array', items: { type: 'string' }, description: 'Измененные файлы относительно рабочей папки' },
    secrets: { type: 'array', items: { type: 'string' }, description: 'Секреты, которые нужно завести до деплоя: имя и окружения, без значений' },
    remarks: { type: 'array', items: { type: 'string' }, description: 'Что владельцу стоит проверить' },
  },
  required: ['summary', 'files', 'secrets', 'remarks'],
  additionalProperties: false,
};

/** Патч конфига деплоя из доков задачи и его состояние в рабочей папке ветки. */
interface Patch {
  name: string;
  path: string;
  hash: string;
  /** Файлы, которые меняет патч. */
  files: string[];
  /** apply - патч ложится, его изменений в папке нет; applied - изменения уже есть; differs - не ложится ни прямо, ни обратно. */
  state: 'apply' | 'applied' | 'differs';
  /** Почему патч не ложится: первая строка ответа git. */
  reason: string | null;
}

/** Правка конфига, которую внес агент шага. */
interface Config {
  sessionId: string;
  summary: string;
  /** Секреты, которые нужно завести до деплоя: имя и окружения, без значений. */
  secrets: string[];
  /** Что владельцу стоит проверить. */
  remarks: string[];
}

/** Ветка задачи и тексты публикации, которые готовит агент. */
interface Draft {
  branch: string;
  /** Правка агента; null - правку дал патч из доков задачи или она уже была в ветке. */
  config?: Config | null;
  sessionId: string | null;
  subject: string;
  body: string;
  prTitle: string;
  prDescription: string;
  /** Что линтер исправил в текстах сам: показывается на подтверждении. */
  fixed: LintIssue[];
}

/** Репозиторий конфига деплоя и его Bitbucket. */
interface Target {
  deploy: RepoProfile;
  scm: ScmRepoRef;
}

/** Что сейчас в рабочей папке ветки задачи, на remote и в Bitbucket. */
interface State {
  branch: string;
  /** Ветки еще нет на remote: ее заведет пуш шага. */
  fresh: boolean;
  worktree: string;
  head: string;
  /** Коммиты ветки, которых нет на remote: уйдут пушем. */
  unpushed: string[];
  /** Сколько коммитов в ветке сверх базовой ветки. */
  own: number;
  patches: Patch[];
  /** Измененные и новые файлы рабочей папки: войдут в коммит. */
  changed: string[];
  /** Изменения рабочей папки текстом диффа: ровно то, что войдет в коммит. */
  diff: string;
  blocker: string | null;
  warnings: string[];
  pr: PullRequestRef | null;
}

/**
 * Имена переменных из строк диффа вида name: value или NAME=value, без значений: по ним агент пишет
 * тексты, не видя самих значений. Имя, которое есть и среди добавленных, и среди удаленных строк, - измененное.
 */
export function diffKeys(diff: string): { added: string[]; changed: string[]; removed: string[] } {
  const plus = new Set<string>();
  const minus = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const m = /^([+-])\s*(?:-\s+)?([A-Za-z_][\w.-]*)\s*[:=]/.exec(line);
    if (m) (m[1] === '+' ? plus : minus).add(m[2]!);
  }
  return {
    added: [...plus].filter((k) => !minus.has(k)),
    changed: [...plus].filter((k) => minus.has(k)),
    removed: [...minus].filter((k) => !plus.has(k)),
  };
}

function lines(out: string): string[] {
  return out.split('\n').filter(Boolean);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);

/** Репозиторий конфига деплоя задачи из профиля репозитория. */
function targetOf(c: StepContext): Target {
  if (c.contour && !c.contour.connected) throw new Error(`Контур ${c.contour.title} еще не подключен${c.contour.note ? `: ${c.contour.note}` : ''}`);
  const deploy = c.deployRepo;
  if (!deploy) throw new Error(`В профиле репозитория ${c.repo.id} не указан репозиторий конфига деплоя (deployRepo)`);
  const bb = deploy.bitbucket;
  if (!bb) throw new Error(`В профиле репозитория деплоя ${deploy.id} нет bitbucket: PR создать некуда`);
  if (!existsSync(deploy.path)) throw new Error(`Папки репозитория деплоя ${deploy.path} нет: склонируйте туда ${bb.project}/${bb.repo}`);
  return { deploy, scm: { contour: deploy.contour, project: bb.project, repo: bb.repo } };
}

function where(t: Target): string {
  return `${t.scm.project}/${t.scm.repo}`;
}

/** Ветка задачи в репозитории сервиса: ветку k8s-ansible с таким же именем скрипт деплоя берет сам. */
function releaseBranch(c: StepContext): string {
  return c.get<string>('branch') ?? branchFor(c.repo.branchPattern, c.run.issueKey);
}

/**
 * Ветка задачи в репозитории деплоя. Первой берется ветка с именем ветки задачи, иначе единственная ветка задачи,
 * которую раньше завели кнопкой Create branch (`pickBranch`); без них шаг заводит ветку с именем ветки задачи сам
 * (fresh): такую скрипт деплоя найдет без Customize Deploy. Ветка, которая отличается от нужной только регистром, -
 * ошибка: git на macOS таких веток не различает.
 */
async function branchOf(c: StepContext, t: Target): Promise<{ branch: string; fresh: boolean }> {
  const heads = headsOf((await c.ports.git.run(t.deploy.path, ['ls-remote', '--heads', t.deploy.remote])).stdout);
  const release = releaseBranch(c);
  if (heads.includes(release)) return { branch: release, fresh: false };
  const clash = heads.find((h) => h.toLowerCase() === release.toLowerCase());
  if (clash) throw new Error(`В ${where(t)} есть ветка ${clash}, а нужна ${release}: они отличаются только регистром, и git на macOS их не различает. Удалите ветку ${clash} или переименуйте ее в ${release}`);
  const { branch, candidates } = pickBranch(heads, c.run.issueKey, t.deploy.branchPattern);
  if (!branch && candidates.length > 1) throw new Error(`В ${where(t)} у задачи несколько веток: ${candidates.join(', ')}. Оставьте одну, шаг не знает, какую взять`);
  return branch ? { branch, fresh: false } : { branch: release, fresh: true };
}

/**
 * Папка, где открыта ветка задачи: уже открытая или новая, как git switch на ветку с remote. Ветки, которой нет ни в
 * папке, ни на remote, шаг заводит от базовой ветки без отслеживания: на remote она появится с пушем. Без open новая
 * папка не создается.
 */
async function worktreeFor(c: StepContext, t: Target, branch: string, open: boolean, onRemote: boolean): Promise<string | null> {
  const { git } = c.ports;
  const { deploy } = t;
  const localRef = `refs/heads/${branch}`;
  const opened = parseWorktrees((await git.run(deploy.path, ['worktree', 'list', '--porcelain'])).stdout).find((w) => w.branch === localRef)?.path;
  if (opened) return opened;
  if (!open) return null;
  const path = join(deploy.worktreesDir, `${deploy.id}-${c.run.issueKey}`);
  if (existsSync(path)) throw new Error(`Папка ${path} уже существует, но ветка ${branch} в ней не открыта`);
  mkdirSync(deploy.worktreesDir, { recursive: true });
  if ((await git.tryRun(deploy.path, ['rev-parse', '--verify', '--quiet', localRef])).code === 0) await git.run(deploy.path, ['worktree', 'add', path, branch]);
  else if (onRemote) await git.run(deploy.path, ['worktree', 'add', '--track', '-b', branch, path, `${deploy.remote}/${branch}`]);
  else {
    await git.run(deploy.path, ['worktree', 'add', '--no-track', '-b', branch, path, `refs/remotes/${deploy.remote}/${deploy.baseBranch}`]);
    c.log(`Ветка ${branch} заведена от ${deploy.remote}/${deploy.baseBranch} в ${path}: на remote она появится с пушем после подтверждения`);
    return path;
  }
  c.log(`Ветка ${branch} репозитория деплоя открыта в ${path}`);
  return path;
}

/** Патчи для репозитория деплоя в доках задачи: файлы <имя репозитория в Bitbucket>*.patch по порядку имен. */
function patchFiles(c: StepContext, t: Target): { name: string; path: string }[] {
  if (!existsSync(c.paths.docs)) return [];
  return readdirSync(c.paths.docs)
    .filter((f) => f.startsWith(t.scm.repo) && f.endsWith('.patch'))
    .sort()
    .map((name) => ({ name, path: join(c.paths.docs, name) }));
}

async function patchState(git: GitPort, cwd: string, file: { name: string; path: string }): Promise<Patch> {
  const hash = sha256(readFileSync(file.path, 'utf8'));
  const files = lines((await git.run(cwd, ['apply', '--numstat', '-p1', file.path])).stdout).map((l) => l.split('\t')[2]!);
  const forward = await git.tryRun(cwd, ['apply', '--check', '-p1', file.path]);
  if (forward.code === 0) return { ...file, hash, files, state: 'apply', reason: null };
  const reverse = await git.tryRun(cwd, ['apply', '--check', '-R', '-p1', file.path]);
  if (reverse.code === 0) return { ...file, hash, files, state: 'applied', reason: null };
  return { ...file, hash, files, state: 'differs', reason: lines(forward.stderr)[0] ?? `код ${forward.code}` };
}

/** Пути из git status --porcelain -z; у переименования и копии оба пути: коммит должен забрать и удаление исходного файла. */
export function statusPaths(out: string): string[] {
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if ((entry[0] === 'R' || entry[0] === 'C') && parts[i + 1]) paths.push(parts[++i]!);
  }
  return [...new Set(paths)];
}

/** Изменения файлов рабочей папки текстом диффа, включая новые файлы. */
async function changesDiff(git: GitPort, cwd: string, changed: string[]): Promise<string> {
  if (!changed.length) return '';
  const untracked = new Set(lines((await git.run(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout));
  const tracked = changed.filter((p) => !untracked.has(p));
  const parts = tracked.length ? [(await git.run(cwd, ['--literal-pathspecs', 'diff', 'HEAD', '--no-color', '--', ...tracked])).stdout] : [];
  // У нового файла дифф с /dev/null; git diff --no-index выходит с кодом 1, когда разница есть.
  for (const p of changed.filter((x) => untracked.has(x))) parts.push((await git.tryRun(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', p])).stdout);
  return parts.join('');
}

/** Состояние ветки в памяти шага: done, preview и run одного выполнения видят одно и то же. */
function cacheKey(branch: string): string {
  return `state:${branch}`;
}

async function inspect(c: StepContext, t: Target, branch: string, open: boolean): Promise<State | null> {
  const cached = c.scratch.get(cacheKey(branch)) as State | undefined;
  if (cached) return cached;
  const { git } = c.ports;
  const { deploy } = t;
  // Ветка может быть пока только в рабочей папке шага: на remote ее заводит пуш после подтверждения.
  const onRemote = (await git.run(deploy.path, ['ls-remote', '--heads', deploy.remote, `refs/heads/${branch}`])).stdout.trim() !== '';
  // Только ветка задачи и базовая: в репозитории деплоя тысячи веток, и есть различающиеся только регистром,
  // из-за которых полный fetch на macOS падает.
  const tracking = (name: string) => `+refs/heads/${name}:refs/remotes/${deploy.remote}/${name}`;
  const fetched = await git.tryRun(deploy.path, ['fetch', '--no-tags', deploy.remote, tracking(deploy.baseBranch), ...(onRemote ? [tracking(branch)] : [])]);
  if (fetched.code !== 0) throw new Error(`git fetch ${deploy.remote} в ${deploy.path}: ${fetched.stderr.trim() || `код ${fetched.code}`}`);
  const base = `refs/remotes/${deploy.remote}/${deploy.baseBranch}`;
  const remoteSha = onRemote ? (await git.run(deploy.path, ['rev-parse', `refs/remotes/${deploy.remote}/${branch}`])).stdout.trim() : null;
  const worktree = await worktreeFor(c, t, branch, open, onRemote);
  if (!worktree) return null;
  const current = (await git.run(worktree, ['branch', '--show-current'])).stdout.trim();
  if (current !== branch) throw new Error(`В ${worktree} открыта ветка ${current || '(detached)'}, а не ${branch}`);
  for (const ref of IN_PROGRESS) {
    if ((await git.tryRun(worktree, ['rev-parse', '-q', '--verify', ref])).code === 0) throw new Error(`В ${worktree} не закончена операция git (${ref}): завершите или отмените ее вручную`);
  }
  const changed = statusPaths((await git.run(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout);
  let head = (await git.run(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  let blocker: string | null = null;
  const behind = remoteSha ? Number((await git.run(worktree, ['rev-list', '--count', `HEAD..${remoteSha}`])).stdout.trim()) : 0;
  // Новая ветка уйдет на remote целиком: все ее коммиты сверх базовой ветки.
  let unpushed = lines((await git.run(worktree, ['log', '--format=%h %s', `${remoteSha ?? base}..HEAD`])).stdout);
  if (behind > 0 && unpushed.length) blocker = `Ветка ${branch} в ${worktree} разошлась с ${deploy.remote}: ${unpushed.length} своих и ${behind} чужих коммитов, нужно разобраться вручную`;
  else if (behind > 0 && changed.length) blocker = `На ${deploy.remote} в ветке ${branch} новые коммиты, а в ${worktree} незакоммиченные изменения: подтянуть коммиты нельзя`;
  else if (behind > 0 && open) {
    // Коммиты в ветку могут прийти и из Bitbucket: своих коммитов нет, поэтому просто подтягиваются.
    await git.run(worktree, ['merge', '--ff-only', '-q', remoteSha!]);
    head = remoteSha!;
    unpushed = [];
    c.log(`Подтянуты ${behind} новых коммитов ${deploy.remote}/${branch}`);
  }
  const patches: Patch[] = [];
  for (const file of patchFiles(c, t)) patches.push(await patchState(git, worktree, file));
  const own = Number((await git.run(worktree, ['rev-list', '--count', `${base}..HEAD`])).stdout.trim());
  // С патчем в доках задачи правка - ровно патч; без патча ее пишет агент, и все изменения папки - его правка.
  const patched = new Set(patches.flatMap((p) => p.files));
  const foreign = patches.length ? changed.filter((p) => !patched.has(p)) : [];
  if (foreign.length) blocker ??= `В ${worktree} есть изменения вне патчей задачи: ${foreign.join(', ')}. Закоммитьте или уберите их вручную`;
  const warnings: string[] = [];
  for (const p of patches.filter((x) => x.state === 'differs')) {
    if (changed.some((f) => p.files.includes(f))) {
      blocker ??= `Изменения файлов патча ${p.name} в ${worktree} не совпадают с патчем: похоже, патч поменялся после применения. Откатите их (git checkout -- ${p.files.join(' ')}) и повторите шаг`;
    } else if (own > 0) {
      warnings.push(`Патч ${p.name} не совпадает с веткой ${branch}: похоже, конфиг в ветке уже правили руками, публикуется то, что в ветке`);
    } else {
      blocker ??= `Патч ${p.name} не ложится на ветку ${branch}: ${p.reason}. Обновите патч в ${c.paths.docs}`;
    }
  }
  let pr: PullRequestRef | null = null;
  if (onRemote) {
    const prs = await c.ports.scm.openPullRequests(t.scm, branch);
    if (prs === null) throw new Error(`Bitbucket не видит ветку ${branch} в ${where(t)}, хотя она есть на ${deploy.remote}`);
    pr = prs.find((p) => !p.to || p.to === deploy.baseBranch) ?? null;
  }
  const state: State = {
    branch,
    fresh: !onRemote,
    worktree,
    head,
    unpushed,
    own,
    patches,
    changed,
    diff: await changesDiff(git, worktree, changed),
    blocker,
    warnings,
    pr,
  };
  c.scratch.set(cacheKey(branch), state);
  return state;
}

function toCommit(s: State): boolean {
  return s.changed.length > 0;
}

function toPush(s: State): boolean {
  return toCommit(s) || s.unpushed.length > 0;
}

/** Все опубликовано: изменения в ветке, ветка на remote и PR открыт. */
function published(s: State): boolean {
  return !s.blocker && !s.patches.some((p) => p.state === 'apply') && !toPush(s) && s.pr !== null && s.own > 0;
}

/** Проверяет, что публиковать можно и есть что; иначе ошибка с причиной. */
function mustPublish(s: State): void {
  if (s.blocker) throw new Error(s.blocker);
  const pending = s.patches.filter((p) => p.state === 'apply');
  if (pending.length) throw new Error(`Патч ${pending.map((p) => p.name).join(', ')} еще не применен в ${s.worktree}: нажмите "Повторить"`);
  if (published(s)) throw new Error(`Конфиг деплоя уже опубликован, PR #${s.pr!.id}: нажмите "Повторить", шаг отметит его готовым`);
  if (!toPush(s) && !s.own) throw new Error(`В ветке ${s.branch} нет правки конфига: нажмите "Повторить", правку внесет агент`);
}

/** Изменения задачи в репозитории сервиса: файлы ветки и изменения конфигурации сервиса для задания агенту. */
async function serviceChanges(c: StepContext): Promise<{ worktree: string; branch: string; base: string; files: string; config: string } | null> {
  const worktree = c.get<string>('worktree');
  if (!worktree || !existsSync(worktree)) return null;
  const { git } = c.ports;
  const base = `${c.repo.remote}/${c.repo.baseBranch}`;
  const fork = await git.tryRun(worktree, ['merge-base', 'HEAD', base]);
  const branch = releaseBranch(c);
  if (fork.code !== 0) return { worktree, branch, base, files: 'не удалось сравнить с базовой веткой', config: 'нет' };
  // Сравнение рабочей папки с развилкой: в него входят и закоммиченные, и еще не закоммиченные изменения задачи.
  const status = lines((await git.run(worktree, ['diff', '--name-status', '--no-renames', fork.stdout.trim()])).stdout);
  const paths = status.map((l) => l.split('\t')[1]!).filter(Boolean);
  const configFiles = paths.filter((p) => SERVICE_CONFIG.test(p));
  const diff = configFiles.length ? lines((await git.run(worktree, ['diff', '--no-color', fork.stdout.trim(), '--', ...configFiles])).stdout) : [];
  const config = diff.length > SERVICE_CONFIG_LINES ? [...diff.slice(0, SERVICE_CONFIG_LINES), `... еще ${diff.length - SERVICE_CONFIG_LINES} строк`].join('\n') : diff.join('\n');
  return { worktree, branch, base, files: status.map((l) => l.replace('\t', ' ')).join('\n') || 'нет', config: config || 'нет' };
}

/** Задание агенту, который вносит правку конфига: задача, план, изменения сервиса и устройство репозитория деплоя. */
async function configPrompt(c: StepContext, t: Target, s: State): Promise<string> {
  const issue = c.get<Issue>('issue') ?? (await c.ports.jira.getIssue(c.run.issueKey));
  const plan = approvedPlan(c)?.plan;
  const service = await serviceChanges(c);
  return `${renderTemplate(readText(import.meta.url, './config.md'), {
    key: issue.key,
    summary: issue.summary,
    repo: where(t),
    branch: s.branch,
    base: `${t.deploy.remote}/${t.deploy.baseBranch}`,
    service: c.repo.bitbucket?.repo ?? c.repo.id,
    code: service
      ? `Код сервиса с изменениями задачи лежит в ${service.worktree}, ветка ${service.branch} от ${service.base}. Смотри его командами git -C ${service.worktree} diff, log и show и инструментами чтения.`
      : 'Рабочей папки с кодом задачи в этом прогоне нет: правку определяй по задаче и плану.',
    plan: plan ? `Утвержденный план задачи лежит в файле ${plan.file}: прочитай в нем то, что касается конфига и окружений.` : 'Утвержденного плана нет.',
    description: issue.description.trim() || 'описания нет',
    ac: acText(acOf(c)),
    files: service?.files ?? 'нет',
    config: service?.config ?? 'нет',
    notes: t.deploy.notes?.length ? t.deploy.notes.map((n) => `- ${n}`).join('\n') : '- заметок нет: устройство смотри по файлам и истории правок',
    // Замечание без прежней сессии агента: правка прошлой попытки уже лежит в папке, и агент дорабатывает ее.
    feedback: c.feedback ? `\n\nВ рабочей папке уже есть правка прошлой попытки. Владелец просит доработать ее:\n<замечание>\n${c.feedback}\n</замечание>` : '',
  })}\n\n${agentRules(c)}`;
}

/**
 * Правка конфига агентом в рабочей папке ветки: по задаче, плану, изменениям сервиса и истории похожих правок. Агент
 * пишет только в эту папку, из git ему доступно только чтение, значения, которых нет в задаче и коде, и ссылки на
 * секреты он спрашивает у владельца. По замечанию владельца агент продолжает свою сессию.
 */
async function writeConfig(c: StepContext, t: Target, s: State, previous: Config | null): Promise<Config> {
  const resume = previous && c.feedback ? previous.sessionId : undefined;
  const prompt = resume ? renderTemplate(readText(import.meta.url, './config-rework.md'), { feedback: c.feedback }) : await configPrompt(c, t, s);
  const service = c.get<string>('worktree');
  const serviceGit = service ? ['diff', 'log', 'show'].map((cmd) => `Bash(git -C ${service} ${cmd} *)`) : [];
  const r = await c.agent.run({ label: CONFIG_LABEL, prompt, cwd: s.worktree, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], allow: [...GIT_READ, ...serviceGit], schema: CONFIG_SCHEMA, resume });
  const o = (r.output ?? {}) as Record<string, unknown>;
  const summary = typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : r.text.trim();
  const config: Config = { sessionId: r.sessionId, summary, secrets: strings(o.secrets), remarks: strings(o.remarks) };
  c.log(`Агент внес правку конфига в ${s.worktree}: ${summary || 'итога нет'}`);
  return config;
}

async function draftPrompt(c: StepContext, t: Target, s: State, feedback: string | null, config: Config | null): Promise<string> {
  const { git } = c.ports;
  const base = `${t.deploy.remote}/${t.deploy.baseBranch}`;
  const fork = (await git.run(s.worktree, ['merge-base', 'HEAD', base])).stdout.trim();
  // Дифф ветки вместе с рабочей папкой: в промпт идут только имена файлов и переменных, значений агент не видит.
  const whole = `${(await git.run(s.worktree, ['diff', '--no-color', fork])).stdout}${s.diff}`;
  const stat = lines((await git.run(s.worktree, ['diff', '--numstat', fork])).stdout).map((l) => {
    const [added, removed, path] = l.split('\t');
    return `${path} (+${added}, -${removed})`;
  });
  const fresh = s.changed.filter((p) => !stat.some((x) => x.startsWith(`${p} `))).map((p) => `${p} (новый)`);
  const keys = diffKeys(whole);
  const issue = c.get<Issue>('issue') ?? (await c.ports.jira.getIssue(c.run.issueKey));
  const recent = (await git.run(s.worktree, ['log', '--no-merges', '--format=%s', '-12', base])).stdout.trim();
  return `${renderTemplate(readText(import.meta.url, './prompt.md'), {
    key: issue.key,
    summary: issue.summary,
    url: issue.url,
    repo: where(t),
    branch: s.branch,
    base,
    files: [...stat, ...fresh].join('\n') || 'нет',
    added: [...keys.added, ...keys.changed].join(', ') || 'не распознаны',
    removed: keys.removed.join(', ') || 'нет',
    secrets: config?.secrets.join('; ') || 'нет',
    recent: recent || 'коммитов нет',
    feedback: feedback ? `\n\nЗамечание владельца к прошлой версии правки и текстов: ${feedback}` : '',
  })}\n\n${agentRules(c)}`;
}

/**
 * Конфиг деплоя задачи в репозитории k8s-ansible. Шаг берет ветку с именем ветки задачи (или единственную ветку
 * задачи, заведенную раньше кнопкой Create branch), а без нее заводит такую ветку от базовой в отдельной папке сам:
 * на remote она появится с пушем, и скрипт деплоя найдет ее без Customize Deploy, если деплой контура берет ветку
 * по имени; где ветку задачи задает только Customize Deploy (`deploy.ansibleBranch: customize` профиля контура),
 * превью об этом предупреждает. Правку дают патчи <имя репозитория>*.patch из доков задачи, а без них ее пишет агент
 * по задаче, плану и изменениям сервиса, заполняя все окружения сервиса; значения, которых он не нашел, и ссылки на
 * секреты агент спрашивает у владельца. Одно подтверждение закрывает коммит, пуш и PR; тексты готовит второй агент
 * только по именам файлов и переменных, значения в тексты не попадают. Подтверждение привязано к диффу рабочей папки.
 */
const step: StepModule = {
  async done(c) {
    const t = targetOf(c);
    const { branch, fresh } = await branchOf(c, t);
    if (fresh) return null;
    // В пробном прогоне папка ветки не создается: без нее проверить патчи нечем.
    const s = await inspect(c, t, branch, !c.run.dryRun);
    if (!s || !published(s)) return null;
    return {
      note: [`Конфиг деплоя опубликован: ветка ${branch}, PR #${s.pr!.id}`, ...s.warnings].join('; '),
      outputs: { ansibleBranch: branch, ansiblePr: s.pr! },
    };
  },

  async prepare(c) {
    const t = targetOf(c);
    const previous = c.draft as Draft | undefined;
    const branch = previous?.branch ?? (await branchOf(c, t)).branch;
    let s = (await inspect(c, t, branch, true))!;
    if (s.blocker) throw new Error(s.blocker);
    let config = previous?.config ?? null;
    const again = () => {
      c.scratch.delete(cacheKey(branch));
      return inspect(c, t, branch, true) as Promise<State>;
    };
    if (s.patches.length) {
      const pending = s.patches.filter((p) => p.state === 'apply');
      for (const p of pending) {
        await c.ports.git.run(s.worktree, ['apply', '-p1', p.path]);
        c.log(`Патч ${p.name} применен в ${s.worktree}: ${p.files.join(', ')}`);
      }
      if (pending.length) s = await again();
    } else if (c.feedback || (!s.changed.length && !s.own)) {
      // Без патча правку пишет агент: в пустой ветке - с начала, по замечанию владельца - в своей прежней сессии.
      config = await writeConfig(c, t, s, config);
      s = await again();
      if (s.blocker) throw new Error(s.blocker);
      if (!s.changed.length && !s.own) throw new Error(`Агент не нашел, что менять в конфиге деплоя: ${config.summary || 'итога нет'}. Если конфиг задаче не нужен, пропустите шаг`);
    }
    mustPublish(s);
    // Коммитить нечего и PR уже есть: осталось запушить свои коммиты ветки, тексты не нужны.
    if (!toCommit(s) && s.pr) return { branch, config, sessionId: null, subject: '', body: '', prTitle: '', prDescription: '', fixed: [] } satisfies Draft;
    // Замечание к правке агента уже учел агент конфига, тексты пишутся заново по новой правке; к патчу или ручной
    // правке замечание относится только к текстам, и их агент переделывает в своей сессии.
    const resume = c.feedback && !config && previous?.sessionId ? previous.sessionId : undefined;
    const prompt = resume
      ? renderTemplate(readText(import.meta.url, './rework.md'), { feedback: c.feedback, commit: commitMessage(previous!), prTitle: previous!.prTitle, prDescription: previous!.prDescription })
      : await draftPrompt(c, t, s, c.feedback, config);
    const r = await c.agent.run({ label: LABEL, prompt, cwd: s.worktree, tools: [], writeCwd: false, schema: TEXTS_SCHEMA, resume });
    return { branch, config, ...finishTexts(c, textsOutput(r.output)), sessionId: r.sessionId } satisfies Draft;
  },

  async preview(c) {
    const t = targetOf(c);
    const d = c.draft as Draft;
    const config = d.config ?? null;
    const s = (await inspect(c, t, d.branch, true))!;
    mustPublish(s);
    const actions: string[] = [];
    const texts: PreviewText[] = [];
    if (s.fresh) actions.push(`Завести ветку ${s.branch} в ${where(t)} от ${t.deploy.baseBranch}: ее создаст пуш`);
    if (toCommit(s)) {
      if (!d.subject) throw new Error('Состав публикации изменился после подготовки текстов: нажмите "Повторить"');
      actions.push(`Коммит в ${s.branch} репозитория ${where(t)}, файлов: ${s.changed.length} (${s.changed.join(', ')})`);
      texts.push({ id: 'commit', label: 'Сообщение коммита', text: commitMessage(d), publish: true });
    }
    if (toPush(s)) {
      const own = s.unpushed.length ? `; уже есть коммиты, которых нет на remote: ${s.unpushed.join('; ')}` : '';
      actions.push(`Пуш ${s.branch} в ${t.deploy.remote}${s.fresh ? ', новая ветка' : ''}, коммитов: ${s.unpushed.length + (toCommit(s) ? 1 : 0)}${own}`);
    }
    if (!s.pr) {
      if (!d.prTitle) throw new Error('Состав публикации изменился после подготовки текстов: нажмите "Повторить"');
      actions.push(`Создать PR ${s.branch} → ${t.deploy.baseBranch} в ${where(t)}`);
      texts.push({ id: 'prTitle', label: 'Заголовок PR', text: d.prTitle, publish: true }, { id: 'prDescription', label: 'Описание PR', text: d.prDescription, publish: true, format: 'markdown' });
    }
    if (s.diff) texts.push({ id: 'diff', label: `Изменения в ${s.worktree}`, text: s.diff, publish: false });
    // Скрипт деплоя сам берет ветку k8s-ansible с именем ветки релиза; другую задает только Customize Deploy.
    const release = releaseBranch(c);
    const deploy = customizeOnly(c.contour)
      ? `После публикации деплой задачи пойдет через Customize Deploy с веткой k8s-ansible ${s.branch}: деплой контура ${c.contour!.title} ветку задачи сам не берет, и кнопку Deploy в Bamboo нажимаете вы`
      : s.branch === release
        ? `После публикации деплой задачи возьмет конфиг из ветки k8s-ansible ${s.branch} сам: она названа как ветка задачи`
        : `После публикации деплой задачи пойдет через Customize Deploy с веткой k8s-ansible ${s.branch}: она названа не как ветка задачи ${release}, и кнопку Deploy в Bamboo нажимаете вы`;
    const summary = [config?.summary, s.pr ? `PR #${s.pr.id} уже открыт, новый коммит попадет в него: ${s.pr.url}` : null].filter(Boolean).join('\n\n');
    return {
      title: `Конфиг деплоя ${c.run.issueKey}: ${where(t)}`,
      summary: summary || `Ветка ${s.branch}`,
      actions,
      warnings: [...(config?.secrets ?? []).map((x) => `Секрет нужно завести до деплоя: ${x}`), ...(config?.remarks ?? []), ...s.warnings, deploy],
      texts,
      lint: d.fixed,
      payload: {
        repo: where(t),
        branch: s.branch,
        fresh: s.fresh,
        worktree: s.worktree,
        head: s.head,
        diff: sha256(s.diff),
        patches: s.patches.map((p) => ({ name: p.name, hash: p.hash, state: p.state })),
        push: toPush(s) ? s.unpushed : null,
        pr: s.pr ? { id: s.pr.id } : { create: true },
      },
    };
  },

  async simulate(c) {
    return { ansibleBranch: releaseBranch(c) };
  },

  async run(c) {
    const t = targetOf(c);
    const d = c.draft as Draft;
    const s = (await inspect(c, t, d.branch, true))!;
    mustPublish(s);
    const { git } = c.ports;
    const wt = s.worktree;
    if (toCommit(s)) {
      // Подтвержден ровно этот дифф: если файлы поменялись после показа, коммит не делается.
      if ((await changesDiff(git, wt, s.changed)) !== s.diff) throw new Error(`Файлы в ${wt} изменились после подтверждения: коммит не сделан, подтвердите заново`);
      await git.run(wt, ['reset', '-q']);
      await git.run(wt, ['--literal-pathspecs', 'add', '-A', '--', ...s.changed]);
      const staged = lines((await git.run(wt, ['diff', '--cached', '--name-only', '--no-renames'])).stdout);
      const extra = staged.filter((p) => !s.changed.includes(p));
      if (extra.length || staged.length !== s.changed.length) throw new Error(`В индексе не то, что подтверждено: ${staged.join(', ')}`);
      mkdirSync(c.paths.run, { recursive: true });
      const file = join(c.paths.run, 'ansible-commit-message.txt');
      writeFileSync(file, `${commitMessage(d)}\n`);
      await git.run(wt, ['commit', '-q', '-F', file]);
      // Хуки репозитория могут изменить коммит: пушится только подтвержденное.
      const left = (await git.run(wt, ['--literal-pathspecs', 'diff', 'HEAD', '--name-only', '--', ...s.changed])).stdout.trim();
      const committed = (await git.run(wt, ['log', '-1', '--format=%B', 'HEAD'])).stdout.trim();
      if (left || !committed.startsWith(commitMessage(d).trim())) {
        throw new Error(`Коммит отличается от подтвержденного (${left ? `файлы: ${left.replace(/\n/g, ', ')}` : 'сообщение коммита'}), пуш не выполнен. Отменить коммит: git reset --soft HEAD~1 в ${wt}`);
      }
      c.log(`Коммит ${(await git.run(wt, ['rev-parse', '--short', 'HEAD'])).stdout.trim()}: ${d.subject}`);
    }
    if (toPush(s)) {
      // Без force: если на remote появились чужие коммиты, пуш откажет, и шаг покажет это на повторе. Новую ветку
      // пуш и заводит, сразу с отслеживанием remote.
      await git.run(wt, ['push', ...(s.fresh ? ['-u'] : []), t.deploy.remote, `HEAD:refs/heads/${s.branch}`]);
      c.log(s.fresh ? `Ветка ${s.branch} заведена в ${where(t)} пушем` : `Пуш ${s.branch} в ${where(t)}`);
    }
    let pr = s.pr;
    if (!pr) {
      pr = await c.ports.scm.createPullRequest(t.scm, { title: d.prTitle, description: d.prDescription, from: s.branch, to: t.deploy.baseBranch, reviewers: t.deploy.bitbucket?.reviewers ?? [] });
      c.log(`PR #${pr.id}: ${pr.url}`);
    }
    return { ansibleBranch: s.branch, ansiblePr: pr };
  },
};

export default step;
