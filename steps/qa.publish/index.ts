import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcCheck, Issue, LintIssue, MilestonePlan, QaComment, QaReport, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { acceptanceCriteriaOf, renderTemplate, walkTransitions } from '../../packages/step-kit/src/index.ts';
import { moveOf, moveOffText, transitionIds, transitionText } from '../_shared/board.ts';
import { agentRules, readText } from '../_shared/agent.ts';
import { teamSkill } from '../_shared/team.ts';
import { acOf } from '../_shared/ac.ts';

const LABEL = 'итоги в Jira';
const MILESTONE = 'testing';

/**
 * Строка промпта доработки с образцом итогов команды: `references/jira-format.md` скилла теста на стенде. Образца у
 * команды может и не быть, тогда формат задает текущий текст и правила промпта.
 */
function formatNote(c: StepContext): string {
  const file = `${teamSkill(c, 'qa')}/references/jira-format.md`;
  return existsSync(file) ? ` Образец итогов команды: ${file}.` : '';
}

/** Текст комментария: собирается по итогам прогона, "Переделать" отдает его агенту с замечанием. */
interface Draft {
  body: string;
  sessionId: string | null;
  /** Что линтер исправил в тексте сам: показывается на подтверждении. */
  fixed: LintIssue[];
}

/** Файл для вложений и что с ним будет: загрузка, замена файла с тем же именем или ничего, он уже в Jira. */
interface Upload {
  name: string;
  path: string;
  size: number;
  action: 'upload' | 'replace' | 'skip';
  /** Id вложений с тем же именем, которые удаляются перед заменой. */
  replaces: string[];
}

interface State {
  issue: Issue;
  report: QaReport;
  uploads: Upload[];
  /** Файлы доказательств из отчета, которых нет в папке артефактов. */
  missing: string[];
  /** Отчет для вложения: копия qa-report.md с исправлениями линтера. */
  reportFile: { name: string; path: string; text: string } | null;
  comment: QaComment | null;
  plan: MilestonePlan;
  /** Перевод по доске выключен настройкой шага: задача остается в своем статусе. */
  moveOff: boolean;
  /** Перевод выключен пустой вехой доски, а не настройкой шага. */
  moveByBoard: boolean;
  /** Критерии приемки в описании изменились с открытия прогона: номера строк таблицы стоит сверить. */
  acChanged: boolean;
}

/** Миниатюры !файл|thumbnail! в тексте комментария. */
export function thumbnails(body: string): string[] {
  return [...body.matchAll(/!([^!|\n]+)\|thumbnail!/g)].map((m) => m[1]!.trim());
}

/** Все вложения, на которые ссылается текст: миниатюры и ссылки [^файл]. */
export function references(body: string): string[] {
  return [...new Set([...thumbnails(body), ...[...body.matchAll(/\[\^([^\]\n]+)\]/g)].map((m) => m[1]!.trim())])];
}

/** Текст для wiki-разметки Jira: служебные символы экранированы, вертикальная черта и переносы строк убраны. */
export function escapeWiki(text: string): string {
  return text
    .replace(/\|/g, '/')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/([\\{}[\]!*_^~+])/g, '\\$1')
    .trim();
}

function cell(text: string): string {
  return escapeWiki(text) || ' ';
}

/**
 * Текст ячейки AC: номер, а у критериев из плана (в описании задачи их нет) еще и формулировка, чтобы строку можно
 * было понять без доков задачи. Обратные кавычки markdown из формулировки убираются: в разметке Jira они не код.
 */
export function acLabel(ac: string, planAc: string[] | null | undefined): string {
  const n = /^\s*(?:AC\s*)?(\d+)\.?\s*$/i.exec(ac)?.[1];
  const text = n && planAc ? planAc[Number(n) - 1] : undefined;
  return text ? `${n}. ${text.replace(/`/g, '')}` : ac;
}

/**
 * Комментарий с итогами: заголовок, вводная, таблица ||AC||Сценарий||Действие||Ожидаемый результат||Итог||Факт|| с миниатюрами
 * в колонке "Факт" и замечания не по задаче. Для непройденных и непроверенных AC причина идет в колонку
 * результата. У критериев из плана (planAc, в описании задачи их нет) в колонке AC рядом с номером идет формулировка.
 */
export function commentBody(o: {
  stand: string;
  date: string;
  summary: string;
  build: string | null;
  results: AcCheck[];
  remarks: string[];
  reportName: string | null;
  planAc?: string[] | null;
}): string {
  const summary = o.summary.trim();
  const intro = [
    summary ? escapeWiki(/[.!?]$/.test(summary) ? summary : `${summary}.`) : '',
    o.build ? `Сборка с образом ${o.build}.` : '',
    // Кадры Kibana агент называет kibana-...: фраза про них нужна, только когда они есть в таблице.
    o.results.some((r) => r.files.some((f) => f.startsWith('kibana'))) ? 'Логи в колонке "Факт" - кадры Kibana стенда.' : '',
    o.reportName ? `Сводный отчет во вложении [^${o.reportName}].` : '',
  ].filter(Boolean);
  const rows = o.results.map((r) => {
    const expected = r.result !== 'пройден' && r.note.trim() ? `${r.expected} (${r.note})` : r.expected;
    const fact = r.files.length ? r.files.map((f) => `!${f}|thumbnail!`).join(' ') : ' ';
    return `|${cell(acLabel(r.ac, o.planAc))}|${cell(r.scenario)}|${cell(r.action)}|${cell(expected)}|${cell(r.result)}|${fact}|`;
  });
  const remarks = o.remarks.length ? ['', 'h4. Замечания не по задаче', ...o.remarks.map((x) => `* ${escapeWiki(x)}`)] : [];
  return [`h3. Итоги проверки на стенде ${o.stand} (${o.date})`, '', intro.join(' '), '', '||AC||Сценарий||Действие||Ожидаемый результат||Итог||Факт||', ...rows, ...remarks].join('\n');
}

function dateOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

async function inspect(c: StepContext): Promise<State> {
  const cached = c.scratch.get('state') as State | undefined;
  if (cached) return cached;
  const report = c.get<QaReport>('qaReport');
  if (!report?.results.length) throw new Error('Нет итогов прогона AC: сначала нужен шаг "Тест на стенде"');
  const issue = await c.ports.jira.getIssue(c.run.issueKey);
  const evidence = [...new Set(report.results.flatMap((r) => r.files))];
  const missing = evidence.filter((f) => !existsSync(join(report.artifacts, f)));
  let reportFile: State['reportFile'] = null;
  if (existsSync(report.report)) {
    // Отчет уходит во вложение: в нем те же правила, что в тексте, поэтому публикуется копия после линтера.
    const text = c.lint(readFileSync(report.report, 'utf8')).text;
    const dir = join(c.paths.run, 'qa-publish');
    mkdirSync(dir, { recursive: true });
    const name = `${issue.key}-qa-report.md`;
    writeFileSync(join(dir, name), text);
    reportFile = { name, path: join(dir, name), text };
  }
  const files = [...evidence.filter((f) => !missing.includes(f)).map((name) => ({ name, path: join(report.artifacts, name) })), ...(reportFile ? [reportFile] : [])];
  const existing = await c.ports.jira.attachments(issue.key);
  const uploads = files.map((f): Upload => {
    const size = statSync(f.path).size;
    const same = existing.filter((a) => a.filename === f.name);
    // Тот же файл уже во вложениях - повторная загрузка дала бы дубликат; другой файл с тем же именем заменяется.
    const action = !same.length ? 'upload' : same.length === 1 && same[0]!.size === size ? 'skip' : 'replace';
    return { name: f.name, path: f.path, size, action, replaces: action === 'replace' ? same.map((a) => a.id) : [] };
  });
  const ac = acceptanceCriteriaOf(issue);
  const move = moveOf(c, issue.status, MILESTONE);
  const previous = c.get<QaComment>('qaComment');
  const state: State = {
    issue,
    report,
    uploads,
    missing,
    reportFile,
    comment: previous && previous.key === issue.key ? previous : null,
    plan: move.plan,
    moveOff: move.off,
    moveByBoard: move.byBoard,
    acChanged: JSON.stringify(ac ?? null) !== JSON.stringify(c.get<string[] | null>('ac') ?? null),
  };
  c.scratch.set('state', state);
  return state;
}

/** Проверяет, что публиковать можно: доказательства на месте, текст ссылается только на то, что будет во вложениях. */
function mustPublish(s: State, d: Draft, attached: string[] = []): void {
  if (s.missing.length) throw new Error(`Нет файлов доказательств из отчета: ${s.missing.join(', ')}. Повторите шаг "Тест на стенде"`);
  const available = new Set([...s.uploads.map((u) => u.name), ...attached]);
  const absent = references(d.body).filter((f) => !available.has(f));
  if (absent.length) throw new Error(`Текст ссылается на файлы, которых не будет во вложениях: ${absent.join(', ')}`);
}

function finish(c: StepContext, body: string, sessionId: string | null): Draft {
  const r = c.lint(body);
  return { body: r.text, sessionId, fixed: r.issues.filter((i) => i.severity === 'fixed').map((i) => ({ ...i, message: `Комментарий: ${i.message}` })) };
}

const REWORK_SCHEMA = {
  type: 'object',
  properties: { body: { type: 'string', description: 'Текст комментария целиком в wiki-разметке Jira Server' } },
  required: ['body'],
  additionalProperties: false,
};

/**
 * Итоги проверки на стенде в Jira одним подтверждением: вложения (тот же файл не загружается повторно,
 * другой файл с тем же именем заменяется), комментарий с таблицей AC и миниатюрами и перевод задачи
 * к вехе testing. Текст собирается по итогам прогона; "Переделать" отдает его агенту с замечанием.
 * Перед комментарием шаг проверяет, что все файлы из текста уже во вложениях, после - как Jira его отрисовала.
 */
const step: StepModule = {
  async done(c) {
    const report = c.get<QaReport>('qaReport');
    const comment = c.get<QaComment>('qaComment');
    if (!report || !comment || comment.key !== c.run.issueKey || comment.at < report.at) return null;
    const s = await inspect(c);
    if (s.plan.kind === 'transitions') return null;
    return { note: `Итоги этого прогона уже в Jira: ${comment.url}` };
  },

  async prepare(c) {
    const s = await inspect(c);
    const previous = c.draft as Draft | undefined;
    if (c.feedback && previous) {
      const r = await c.agent.run({
        label: LABEL,
        prompt: `${renderTemplate(readText(import.meta.url, './rework.md'), {
          key: s.issue.key,
          feedback: c.feedback,
          body: previous.body,
          report: s.report.report,
          format: formatNote(c),
        })}\n\n${agentRules(c)}`,
        cwd: c.get<string>('worktree') ?? c.repo.path,
        tools: ['Read'],
        writeCwd: false,
        schema: REWORK_SCHEMA,
        resume: previous.sessionId ?? undefined,
      });
      const body = (r.output as { body?: unknown } | null)?.body;
      if (typeof body !== 'string' || !body.trim()) throw new Error('Агент не вернул текст комментария');
      return finish(c, body, r.sessionId);
    }
    const ac = acOf(c);
    const body = commentBody({
      stand: s.report.stand,
      date: dateOf(s.report.at),
      summary: s.report.summary,
      build: s.report.build,
      results: s.report.results,
      remarks: s.report.remarks,
      reportName: s.reportFile?.name ?? null,
      planAc: ac.planFile ? ac.items : null,
    });
    return finish(c, body, previous?.sessionId ?? null);
  },

  async preview(c) {
    const s = await inspect(c);
    const d = c.draft as Draft;
    mustPublish(s, d);
    const names = (action: Upload['action']) => s.uploads.filter((u) => u.action === action).map((u) => u.name);
    const actions: string[] = [];
    if (names('upload').length) actions.push(`Загрузить во вложения ${s.issue.key}: ${names('upload').join(', ')}`);
    if (names('replace').length) actions.push(`Заменить вложения с тем же именем и другим содержимым: ${names('replace').join(', ')}`);
    actions.push(s.comment ? `Обновить комментарий с итогами: ${s.comment.url}` : `Добавить комментарий с итогами в ${s.issue.key}`);
    if (s.plan.kind === 'transitions') for (const t of s.plan.steps) actions.push(`Jira: ${transitionText(t)}`);
    if (s.moveOff) actions.push(moveOffText(s.issue.status, s.moveByBoard));
    const warnings: string[] = [];
    if (s.acChanged) warnings.push('Критерии приемки в описании задачи изменились после открытия прогона: сверьте номера строк таблицы с актуальными AC');
    if (!s.reportFile) warnings.push(`Отчета ${s.report.report} нет: комментарий уйдет без вложения отчета`);
    if (s.plan.kind === 'blocked') warnings.push(`Jira: ${s.plan.reason}`);
    const skipped = names('skip');
    return {
      title: `Итоги в Jira: ${s.issue.key}`,
      summary: `Таблица AC: строк ${s.report.results.length}, миниатюр ${thumbnails(d.body).length}${skipped.length ? `; уже во вложениях и не загружаются повторно: ${skipped.join(', ')}` : ''}`,
      actions,
      warnings,
      texts: [
        { id: 'comment', label: 'Комментарий в Jira', text: d.body, publish: true, format: 'jira' },
        ...(s.reportFile
          ? [{ id: 'report', label: `Вложение ${s.reportFile.name}`, text: s.reportFile.text, publish: true, ...(s.reportFile.name.endsWith('.md') ? { format: 'markdown' as const } : {}) }]
          : []),
      ],
      lint: d.fixed,
      payload: {
        key: s.issue.key,
        uploads: s.uploads.map((u) => ({ name: u.name, size: u.size, action: u.action })),
        comment: s.comment?.id ?? null,
        transitions: s.plan.kind === 'transitions' ? transitionIds(s.plan.steps) : [],
      },
    };
  },

  async simulate(c) {
    return { qaComment: { id: 'dry-run', url: '', key: c.run.issueKey, rendered: { images: 0, rows: 0, unresolved: 0 }, at: new Date().toISOString() } satisfies QaComment };
  },

  async run(c) {
    const s = await inspect(c);
    const d = c.draft as Draft;
    mustPublish(s, d);
    const { jira } = c.ports;
    for (const u of s.uploads) {
      if (u.action === 'skip') continue;
      // Jira не заменяет файл с тем же именем, а кладет рядом: старые копии удаляются до загрузки.
      for (const id of u.replaces) await jira.deleteAttachment(id);
      await jira.attach(s.issue.key, u.path);
      c.log(`${u.action === 'replace' ? 'Заменено' : 'Загружено'} вложение ${u.name}`);
    }
    // Миниатюра без файла Jira не отрисует: до комментария все файлы из текста должны быть во вложениях.
    const attached = (await jira.attachments(s.issue.key)).map((a) => a.filename);
    const absent = references(d.body).filter((f) => !attached.includes(f));
    if (absent.length) throw new Error(`После загрузки в Jira нет вложений ${absent.join(', ')}: комментарий не опубликован`);
    const posted = await jira.comment(s.issue.key, d.body, s.comment?.id);
    const expected = thumbnails(d.body).length;
    if (posted.rendered.unresolved || posted.rendered.images < expected) {
      c.log(`Jira отрисовала комментарий с ошибками: миниатюр ${posted.rendered.images} из ${expected}, неразобранной разметки ${posted.rendered.unresolved}. Проверьте: ${posted.url}`);
    } else {
      c.log(`Комментарий ${s.comment ? 'обновлен' : 'опубликован'}, миниатюр ${posted.rendered.images}: ${posted.url}`);
    }
    const status = s.plan.kind === 'transitions' ? await walkTransitions(jira, s.issue.key, s.issue.status, s.plan.steps, c.log) : s.issue.status;
    return { qaComment: { id: posted.id, url: posted.url, key: s.issue.key, rendered: posted.rendered, at: new Date().toISOString() } satisfies QaComment, status };
  },
};

export default step;
