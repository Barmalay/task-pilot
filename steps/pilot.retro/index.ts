import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Improvements, Issue, LintIssue, PilotCheck, RunJournal, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { lineDiff, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, readText, sha256 } from '../_shared/agent.ts';

const LABEL = 'разбор прогона';
const SELF = 'pilot.retro';

const SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Путь из списка файлов: steps/..., team/rules.md или skills/...' },
          reason: { type: 'string', description: 'Какое замечание журнала правка закрывает' },
        },
        required: ['file', 'reason'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'Итог разбора в 1-3 предложениях' },
  },
  required: ['changes', 'summary'],
  additionalProperties: false,
};

/** Правка одного файла: путь для владельца, где файл лежит, было и стало. */
interface Change {
  file: string;
  target: string;
  reason: string;
  before: string;
  after: string;
}

interface Draft {
  sessionId: string;
  summary: string;
  changes: Change[];
  /** Предложения агента, которые шаг не принял, с причиной. */
  skipped: string[];
  check: PilotCheck | null;
  /** Что не дает подтвердить: секреты и имена в добавленных строках, новые подстановки, упавшая проверка. */
  blocks: LintIssue[];
}

/** Журнал без записей самого разбора: его замечания приходят как замечание к черновику. */
function relevant(j: RunJournal): RunJournal {
  const other = <T extends { stepId: string }>(list: T[]) => list.filter((x) => x.stepId !== SELF);
  return { corrections: other(j.corrections), questions: other(j.questions), failures: other(j.failures), denials: other(j.denials), loops: other(j.loops) };
}

function entries(j: RunJournal): { stepId: string; at: string }[] {
  return [...j.corrections, ...j.questions, ...j.failures, ...j.denials, ...j.loops];
}

/** Журнал для промпта: группы по виду записей, пустые группы не показываются. */
export function journalText(j: RunJournal): string {
  const groups: [string, string[]][] = [
    [
      'Замечания владельца на подтверждениях и к повторам упавших шагов',
      j.corrections.map((x) =>
        x.decision === 'retry'
          ? `- ${x.step} (${x.stepId}): повторил упавший шаг${x.title ? ` после ошибки "${x.title}"` : ''}, замечание агенту: ${x.comment ?? ''}`
          : `- ${x.step} (${x.stepId}): ${x.decision === 'rework' ? 'вернул на доработку' : 'отклонил'} "${x.title}"${x.comment ? `, замечание: ${x.comment}` : ', без замечания'}`,
      ),
    ],
    ['Вопросы агентов и ответы владельца', j.questions.map((x) => `- ${x.step} (${x.stepId}): вопрос "${x.question}", ответ "${x.answer}"`)],
    ['Падения шагов', j.failures.map((x) => `- ${x.step} (${x.stepId}): ${x.error}`)],
    ['Отказы агентам в инструментах', j.denials.map((x) => `- ${x.step} (${x.stepId}): ${x.tools.join(', ')}`)],
    ['Круги петель доработки', j.loops.map((x) => `- ${x.step} (${x.stepId}): круг ${x.round} из ${x.max}`)],
  ];
  return groups
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => `${title}:\n${lines.join('\n')}`)
    .join('\n\n');
}

function markdownFiles(dir: string, depth: number, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isFile() && e.name.endsWith('.md')) return [posix.join(prefix, e.name)];
    return e.isDirectory() && depth > 0 ? markdownFiles(join(dir, e.name), depth - 1, posix.join(prefix, e.name)) : [];
  });
}

/**
 * Файлы, которые разбор может править, путь для итога - где файл лежит: промпты шагов из журнала и общие правила шагов
 * Task Pilot, правила текстов команды (team/rules.md - rules.md ее пакета) и скиллы плагина команды. Правятся только
 * существующие файлы: то, что относится только к команде, место в ее правилах и скиллах, а не в общих промптах.
 */
export function editableFiles(c: StepContext, journal: RunJournal): Map<string, string> {
  const { root, skillsDir, teamRules } = c.ports.pilot;
  const files = new Map<string, string>();
  const steps = [...new Set(entries(journal).map((e) => e.stepId)), '_shared'];
  for (const id of steps) {
    for (const f of markdownFiles(join(root, 'steps', id), 0)) files.set(`steps/${id}/${f}`, join(root, 'steps', id, f));
  }
  if (teamRules && existsSync(teamRules)) files.set('team/rules.md', teamRules);
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((s) => existsSync(join(skillsDir, s, 'SKILL.md'))) : [];
  for (const s of skills.sort()) {
    for (const f of markdownFiles(join(skillsDir, s), 1)) files.set(`skills/${s}/${f}`, join(skillsDir, s, f));
  }
  return files;
}

function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(/\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g)].map((m) => m[1]!));
}

/** Что мешает записать правку: секреты, телефоны и имена в добавленных строках, новые подстановки в промпте шага. */
function blocksOf(c: StepContext, ch: Change): LintIssue[] {
  const added = lineDiff(ch.before, ch.after)
    .filter((l) => l.startsWith('+ '))
    .map((l) => l.slice(2))
    .join('\n');
  const issues = c.lint(added).issues.filter((i) => i.severity === 'block').map((i) => ({ ...i, message: `${ch.file}: ${i.message}` }));
  const known = placeholders(ch.before);
  const fresh = [...placeholders(ch.after)].filter((p) => !known.has(p));
  if (ch.file.startsWith('steps/') && fresh.length) {
    issues.push({ rule: 'template', severity: 'block', message: `${ch.file}: новые подстановки ${fresh.join(', ')} - код шага их не передает` });
  }
  return issues;
}

function draftOf(c: StepContext): Draft {
  const d = c.draft as Draft | undefined;
  if (!d) throw new Error('Черновика разбора нет');
  return d;
}

function checkText(check: PilotCheck): string {
  return check.results.map((r) => (r.ok ? r.summary : `${r.summary}\n${r.output.trim()}`)).join('\n\n');
}

/**
 * Разбор прогона: по журналу (замечания владельца на подтверждениях, ответы на вопросы агентов, падения, отказы
 * в инструментах, круги петель) агент предлагает точечные правки промптов шагов и скиллов плагина агентов. Новые версии
 * он пишет в отдельную папку, шаг сверяет пути со списком разрешенных файлов, проверяет добавленные строки
 * линтером и прогоняет тесты шагов на копии Task Pilot с правками. Подтверждение показывает дифф и итог проверки;
 * после него код записывает файлы, если их не меняли с подготовки. Коммит правок Task Pilot - по команде владельца.
 */
const step: StepModule = {
  async done(c) {
    const journal = relevant(await c.ports.pilot.journal(c.run.id));
    const all = entries(journal);
    if (!all.length) return { note: 'В прогоне нет замечаний владельца, ответов на вопросы и сбоев: разбирать нечего' };
    const done = c.get<Improvements>('improvements');
    if (done && all.every((e) => e.at <= done.at)) return { note: `Прогон уже разобран${done.files.length ? `: правки в ${done.files.join(', ')}` : ', правок не понадобилось'}` };
    return null;
  },

  async prepare(c) {
    const journal = relevant(await c.ports.pilot.journal(c.run.id));
    const files = editableFiles(c, journal);
    const staging = join(dirname(c.paths.agentDocs), 'retro');
    const previous = c.draft as Draft | undefined;
    const resume = c.feedback && previous ? previous.sessionId : undefined;
    // Новый разбор начинается с пустой папки, переделка продолжает правки прошлой версии.
    if (!resume) rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const issue = c.get<Issue>('issue');
    const prompt = resume
      ? renderTemplate(readText(import.meta.url, './rework.md'), { feedback: c.feedback, staging })
      : `${renderTemplate(readText(import.meta.url, './prompt.md'), {
          key: c.run.issueKey,
          summary: issue?.summary ?? '',
          journal: journalText(journal),
          files: [...files].map(([rel, abs]) => `- ${rel}: ${abs}`).join('\n'),
          staging,
        })}\n\n${agentRules(c)}`;
    const r = await c.agent.run({
      label: LABEL,
      prompt,
      cwd: c.ports.pilot.root,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      // Правки ложатся только в отдельную папку: настоящие файлы код запишет после подтверждения.
      writeCwd: false,
      writeDirs: [staging],
      schema: SCHEMA,
      resume,
    });
    const o = (r.output ?? {}) as { changes?: unknown; summary?: unknown };
    const changes: Change[] = [];
    const skipped: string[] = [];
    for (const raw of Array.isArray(o.changes) ? (o.changes as Record<string, unknown>[]) : []) {
      if (typeof raw.file !== 'string') continue;
      const file = posix.normalize(raw.file.trim());
      const target = files.get(file);
      const proposal = join(staging, file);
      if (!target) skipped.push(`${raw.file}: этот файл разбору править нельзя`);
      else if (!existsSync(proposal) || !statSync(proposal).isFile()) skipped.push(`${file}: агент не записал новую версию`);
      else if (changes.some((ch) => ch.file === file)) continue;
      else {
        const before = readFileSync(target, 'utf8');
        const after = readFileSync(proposal, 'utf8');
        if (before === after) skipped.push(`${file}: новая версия не отличается от текущей`);
        else changes.push({ file, target, reason: typeof raw.reason === 'string' ? raw.reason.trim() : '', before, after });
      }
    }
    const blocks = changes.flatMap((ch) => blocksOf(c, ch));
    const steps = changes.filter((ch) => ch.file.startsWith('steps/'));
    // Промпты читают тесты шагов: правка проверяется ими на копии Task Pilot, скиллы тестами не покрыты.
    const check = steps.length ? await c.ports.pilot.check(Object.fromEntries(steps.map((ch) => [ch.file, ch.after])), ['steps']) : null;
    if (check && !check.ok) {
      blocks.push({ rule: 'tests', severity: 'block', message: `Проверка с правками не прошла: ${check.results.filter((x) => !x.ok).map((x) => x.summary).join('; ')}` });
    }
    return { sessionId: r.sessionId, summary: typeof o.summary === 'string' ? o.summary : r.text, changes, skipped, check, blocks } satisfies Draft;
  },

  async preview(c) {
    const d = draftOf(c);
    const warnings = d.skipped.map((s) => `Не принято: ${s}`);
    if (!d.changes.length) return { title: 'Разбор прогона: правок нет', summary: d.summary, actions: [], warnings, requiresApproval: false, payload: null };
    const team = d.changes.some((ch) => ch.file.startsWith('skills/') || ch.file.startsWith('team/'));
    return {
      title: `Разбор прогона ${c.run.issueKey}: правки промптов и скиллов`,
      summary: d.summary,
      actions: [
        `Записать файлов: ${d.changes.length} (${d.changes.map((ch) => ch.file).join(', ')})`,
        `Коммит правок - по команде владельца${team ? '; правила и скиллы команды лежат в ее пакете, их правка действует сразу' : ''}`,
      ],
      warnings,
      texts: [
        ...d.changes.map((ch, i) => ({ id: `change-${i}`, label: `${ch.file}${ch.reason ? `: ${ch.reason}` : ''}`, text: lineDiff(ch.before, ch.after).join('\n'), publish: false })),
        ...(d.check ? [{ id: 'check', label: 'Проверка типов и тестов шагов с правками', text: checkText(d.check), publish: false }] : []),
      ],
      lint: d.blocks,
      payload: d.changes.map((ch) => ({ file: ch.file, before: sha256(ch.before), after: sha256(ch.after) })),
    };
  },

  async simulate() {
    return {};
  },

  async run(c) {
    const d = draftOf(c);
    const changed = d.changes.filter((ch) => !existsSync(ch.target) || readFileSync(ch.target, 'utf8') !== ch.before).map((ch) => ch.file);
    if (changed.length) throw new Error(`Файлы изменились после подготовки правок: ${changed.join(', ')}. Переделайте шаг`);
    for (const ch of d.changes) writeFileSync(ch.target, ch.after);
    const files = d.changes.map((ch) => ch.file);
    c.log(files.length ? `Правки записаны: ${files.join(', ')}. Коммит правок Task Pilot - по команде владельца` : 'Правок нет');
    const improvements: Improvements = { files, summary: d.summary, tests: d.check ? d.check.results.map((r) => r.summary).join('; ') : null, at: new Date().toISOString() };
    return { improvements };
  },
};

export default step;
