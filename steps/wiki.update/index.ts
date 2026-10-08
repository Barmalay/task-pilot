import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Issue, LintIssue, PreviewText, StepContext, StepModule, WikiPage, WikiPublished } from '../../packages/step-kit/src/index.ts';
import { keptLines, lineDiff, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, GIT_READ, jiraTools, readText, sha256, stageDocs } from '../_shared/agent.ts';
import { teamSkill } from '../_shared/team.ts';

const LABEL = 'страница вики';
/** Сколько строк диффа страницы показывать на подтверждении. */
const DIFF_LINES = 300;
/** Инструменты Jira и Confluence только на чтение. */
const JIRA_READ = ['jira_get_issue', 'jira_search', 'confluence_search', 'confluence_get_page', 'confluence_get_page_children'];

const SCHEMA = {
  type: 'object',
  properties: {
    pageId: { type: ['string', 'null'], description: 'id страницы для обновления; null - новая страница' },
    title: { type: 'string' },
    space: { type: 'string' },
    parentId: { type: ['string', 'null'], description: 'Родительская страница для новой; null - в корне пространства' },
    summary: { type: 'string', description: 'Суть изменений в 1-3 предложениях' },
  },
  required: ['pageId', 'title', 'space', 'parentId', 'summary'],
  additionalProperties: false,
};

/** Черновик страницы до подтверждения: новые и измененные строки уже прошли исправления линтера. */
interface Draft {
  sessionId: string;
  pageId: string | null;
  title: string;
  space: string;
  parentId: string | null;
  summary: string;
  text: string;
  /** Хэш файла страницы, из которого собран текст. */
  source: string;
  fixed: LintIssue[];
  /** Замечания линтера к новым и измененным строкам: предупреждения и то, что не дает подтвердить (секреты, телефоны, почта, имена). */
  problems: LintIssue[];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Файл страницы в доках задачи; null - агент его еще не писал. */
function pageFile(c: StepContext): string | null {
  const file = join(c.paths.docs, 'wiki.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Текст к публикации и замечания линтера. Строки текущей страницы, которые агент не менял, остаются как есть: их писали
 * люди до шага, в них бывают буквальные цитаты с елочками и имена. Исправления и блокировки линтера касаются только
 * новых и измененных строк, у новой страницы - всего текста.
 */
function linted(c: StepContext, raw: string, current: WikiPage | null): { text: string; fixed: LintIssue[]; problems: LintIssue[] } {
  const lines = raw.split('\n');
  const kept = current ? keptLines(current.markdown, raw) : lines.map(() => false);
  // Исправления линтера меняют символы внутри строк, но не переносы: строки исправленного текста идут в том же порядке.
  const fixedLines = c.lint(raw).text.split('\n');
  const text = lines.map((line, i) => (kept[i] ? line : fixedLines[i]!)).join('\n');
  const issues = c.lint(lines.filter((_line, i) => !kept[i]).join('\n')).issues.map((i) => ({ ...i, message: `Страница: ${i.message}` }));
  return { text, fixed: issues.filter((i) => i.severity === 'fixed'), problems: issues.filter((i) => i.severity !== 'fixed') };
}

function draftOf(c: StepContext): Draft {
  const d = c.draft as Draft | undefined;
  if (!d) throw new Error('Черновика страницы нет');
  return d;
}

/** Страница, которую шаг обновит: по id от агента или по точному заголовку в пространстве; null - страница новая. */
async function currentOf(c: StepContext, d: Pick<Draft, 'pageId' | 'space' | 'title'>): Promise<WikiPage | null> {
  const cached = c.scratch.get('current') as WikiPage | null | undefined;
  if (cached !== undefined) return cached;
  const page = d.pageId ? await c.ports.wiki.getPage(d.pageId) : await c.ports.wiki.findPage(d.space, d.title);
  c.scratch.set('current', page);
  return page;
}

/**
 * Страница вики по задаче. Агент по скиллу wiki-analysis собирает вход (задача, доки, код, смежные страницы),
 * решает, обновить существующую страницу или создать новую, и пишет полный текст в markdown в доки задачи.
 * Превью показывает, какая страница создается или обновляется, и дифф с текущей версией: обновление
 * перезаписывает тело целиком. Строки текущей страницы, которые агент не менял, публикуются как есть, а линтер
 * исправляет и проверяет только новые и измененные строки (`linted`), поэтому текст страницы шаг проверяет сам
 * (`stepLinted`), а не движок. Версия страницы входит в подтверждение, поэтому правка страницы после показа сжигает его. Публикует код
 * шага после подтверждения; шаг "уже сделан", если файл страницы в доках с публикации не менялся.
 */
const step: StepModule = {
  async done(c) {
    const published = c.get<WikiPublished>('wikiPage');
    const raw = pageFile(c);
    if (!published || raw === null || sha256(raw) !== published.hash) return null;
    return { note: `Страница уже опубликована: ${published.url}` };
  },

  async prepare(c) {
    const issue = c.get<Issue>('issue');
    if (!issue) throw new Error('Задача не загружена из Jira');
    const docs = stageDocs(c);
    const agentFile = join(docs.dir, 'wiki.md');
    const previous = c.draft as Draft | undefined;
    const resume = c.feedback && previous ? previous.sessionId : undefined;
    const space = String(c.params.space ?? '').trim() || c.team.wikiSpace;
    if (!space) throw new Error('Пространство вики для новой страницы не задано: выберите его в настройке шага или задайте wiki.space в team.yaml пакета команды');
    const skill = teamSkill(c, 'wiki');
    const prompt = resume
      ? renderTemplate(readText(import.meta.url, './rework.md'), { feedback: c.feedback, file: agentFile })
      : `${renderTemplate(readText(import.meta.url, './prompt.md'), {
          key: issue.key,
          summary: issue.summary,
          url: issue.url,
          status: issue.status,
          repo: c.repo.title,
          docs: docs.dir,
          skill,
          space,
          file: agentFile,
        })}\n\n${agentRules(c)}`;
    const r = await c.agent.run({
      label: LABEL,
      prompt,
      cwd: c.get<string>('worktree') ?? c.repo.path,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      // Страница не меняет код: писать можно только в папку доков.
      writeCwd: false,
      writeDirs: [docs.dir],
      allow: [...GIT_READ, ...jiraTools(c, JIRA_READ)],
      mcp: [c.jira.mcp],
      schema: SCHEMA,
      resume,
    });
    if (!existsSync(agentFile)) throw new Error(`Агент не записал страницу в ${agentFile}`);
    docs.back();
    const o = (r.output ?? {}) as Record<string, unknown>;
    const title = str(o.title);
    if (!title) throw new Error('Агент не назвал страницу');
    const page = { pageId: str(o.pageId), title: c.lint(title).text, space: str(o.space) ?? space };
    const raw = readFileSync(join(c.paths.docs, 'wiki.md'), 'utf8');
    return {
      sessionId: r.sessionId,
      ...page,
      parentId: str(o.parentId),
      summary: typeof o.summary === 'string' ? o.summary : r.text,
      source: sha256(raw),
      ...linted(c, raw, await currentOf(c, page)),
    } satisfies Draft;
  },

  async preview(c) {
    const d = draftOf(c);
    const current = await currentOf(c, d);
    // Текст страницы проверен линтером по строкам в prepare: неизмененные строки текущей страницы он не трогает.
    const texts: PreviewText[] = [{ id: 'page', label: `Страница "${d.title}"`, text: d.text, publish: true, stepLinted: true, format: 'markdown' }];
    const warnings: string[] = [];
    let action: string;
    if (current) {
      const diff = lineDiff(current.markdown, d.text);
      texts.push({ id: 'diff', label: 'Изменения относительно текущей версии, минус - было, плюс - стало', text: diff.slice(0, DIFF_LINES).join('\n') || 'текст не меняется', publish: false });
      if (diff.length > DIFF_LINES) warnings.push(`Дифф показан не целиком: ${DIFF_LINES} строк из ${diff.length}`);
      warnings.push('Обновление перезаписывает тело страницы целиком: все, чего нет в тексте ниже, со страницы пропадет. Сверьте строки с минусом в диффе');
      const rename = current.title === d.title ? '' : `, новый заголовок "${d.title}"`;
      action = `Обновить страницу "${current.title}" (${current.url}): версия ${current.version} → ${current.version + 1}${rename}`;
    } else {
      action = `Создать страницу "${d.title}" в пространстве ${d.space}${d.parentId ? ` под страницей ${d.parentId}` : ' в корне'}`;
    }
    return {
      title: `${c.run.issueKey}: страница вики`,
      summary: d.summary,
      actions: [action],
      warnings,
      texts,
      lint: [...d.fixed, ...d.problems],
      payload: { pageId: current?.id ?? null, version: current?.version ?? null, title: d.title, space: d.space, parentId: d.parentId },
    };
  },

  async simulate() {
    return {};
  },

  async run(c) {
    const d = draftOf(c);
    const current = await currentOf(c, d);
    const saved = current
      ? await c.ports.wiki.updatePage({ id: current.id, title: d.title, markdown: d.text, comment: `${c.run.issueKey}: ${d.summary}`.slice(0, 250) })
      : await c.ports.wiki.createPage({ space: d.space, title: d.title, parentId: d.parentId, markdown: d.text });
    c.log(`${current ? 'Обновлена' : 'Создана'} страница вики "${d.title}": ${saved.url}`);
    return { wikiPage: { id: saved.id, url: saved.url, title: d.title, hash: d.source, at: new Date().toISOString() } satisfies WikiPublished };
  },
};

export default step;
