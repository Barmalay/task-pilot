import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Changes, GitPort, Issue, LintIssue, MilestonePlan, Plan, PreviewText, PrReview, PullRequestRef, QaFix, ScmRepoRef, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { renderTemplate, walkTransitions } from '../../packages/step-kit/src/index.ts';
import { moveOf, moveOffText, transitionIds, transitionText } from '../_shared/board.ts';
import { agentRules, GIT_READ, mergeBase, readText, sha256, worktreeOf } from '../_shared/agent.ts';
import { commitMessage as message, finishTexts, TEXTS_SCHEMA, textsOutput } from '../_shared/texts.ts';
import { classify, isTestPath, parsePorcelain, removesLines, styleOffenders, testChanges, unmergedPaths, type FileChange } from './changes.ts';

const LABEL = 'тексты публикации';
const MILESTONE = 'review';
/** Незаконченные операции git: коммитить и пушить поверх них нельзя. */
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'];

/** Тексты публикации, которые готовит агент. */
interface Draft {
  sessionId: string | null;
  subject: string;
  body: string;
  prTitle: string;
  prDescription: string;
  /** Что линтер исправил в текстах сам: показывается на подтверждении. */
  fixed: LintIssue[];
  /** Какие тексты были нужны, когда их готовили: если позже понадобились другие, черновик устарел. */
  needs: { commit: boolean; pr: boolean };
}

/** Что сейчас в рабочей папке, на remote, в Bitbucket и Jira. */
interface State {
  worktree: string;
  branch: string;
  head: string;
  included: FileChange[];
  excluded: FileChange[];
  tests: { deleted: string[]; modified: string[]; extended: string[] };
  /** Содержимое подтверждаемых файлов: id блоба или 'deleted' для удаляемых. */
  blobs: Record<string, string>;
  diffHash: string;
  remoteSha: string | null;
  /** Коммиты, которых нет на remote, без будущего коммита. */
  ahead: number;
  /** Ветка на remote переписана ребейзом: нужен --force-with-lease. */
  force: boolean;
  /** Почему публиковать нельзя: на remote есть коммиты, которых нет локально. */
  blocker: string | null;
  scm: ScmRepoRef | null;
  pr: PullRequestRef | null;
  issue: Issue;
  jiraPlan: MilestonePlan;
  /** Перевод по доске выключен настройкой шага: задача остается в своем статусе. */
  moveOff: boolean;
  /** Перевод выключен пустой вехой доски, а не настройкой шага. */
  moveByBoard: boolean;
  /** Файлы, в добавленных строках которых нарушены правила стиля текстов. */
  styled: string[];
}

function worktreeReady(c: StepContext): boolean {
  const worktree = c.get<string>('worktree');
  return !!worktree && existsSync(worktree);
}

function lines(out: string): string[] {
  return out.split('\n').filter(Boolean);
}

function nul(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/** Id блобов файлов так, как их запишет git add: с фильтрами git; у символической ссылки - ее путь. */
async function blobIds(git: GitPort, cwd: string, files: FileChange[]): Promise<Record<string, string>> {
  const blobs: Record<string, string> = {};
  const regular: string[] = [];
  for (const f of files) {
    if (f.status === 'D') {
      blobs[f.path] = 'deleted';
      continue;
    }
    const full = join(cwd, f.path);
    if (lstatSync(full).isSymbolicLink()) {
      const target = Buffer.from(readlinkSync(full));
      blobs[f.path] = createHash('sha1').update(`blob ${target.length}\0`).update(target).digest('hex');
    } else {
      regular.push(f.path);
    }
  }
  if (regular.length) {
    const ids = lines((await git.run(cwd, ['hash-object', '--', ...regular])).stdout);
    regular.forEach((p, i) => (blobs[p] = ids[i]!));
  }
  return blobs;
}

/** Первые коммиты из списка: короткий id и заголовок. */
async function describeCommits(git: GitPort, cwd: string, shas: string[]): Promise<string> {
  const shown = await Promise.all(shas.slice(0, 5).map(async (sha) => (await git.run(cwd, ['show', '-s', '--format=%h %s', sha])).stdout.trim()));
  return `${shown.join('; ')}${shas.length > 5 ? ` и еще ${shas.length - 5}` : ''}`;
}

async function inspect(c: StepContext): Promise<State> {
  const cached = c.scratch.get('state') as State | undefined;
  if (cached) return cached;
  if (c.contour && !c.contour.connected) throw new Error(`Контур ${c.contour.title} еще не подключен${c.contour.note ? `: ${c.contour.note}` : ''}`);
  const { git } = c.ports;
  const worktree = worktreeOf(c);
  const branch = c.get<string>('branch');
  if (!branch) throw new Error('Нет ветки задачи: сначала нужен шаг "Ветка"');
  const current = (await git.run(worktree, ['branch', '--show-current'])).stdout.trim();
  if (current !== branch) throw new Error(`В ${worktree} открыта ветка ${current || '(detached)'}, а не ${branch}`);
  for (const ref of IN_PROGRESS) {
    if ((await git.tryRun(worktree, ['rev-parse', '-q', '--verify', ref])).code === 0) {
      throw new Error(`В ${worktree} не закончена операция git (${ref}): завершите или отмените ее вручную`);
    }
  }
  const status = (await git.run(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
  const conflicts = unmergedPaths(status);
  if (conflicts.length) throw new Error(`В ${worktree} есть неразрешенные конфликты: ${conflicts.join(', ')}`);
  const remote = c.repo.remote;
  await git.run(worktree, ['fetch', remote, '--prune']);
  const { included, excluded } = classify(parsePorcelain(status), c.repo.commitPaths);
  const base = await mergeBase(c, worktree);
  const committed = lines((await git.run(worktree, ['diff', '--name-status', '--no-renames', base, 'HEAD'])).stdout)
    .map((line) => line.split('\t'))
    .filter(([s, path]) => s && path)
    .map(([s, path]) => ({ path: path!, status: s! }));
  const tracked = included.filter((f) => f.status !== '?').map((f) => f.path);
  const diff = tracked.length ? (await git.run(worktree, ['--literal-pathspecs', 'diff', 'HEAD', '--no-color', '--binary', '--', ...tracked])).stdout : '';
  const blobs = await blobIds(git, worktree, included);
  const head = (await git.run(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const r = await git.tryRun(worktree, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
  const remoteSha = r.code === 0 ? r.stdout.trim() : null;
  let force = false;
  let blocker: string | null = null;
  if (remoteSha && remoteSha !== head && (await git.tryRun(worktree, ['merge-base', '--is-ancestor', remoteSha, 'HEAD'])).code !== 0) {
    if ((await git.tryRun(worktree, ['merge-base', '--is-ancestor', 'HEAD', remoteSha])).code === 0) {
      const newer = lines((await git.run(worktree, ['rev-list', `HEAD..${remoteSha}`])).stdout);
      blocker = `На ${remote} в ветке ${branch} есть коммиты, которых нет локально: ${await describeCommits(git, worktree, newer)}. Подтяните их, повторив шаг "Ветка"`;
    } else {
      // Ребейз переписывает коммиты, но их изменения остаются: у каждого коммита remote должен быть эквивалент в ветке.
      const foreign = lines((await git.run(worktree, ['cherry', 'HEAD', remoteSha])).stdout)
        .filter((l) => l.startsWith('+ '))
        .map((l) => l.slice(2).trim());
      if (foreign.length) {
        blocker = `На ${remote} в ветке ${branch} есть коммиты, которых нет в локальной ветке: ${await describeCommits(git, worktree, foreign)}. Force push стер бы их, разберитесь вручную`;
      } else {
        force = true;
      }
    }
  }
  const aheadRange = remoteSha ? `${remoteSha}..HEAD` : `${remote}/${c.repo.baseBranch}..HEAD`;
  const ahead = Number((await git.run(worktree, ['rev-list', '--count', aheadRange])).stdout.trim());
  const bb = c.repo.bitbucket;
  const scm = bb ? { contour: c.repo.contour, project: bb.project, repo: bb.repo } : null;
  let pr: PullRequestRef | null = null;
  if (scm && remoteSha) {
    const prs = await c.ports.scm.openPullRequests(scm, branch);
    if (prs === null) {
      throw new Error(`Bitbucket не видит ветку ${branch} в ${scm.project}/${scm.repo}, хотя она есть на ${remote}: проверьте bitbucket.project и bitbucket.repo в профиле`);
    }
    pr = prs.find((p) => !p.to || p.to === c.repo.baseBranch) ?? null;
  }
  const issue = await c.ports.jira.getIssue(c.run.issueKey);
  const move = moveOf(c, issue.status, MILESTONE);
  const jiraPlan: MilestonePlan = move.plan;
  const published = new Set([...committed.map((f) => f.path), ...included.map((f) => f.path)]);
  const touchedTests = [...new Set([...committed, ...included].filter((f) => f.status === 'M' && isTestPath(f.path)).map((f) => f.path))];
  const reduced = new Set<string>();
  for (const path of touchedTests) {
    if (removesLines((await git.run(worktree, ['--literal-pathspecs', 'diff', '--no-color', '-U0', base, '--', path])).stdout)) reduced.add(path);
  }
  const baseDiff = (await git.run(worktree, ['diff', '--no-color', '-U0', base])).stdout;
  const newFiles = included
    .filter((f) => f.status === '?')
    .map((f) => ({ path: f.path, buf: readFileSync(join(worktree, f.path)) }))
    .filter((f) => !f.buf.includes(0))
    .map((f) => ({ path: f.path, text: f.buf.toString('utf8') }));
  const state: State = {
    worktree,
    branch,
    head,
    included,
    excluded,
    tests: testChanges([...committed, ...included], reduced),
    blobs,
    diffHash: sha256(`${diff}\n${JSON.stringify(blobs)}`),
    remoteSha,
    ahead,
    force,
    blocker,
    scm,
    pr,
    issue,
    jiraPlan,
    moveOff: move.off,
    moveByBoard: move.byBoard,
    styled: styleOffenders(baseDiff, newFiles, c.texts.style).filter((p) => published.has(p)),
  };
  c.scratch.set('state', state);
  return state;
}

function commitsToPush(s: State): number {
  return s.ahead + (s.included.length ? 1 : 0);
}

function needsPush(s: State): boolean {
  return !s.blocker && (commitsToPush(s) > 0 || s.force);
}

/** Какие тексты нужны сейчас: сообщение коммита и тексты нового PR. */
function textNeeds(s: State): { commit: boolean; pr: boolean } {
  return { commit: s.included.length > 0, pr: s.scm !== null && s.pr === null };
}

/** Проверяет, что есть что публиковать; ветка без коммитов и изменений из allowlist - ошибка. */
function mustPublish(s: State): void {
  if (s.blocker) throw new Error(s.blocker);
  if (!s.included.length && !needsPush(s) && s.remoteSha === null) {
    const rest = s.excluded.length ? `; вне allowlist: ${list(s.excluded)}` : '';
    throw new Error(`Публиковать нечего: в ветке ${s.branch} нет коммитов и изменений из allowlist${rest}`);
  }
}

function list(files: FileChange[], limit = 8): string {
  const names = files.map((f) => f.path);
  return names.length > limit ? `${names.slice(0, limit).join(', ')} и еще ${names.length - limit}` : names.join(', ');
}

async function draftPrompt(c: StepContext, s: State, feedback: string | null): Promise<string> {
  const { git } = c.ports;
  const base = `${c.repo.remote}/${c.repo.baseBranch}`;
  const stat = (await git.run(s.worktree, ['diff', '--stat', await mergeBase(c, s.worktree)])).stdout.trim();
  const fresh = s.included.filter((f) => f.status === '?').map((f) => ` ${f.path} (новый)`);
  const recent = (await git.run(s.worktree, ['log', '--format=%s', '-12', base])).stdout.trim();
  const plan = c.get<Plan>('plan');
  const changes = c.get<Changes>('changes');
  // Коммит после доработки по тесту или по замечаниям ревью описывает эту доработку, а не всю задачу заново;
  // из двух доработок в прогоне берется последняя.
  const qaFix = c.get<QaFix>('qaFix');
  const review = c.get<PrReview>('prReview');
  const reworks = [
    qaFix ? { at: qaFix.at, text: `Коммит - доработка после теста на стенде, круг ${qaFix.round}: ${qaFix.summary.trim().replace(/\.+$/, '')}.` } : null,
    review?.pending && review.files.length ? { at: review.at, text: `Коммит - исправления по замечаниям ревьюеров в PR #${review.pr}: ${review.summary.trim().replace(/\.+$/, '')}.` } : null,
  ].filter((x): x is { at: string; text: string } => x !== null);
  const rework = reworks.sort((a, b) => b.at.localeCompare(a.at))[0];
  return `${renderTemplate(readText(import.meta.url, './prompt.md'), {
    key: s.issue.key,
    summary: s.issue.summary,
    url: s.issue.url,
    base,
    plan: plan ? `Суть утвержденного плана: ${plan.summary}` : '',
    changes: [
      changes?.summary ? `Что сделала реализация: ${changes.summary}` : '',
      rework ? `${rework.text} Заголовок коммита - о доработке, а не обо всей задаче.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    diffStat: [stat, ...fresh].filter(Boolean).join('\n') || 'изменений нет',
    recent: recent || 'коммитов нет',
    feedback: feedback ? `\n\nЗамечание владельца к прошлой версии текстов: ${feedback}` : '',
  })}\n\n${agentRules(c)}`;
}

/** Пути в индексе, отличающиеся от HEAD; переименование видно как удаление и добавление. */
async function stagedPaths(git: GitPort, cwd: string): Promise<string[]> {
  return nul((await git.run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z'])).stdout);
}

/**
 * Id блобов путей в индексе (ls-files -s: режим, id, стадия) или в коммите (ls-tree: режим, тип, id).
 * Без путей ничего не запрашивается: ls-tree без путей выдал бы все дерево.
 */
async function blobsOf(git: GitPort, cwd: string, args: string[], paths: string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map();
  const out = nul((await git.run(cwd, ['--literal-pathspecs', ...args, '--', ...paths])).stdout);
  return new Map(
    out.map((e) => {
      const tab = e.indexOf('\t');
      const id = e.slice(0, tab).split(' ').find((x) => /^[0-9a-f]{40,64}$/.test(x)) ?? '';
      return [e.slice(tab + 1), id] as const;
    }),
  );
}

/** Расхождения между подтвержденным содержимым и тем, что лежит в индексе или коммите. */
function blobMismatches(expected: Record<string, string>, actual: Map<string, string>): string[] {
  return Object.entries(expected)
    .filter(([path, id]) => (id === 'deleted' ? actual.has(path) : actual.get(path) !== id))
    .map(([path]) => path);
}

/**
 * Публикация ветки одним подтверждением: коммит только файлов из allowlist профиля, пуш
 * (после ребейза с --force-with-lease на ту версию ветки, которую видел владелец), PR в базовую
 * ветку и перевод задачи к вехе review. Тексты готовит агент, линтер их правит, владелец видит и
 * подтверждает ровно их. Содержимое файлов закреплено id блобов: если файл изменился после
 * подтверждения или хук переписал коммит, пуш не выполняется. Каждое действие проверяет текущее
 * состояние, поэтому повтор после сбоя делает только недостающее.
 */
const step: StepModule = {
  async done(c) {
    // В пробном прогоне шаг "Ветка" только имитируется, и рабочей папки может не быть.
    if (c.run.dryRun && !worktreeReady(c)) return null;
    const s = await inspect(c);
    const published = !s.blocker && !s.included.length && !needsPush(s) && s.remoteSha !== null && (s.pr !== null || s.scm === null) && s.jiraPlan.kind !== 'transitions';
    if (!published) return null;
    const notes = [s.pr ? `Все опубликовано: PR #${s.pr.id}` : 'Все опубликовано'];
    if (s.excluded.length) notes.push(`вне allowlist остались изменения: ${list(s.excluded)}`);
    if (s.jiraPlan.kind === 'blocked') notes.push(`Jira: ${s.jiraPlan.reason}`);
    return { note: notes.join('; '), outputs: { commitSha: s.head, pr: s.pr ?? undefined, status: s.issue.status } };
  },

  async prepare(c) {
    const s = await inspect(c);
    mustPublish(s);
    const needs = textNeeds(s);
    // Коммитить нечего и PR уже есть: текстов для публикации нет.
    if (!needs.commit && !needs.pr) return { sessionId: null, subject: '', body: '', prTitle: '', prDescription: '', fixed: [], needs } satisfies Draft;
    const previous = c.draft as Draft | undefined;
    const resume = c.feedback && previous?.sessionId ? previous.sessionId : undefined;
    const prompt = resume
      ? renderTemplate(readText(import.meta.url, './rework.md'), {
          feedback: c.feedback,
          commit: message(previous!),
          prTitle: previous!.prTitle,
          prDescription: previous!.prDescription,
        })
      : await draftPrompt(c, s, c.feedback);
    const r = await c.agent.run({ label: LABEL, prompt, cwd: s.worktree, tools: ['Read', 'Grep', 'Glob', 'Bash'], allow: GIT_READ, schema: TEXTS_SCHEMA, resume });
    return { ...finishTexts(c, textsOutput(r.output)), sessionId: r.sessionId, needs } satisfies Draft;
  },

  async preview(c) {
    if (c.run.dryRun && !worktreeReady(c)) {
      return {
        title: `${c.run.issueKey}: коммит, пуш и PR`,
        actions: [],
        warnings: ['Пробный прогон: рабочей папки ветки еще нет, состав публикации будет виден после настоящего шага "Ветка"'],
        payload: { dryRun: true },
      };
    }
    const s = await inspect(c);
    mustPublish(s);
    const d = c.draft as Draft;
    const needs = textNeeds(s);
    if ((needs.commit && !d.needs?.commit) || (needs.pr && !d.needs?.pr)) {
      throw new Error('Состав публикации изменился после подготовки текстов: нажмите "Повторить", агент подготовит их заново');
    }
    const actions: string[] = [];
    const warnings: string[] = [];
    const texts: PreviewText[] = [];
    if (!c.repo.commitPaths.length) warnings.push('В профиле репозитория пустой allowlist путей коммита (commitPaths): в коммит ничего не попадет');
    if (s.included.length) {
      actions.push(`Коммит в ${s.branch}, файлов: ${s.included.length} (${list(s.included)})`);
      texts.push({ id: 'commit', label: 'Сообщение коммита', text: message(d), publish: true });
    }
    if (s.excluded.length) warnings.push(`Не войдут в коммит (вне allowlist профиля или служебные): ${list(s.excluded)}`);
    if (s.tests.deleted.length) warnings.push(`Удалены тесты: ${s.tests.deleted.join(', ')}`);
    if (s.tests.modified.length) warnings.push(`Изменены существующие тесты: ${s.tests.modified.join(', ')}`);
    if (s.styled.length) warnings.push(`В текстах кода (Javadoc, комментарии, строки) есть то, что запрещает личный стиль (е с точками, длинное тире, типографские кавычки): ${s.styled.join(', ')}`);
    if (needsPush(s)) {
      actions.push(
        s.force
          ? `Пуш ${s.branch} с --force-with-lease: ветка переписана ребейзом, на remote сейчас ${s.remoteSha!.slice(0, 8)}, все его изменения есть в ветке`
          : `Пуш ${s.branch} в ${c.repo.remote}, коммитов: ${commitsToPush(s)}${s.remoteSha ? '' : ' (новая ветка)'}`,
      );
    }
    if (!s.scm) warnings.push('В профиле репозитория нет Bitbucket: PR создайте вручную');
    else if (!s.pr) {
      actions.push(`Создать PR ${s.branch} → ${c.repo.baseBranch} в ${s.scm.project}/${s.scm.repo}`);
      texts.push({ id: 'prTitle', label: 'Заголовок PR', text: d.prTitle, publish: true }, { id: 'prDescription', label: 'Описание PR', text: d.prDescription, publish: true, format: 'markdown' });
    }
    if (s.jiraPlan.kind === 'transitions') for (const t of s.jiraPlan.steps) actions.push(`Jira: ${transitionText(t)}`);
    if (s.moveOff) actions.push(moveOffText(s.issue.status, s.moveByBoard));
    if (s.jiraPlan.kind === 'blocked') warnings.push(`Jira: ${s.jiraPlan.reason}`);
    return {
      title: `${c.run.issueKey}: коммит, пуш и PR`,
      summary: s.pr ? `PR #${s.pr.id} уже открыт, новые коммиты попадут в него: ${s.pr.url}` : `Ветка ${s.branch}`,
      actions,
      warnings,
      texts,
      lint: d.fixed,
      payload: {
        branch: s.branch,
        head: s.head,
        files: s.included.map((f) => `${f.status} ${f.path}`),
        diffHash: s.diffHash,
        push: needsPush(s) ? { force: s.force, remoteSha: s.remoteSha } : null,
        pr: s.pr ? { id: s.pr.id } : s.scm ? { create: true } : null,
        transitions: s.jiraPlan.kind === 'transitions' ? transitionIds(s.jiraPlan.steps) : [],
      },
    };
  },

  async simulate(c) {
    return { commitSha: 'dry-run', pr: { id: 0, title: 'пробный прогон', url: '' } satisfies PullRequestRef, status: c.get<Issue>('issue')?.status };
  },

  async run(c) {
    const s = await inspect(c);
    mustPublish(s);
    const d = c.draft as Draft;
    const { git } = c.ports;
    const wt = s.worktree;
    let head = s.head;
    if (s.included.length) {
      const paths = s.included.map((f) => f.path);
      const approved = new Set(paths);
      // Индекс не сбрасывается целиком: снимаются только чужие пути, поэтому уже подготовленное
      // переименование (в том числе со сменой регистра на macOS) остается в индексе как есть.
      const foreign = (await stagedPaths(git, wt)).filter((p) => !approved.has(p));
      if (foreign.length) await git.run(wt, ['--literal-pathspecs', 'reset', '-q', '--', ...foreign]);
      await git.run(wt, ['--literal-pathspecs', 'add', '-A', '--', ...paths]);
      const extra = (await stagedPaths(git, wt)).filter((p) => !approved.has(p));
      if (extra.length) throw new Error(`В индексе оказались файлы вне подтвержденного списка: ${extra.join(', ')}`);
      const changed = blobMismatches(s.blobs, await blobsOf(git, wt, ['ls-files', '-s', '-z'], paths));
      if (changed.length) throw new Error(`Файлы изменились после подтверждения: ${changed.join(', ')}. Коммит не сделан, подтвердите заново`);
      mkdirSync(c.paths.run, { recursive: true });
      const file = join(c.paths.run, 'commit-message.txt');
      writeFileSync(file, `${message(d)}\n`);
      await git.run(wt, ['commit', '-q', '-F', file]);
      head = (await git.run(wt, ['rev-parse', 'HEAD'])).stdout.trim();
      // Хуки репозитория могут изменить коммит после проверки индекса: пушится только подтвержденное.
      const inCommit = nul((await git.run(wt, ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', '-z', 'HEAD'])).stdout);
      const committedBlobs = await blobsOf(git, wt, ['ls-tree', '-r', '-z', 'HEAD'], paths.filter((p) => s.blobs[p] !== 'deleted'));
      const differs = [
        ...inCommit.filter((p) => !approved.has(p)),
        ...blobMismatches(s.blobs, committedBlobs).filter((p) => s.blobs[p] !== 'deleted'),
        ...paths.filter((p) => s.blobs[p] === 'deleted' && !inCommit.includes(p)),
      ];
      const committedMessage = (await git.run(wt, ['log', '-1', '--format=%B', 'HEAD'])).stdout.trim();
      if (differs.length || !committedMessage.startsWith(message(d).trim())) {
        const what = differs.length ? `файлы: ${[...new Set(differs)].join(', ')}` : 'сообщение коммита';
        throw new Error(`Коммит ${head.slice(0, 8)} отличается от подтвержденного (${what}), пуш не выполнен. Похоже, его изменил хук репозитория; отменить коммит: git reset --soft HEAD~1`);
      }
      c.log(`Коммит ${head.slice(0, 8)}: ${d.subject}`);
    }
    if (needsPush(s)) {
      const lease = s.force ? [`--force-with-lease=${s.branch}:${s.remoteSha}`] : [];
      await git.run(wt, ['push', ...lease, ...(s.remoteSha ? [] : ['-u']), c.repo.remote, `HEAD:refs/heads/${s.branch}`]);
      c.log(`Пуш ${s.branch}${s.force ? ' с --force-with-lease' : ''}`);
    }
    let pr = s.pr;
    if (!pr && s.scm) {
      pr = await c.ports.scm.createPullRequest(s.scm, { title: d.prTitle, description: d.prDescription, from: s.branch, to: c.repo.baseBranch, reviewers: c.repo.bitbucket?.reviewers ?? [] });
      c.log(`PR #${pr.id}: ${pr.url}`);
    }
    const status = s.jiraPlan.kind === 'transitions' ? await walkTransitions(c.ports.jira, s.issue.key, s.issue.status, s.jiraPlan.steps, c.log) : s.issue.status;
    return { commitSha: head, pr: pr ?? undefined, status };
  },
};

export default step;
