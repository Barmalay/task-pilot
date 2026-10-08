import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Issue, IssueChange, Plan, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { acceptanceCriteriaOf, issueChanges, lineDiff, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, GIT_READ, jiraTools, readText, sha256, stageDocs } from '../_shared/agent.ts';
import { acOf, acPlanTask, acText, planAcOf, planAcPreview } from '../_shared/ac.ts';

const LABEL = 'доработка задачи';
/** Инструменты Jira и Confluence только на чтение. */
const JIRA_READ = ['jira_get_issue', 'jira_search', 'confluence_search', 'confluence_get_page'];

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Суть доработки в 2-4 предложениях' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Открытые вопросы владельцу' },
  },
  required: ['summary', 'questions'],
  additionalProperties: false,
};

/** Черновик доработки до утверждения: обновленный план и задача, по которой он обновлен. */
interface Draft {
  sessionId: string;
  file: string;
  summary: string;
  questions: string[];
  changes: IssueChange[];
  diff: string[];
  fresh: Issue;
}

/** Задача сейчас и что изменилось по сравнению со снимком прогона. */
async function freshOf(c: StepContext): Promise<{ fresh: Issue; changes: IssueChange[]; diff: string[] }> {
  const cached = c.scratch.get('fresh') as { fresh: Issue; changes: IssueChange[]; diff: string[] } | undefined;
  if (cached) return cached;
  const snapshot = c.get<Issue>('issue');
  const fresh = await c.ports.jira.getIssue(c.run.issueKey);
  // Статус, который поставили шаги прогона, свежее снимка: свои переходы прогона изменением не считаются.
  const status = c.get<string>('status') ?? snapshot?.status;
  const changes = snapshot ? issueChanges({ ...snapshot, status: status ?? snapshot.status }, fresh, c.jira) : [];
  const diff = snapshot ? lineDiff(snapshot.description, fresh.description) : [];
  const found = { fresh, changes, diff };
  c.scratch.set('fresh', found);
  return found;
}

function changesText(changes: IssueChange[]): string {
  return changes.length ? changes.map((ch) => `- ${ch.text}`).join('\n') : '- в самой задаче ничего не поменялось: смотри комментарии';
}

function output(value: unknown): { summary: string; questions: string[] } {
  const o = value as { summary?: unknown; questions?: unknown } | null;
  if (!o || typeof o.summary !== 'string') throw new Error('Агент не вернул суть доработки');
  return { summary: o.summary, questions: Array.isArray(o.questions) ? o.questions.filter((q): q is string => typeof q === 'string') : [] };
}

function draftOf(c: StepContext): Draft {
  const d = c.draft as Draft | undefined;
  if (!d) throw new Error('Черновика доработки нет');
  if (!existsSync(d.file)) throw new Error(`Файл плана ${d.file} пропал, повторите шаг`);
  return d;
}

/**
 * Доработка задачи, которую вернули или изменили в Jira. Шаг сравнивает задачу со снимком прогона (статус,
 * описание построчно, критерии приемки), агент читает новые комментарии, план и код и обновляет план; владелец
 * утверждает его или возвращает с замечанием. После утверждения снимок и статус задачи в прогоне обновляются, найденные
 * изменения гасятся, а петля манифеста возвращает в ожидание весь следующий цикл: ветку, реализацию, проверку,
 * коммит, сборку, деплой, тест и завершение. Если задача не менялась, шаг "уже сделан". Пока в описании задачи нет
 * критериев приемки, план держит их своим разделом, и они уходят в контекст вместе с планом.
 */
const step: StepModule = {
  async done(c) {
    const { changes } = await freshOf(c);
    const flagged = c.get<{ changes?: IssueChange[] } | null>('issueChanged');
    if (changes.length || flagged?.changes?.length) return null;
    return { note: 'Постановка задачи не менялась: план остается прежним' };
  },

  async prepare(c) {
    const { fresh, changes, diff } = await freshOf(c);
    const file = join(c.paths.docs, 'plan.md');
    const docs = stageDocs(c);
    const agentFile = join(docs.dir, 'plan.md');
    const previous = c.draft as Draft | undefined;
    const resume = c.feedback && previous ? previous.sessionId : undefined;
    const jira = acceptanceCriteriaOf(fresh);
    const parts = resume
      ? [
          renderTemplate(readText(import.meta.url, './rework.md'), { feedback: c.feedback, planFile: agentFile }),
          // Задание про критерии приемки повторяется в доработке, пока их раздела в плане нет.
          existsSync(agentFile) && !planAcOf(readFileSync(agentFile, 'utf8'), jira) ? acPlanTask(jira, docs.dir) : '',
        ]
      : [
          renderTemplate(readText(import.meta.url, './prompt.md'), {
            key: fresh.key,
            summary: fresh.summary,
            status: fresh.status,
            changes: changesText(changes),
            description: fresh.description.trim() || 'описания нет',
            diff: diff.join('\n') || 'описание не менялось',
            ac: acText(acOf(c, jira)),
            planState: existsSync(file)
              ? `Утвержденный план лежит в файле ${agentFile}: прочитай его первым.`
              : `Плана еще нет: составь его в файле ${agentFile} по разделам шага "Анализ и план".`,
            planFile: agentFile,
            date: new Date().toLocaleDateString('ru-RU'),
          }),
          // Критерии описания заменяют раздел плана: появились - агент убирает раздел, их нет - держит его.
          acPlanTask(jira, docs.dir, Boolean(c.get<Plan>('plan')?.ac?.length)),
          agentRules(c),
        ];
    const prompt = parts.filter(Boolean).join('\n\n');
    const r = await c.agent.run({
      label: LABEL,
      prompt,
      cwd: c.get<string>('worktree') ?? c.repo.path,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      // Доработка плана не меняет код: писать можно только в папку доков.
      writeCwd: false,
      writeDirs: [docs.dir],
      allow: [...GIT_READ, ...jiraTools(c, JIRA_READ)],
      mcp: [c.jira.mcp],
      schema: SCHEMA,
      resume,
    });
    if (!existsSync(agentFile)) throw new Error(`Агент не записал план в ${agentFile}`);
    docs.back();
    return { sessionId: r.sessionId, file, ...output(r.output), changes, diff, fresh } satisfies Draft;
  },

  async preview(c) {
    const d = draftOf(c);
    const plan = readFileSync(d.file, 'utf8');
    const statement = [changesText(d.changes), d.diff.length ? `\nОписание, минус - было, плюс - стало:\n${d.diff.join('\n')}` : ''].join('');
    const ac = planAcPreview(plan, acceptanceCriteriaOf(d.fresh));
    return {
      title: 'Утвердить доработку плана',
      summary: d.summary,
      actions: ['Снимок задачи в прогоне обновится, а ветка, реализация, проверка, коммит, сборка, деплой, тест и завершение пройдут заново по обновленному плану', ...ac.actions],
      ...(ac.warnings.length ? { warnings: ac.warnings } : {}),
      questions: d.questions,
      texts: [
        { id: 'changes', label: 'Что изменилось в задаче', text: statement, publish: false },
        { id: 'plan', label: 'План', text: plan, publish: false, format: 'markdown' },
      ],
      payload: { file: d.file, hash: sha256(plan), updated: d.fresh.updated ?? null },
    };
  },

  async simulate() {
    return {};
  },

  async run(c) {
    const d = draftOf(c);
    const text = readFileSync(d.file, 'utf8');
    const jira = acceptanceCriteriaOf(d.fresh);
    const ac = planAcOf(text, jira);
    const plan: Plan = { file: d.file, hash: sha256(text), summary: d.summary, questions: d.questions, ...(ac ? { ac } : {}) };
    return { plan, issue: d.fresh, ac: jira, status: d.fresh.status, issueChanged: null, issueSeen: d.fresh.updated ?? null };
  },
};

export default step;
