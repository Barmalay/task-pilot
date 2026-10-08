import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dashboard, Issue, LogResult, MonitorServiceProfile, PreviewText, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { headlinePanels, planHeadline, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, GIT_READ, readText, stageDocs } from '../_shared/agent.ts';
import { acOf, acText } from '../_shared/ac.ts';

const LABEL = 'дашборд задачи';
const FILE = 'dashboard.yaml';
/** Сколько символов описания задачи отдать агенту: остальное он прочитает в коде и доках. */
const DESCRIPTION_LIMIT = 6000;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Что мониторит дашборд, 1-3 предложения' },
    lines: { type: 'array', items: { type: 'string' }, description: 'Строки лога из кода, по которым построен дашборд' },
  },
  required: ['summary', 'lines'],
  additionalProperties: false,
};

/** Черновик: YAML дашборда как его написал агент и что в нем проверено. */
interface Draft {
  sessionId: string;
  source: string;
  dashboard: Dashboard;
  summary: string;
  lines: string[];
}

function draftOf(c: StepContext): Draft {
  const d = c.draft as Draft | undefined;
  if (!d) throw new Error('Черновика дашборда нет');
  return d;
}

/** Сервисы для промпта: где лежат их строки. */
function servicesText(services: MonitorServiceProfile[]): string {
  return services.map((s) => `- \`${s.id}\` - ${s.title}: контейнер ${s.container}, индекс ${s.index}`).join('\n');
}

const count = new Intl.NumberFormat('ru-RU');
const value = (v: number | null, kind: 'count' | 'ratio') => (v === null ? '-' : kind === 'ratio' ? `${String(Number((v * 100).toFixed(2))).replace('.', ',')}%` : count.format(v));

/** Живые цифры панелей с числом: за час и за сутки с прода, одним пакетом запросов. */
async function liveNumbers(c: StepContext, d: Dashboard): Promise<{ lines: string[]; warnings: string[] }> {
  const services = c.ports.monitor.services();
  const metric = d.panels.filter((p) => p.type === 'stat' || p.type === 'timeseries' || p.type === 'share');
  const plans = metric.map((p) => planHeadline(d, p, services, Date.now()));
  const results: LogResult[] = await c.ports.monitor.run(plans.flatMap((p) => p.requests));
  const lines: string[] = [];
  const warnings: string[] = [];
  let i = 0;
  for (const plan of plans) {
    const h = plan.value(results.slice(i, i + plan.requests.length));
    i += plan.requests.length;
    if (h.error) {
      lines.push(`${h.title}: запрос не прошел, ${h.error}`);
      warnings.push(`Панель "${h.title}": запрос к логам прода не прошел: ${h.error}`);
      continue;
    }
    lines.push(`${h.title}: за час ${value(h.hour, h.kind)}, за сутки ${value(h.day, h.kind)}`);
    // У доли пустая база - это ноль строк в знаменателе, у числа - ноль строк: фраза, скорее всего, не та.
    if ((h.kind === 'count' && h.day === 0) || (h.kind === 'ratio' && h.day === null)) {
      warnings.push(`Панель "${h.title}": за сутки на проде ни одной строки - проверьте фразы или что код уже выкачен`);
    }
  }
  return { lines, warnings };
}

/**
 * Дашборд задачи для панели мониторинга. Агент читает задачу, ее план, решение и коммиты, находит строки лога, которые
 * пишет код задачи, и описывает по ним панели и алерты в YAML в доках задачи. Шаг проверяет файл схемой и сервисами
 * профиля (при ошибке один раз возвращает агенту причину), превью показывает YAML на подтверждение и справкой живые цифры
 * панелей с прода (они меняются сами и в подтверждение не входят), после подтверждения файл сохраняется в
 * dashboards/<id>/dashboard.yaml пакета команды. Шаг "уже сделан", если у задачи есть дашборд.
 */
const step: StepModule = {
  async done(c) {
    const existing = c.ports.monitor.dashboards().dashboards.find((d) => d.task === c.run.issueKey);
    return existing ? { note: `Дашборд задачи уже есть: "${existing.title}" (dashboards/${existing.id})` } : null;
  },

  async prepare(c) {
    const issue = c.get<Issue>('issue');
    if (!issue) throw new Error('Задача не загружена из Jira');
    const services = c.ports.monitor.services();
    if (!services.length) throw new Error('Панель мониторинга не настроена: в monitor.yaml нет сервисов');
    const docs = stageDocs(c);
    const agentFile = join(docs.dir, FILE);
    const previous = c.draft as Draft | undefined;
    const resume = c.feedback && previous ? previous.sessionId : undefined;
    const existing = c.ports.monitor.dashboards().dashboards;
    const prompt = resume
      ? renderTemplate(readText(import.meta.url, './rework.md'), { feedback: c.feedback, file: agentFile })
      : `${renderTemplate(readText(import.meta.url, './prompt.md'), {
          key: issue.key,
          summary: issue.summary,
          url: issue.url,
          status: issue.status,
          repo: c.repo.title,
          docs: docs.dir,
          description: (issue.description || 'нет').slice(0, DESCRIPTION_LIMIT),
          ac: acText(acOf(c)),
          services: servicesText(services),
          existing: existing.length ? existing.map((d) => `${d.id} (${d.task})`).join(', ') : 'нет',
          file: agentFile,
        })}\n\n${agentRules(c)}`;
    const request = {
      label: LABEL,
      cwd: c.get<string>('worktree') ?? c.repo.path,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      // Дашборд не меняет код: писать можно только в папку доков.
      writeCwd: false,
      writeDirs: [docs.dir],
      allow: GIT_READ,
      schema: SCHEMA,
    };
    let r = await c.agent.run({ ...request, prompt, resume });
    if (!existsSync(agentFile)) throw new Error(`Агент не записал дашборд в ${agentFile}`);
    let check = c.ports.monitor.validate(readFileSync(agentFile, 'utf8'));
    if (!check.dashboard) {
      // Один круг исправления: агент получает ошибки проверки в той же сессии.
      r = await c.agent.run({ ...request, prompt: `Файл ${agentFile} не прошел проверку:\n${check.errors.join('\n')}\n\nИсправь его в том же формате.`, resume: r.sessionId });
      check = c.ports.monitor.validate(readFileSync(agentFile, 'utf8'));
      if (!check.dashboard) throw new Error(`Дашборд не прошел проверку: ${check.errors.join('; ')}`);
    }
    docs.back();
    const o = (r.output ?? {}) as { summary?: unknown; lines?: unknown };
    return {
      sessionId: r.sessionId,
      source: readFileSync(join(c.paths.docs, FILE), 'utf8'),
      dashboard: check.dashboard,
      summary: typeof o.summary === 'string' ? o.summary : r.text,
      lines: Array.isArray(o.lines) ? o.lines.filter((l): l is string => typeof l === 'string') : [],
    } satisfies Draft;
  },

  async preview(c) {
    const d = draftOf(c);
    const live = await liveNumbers(c, d.dashboard);
    const exists = c.ports.monitor.dashboards().dashboards.some((x) => x.id === d.dashboard.id);
    const path = `dashboards/${d.dashboard.id}/${FILE}`;
    // Подтверждается файл дашборда; живые цифры - справка: они меняются каждую минуту и сжигали бы подтверждение.
    const texts: PreviewText[] = [{ id: 'dashboard', label: path, text: d.source, publish: false }];
    const notes = [{ id: 'live', label: 'Живые цифры с прода', text: live.lines.join('\n') || 'панелей с числом нет' }];
    if (d.lines.length) notes.push({ id: 'lines', label: 'Строки лога из кода', text: d.lines.join('\n') });
    const headline = headlinePanels(d.dashboard).map((p) => p.title);
    return {
      title: `${c.run.issueKey}: дашборд задачи`,
      summary: d.summary,
      actions: [
        `${exists ? 'Заменить' : 'Сохранить'} дашборд "${d.dashboard.title}" в ${path}: панелей ${d.dashboard.panels.length}, алертов ${d.dashboard.alerts.length}`,
        ...(headline.length ? [`На карточке обзора: ${headline.join(', ')}`] : []),
      ],
      warnings: live.warnings,
      texts,
      notes,
      payload: { id: d.dashboard.id, source: d.source },
    };
  },

  async simulate() {
    return {};
  },

  async run(c) {
    const d = draftOf(c);
    const saved = await c.ports.monitor.save(d.source);
    c.log(`Дашборд "${saved.dashboard.title}" сохранен: dashboards/${saved.dashboard.id}/${FILE}`);
    return { dashboard: { id: saved.dashboard.id, file: saved.file } };
  },
};

export default step;
