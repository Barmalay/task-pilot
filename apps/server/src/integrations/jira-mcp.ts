import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Issue, IssueRef, JiraAttachment, JiraComment, JiraPort, SprintRef, Transition } from '@task-pilot/step-kit';

/** Задача в формате mcp-atlassian. Поле спринта приходит под своим id (customfield_...). */
export interface RawIssue {
  key?: string;
  summary?: string;
  browse_url?: string;
  description?: string | null;
  status?: { name?: string } | null;
  issue_type?: { name?: string } | null;
  assignee?: { name?: string; display_name?: string } | null;
  labels?: string[] | null;
  components?: (string | { name?: string })[] | null;
  updated?: string;
  comments?: { id?: string | number; author?: { name?: string } | null; created?: string }[] | null;
  [field: string]: unknown;
}

/** Сколько комментариев задачи читать: больше в задачах обычно не бывает. */
const COMMENT_LIMIT = 100;

/** Функция вызова инструмента MCP-сервера atlassian. */
export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** Прямой доступ к REST Jira с токеном MCP-сервера atlassian. */
export interface JiraRest {
  url: string;
  token: string;
}

/** Настройки порта Jira. */
export interface JiraMcpOptions {
  baseUrl: string;
  /** Поле спринта задачи (gh-sprint); без него спринт не читается. */
  sprintField?: string;
  /** Поле эпика задачи (Epic Link); без него эпик не читается. */
  epicField?: string;
  /**
   * REST для того, чего нет в mcp-atlassian: статуса, в который ведет переход, вложений и комментариев с разметкой.
   * Функция отдает текущий доступ: токен Jira можно сменить на экране "Интеграции".
   */
  rest?: JiraRest | null | (() => JiraRest | null);
}

/** REST Jira из настроек MCP-сервера atlassian: адрес и персональный токен, если они там есть. */
export function jiraRestOf(server: { env?: Record<string, string> } | undefined): JiraRest | null {
  const url = server?.env?.JIRA_URL;
  const token = server?.env?.JIRA_PERSONAL_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

/** Переходы задачи из REST Jira: в отличие от mcp-atlassian, он сообщает, в какой статус ведет переход. */
async function restTransitions(rest: JiraRest, key: string): Promise<Transition[]> {
  const r = await fetch(`${rest.url}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
    headers: { Authorization: `Bearer ${rest.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`REST Jira ответил ${r.status}`);
  const body = (await r.json()) as { transitions?: { id?: unknown; name?: unknown; to?: { name?: unknown } }[] };
  return (body.transitions ?? []).map((t) => ({ id: String(t.id), name: String(t.name ?? ''), ...(typeof t.to?.name === 'string' ? { to: t.to.name } : {}) }));
}

function restOf(options: JiraMcpOptions): JiraRest | null {
  return (typeof options.rest === 'function' ? options.rest() : options.rest) ?? null;
}

function needRest(options: JiraMcpOptions): JiraRest {
  const rest = restOf(options);
  if (!rest) throw new Error('Для вложений и комментариев нужен REST Jira: у MCP-сервера atlassian нет JIRA_URL и JIRA_PERSONAL_TOKEN');
  return rest;
}

/** Запрос к REST Jira API 2; ответ разбирается как JSON, пустой ответ - null. */
async function restCall(rest: JiraRest, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: { json: unknown } | { form: FormData }): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${rest.token}`, Accept: 'application/json' };
  // Без этого заголовка Jira Server отвечает 403 на загрузку вложений и изменения из не-браузера.
  if (method !== 'GET') headers['X-Atlassian-Token'] = 'no-check';
  if (body && 'json' in body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${rest.url}/rest/api/2${path}`, {
    method,
    headers,
    body: body ? ('json' in body ? JSON.stringify(body.json) : body.form) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`REST Jira ${method} ${path.split('?')[0]}: ${r.status} ${text.slice(0, 200)}`.trim());
  return text ? (JSON.parse(text) as unknown) : null;
}

function toAttachment(a: { id?: unknown; filename?: unknown; size?: unknown; created?: unknown } | undefined): JiraAttachment {
  return { id: String(a?.id ?? ''), filename: String(a?.filename ?? ''), size: Number(a?.size ?? 0), created: String(a?.created ?? '') };
}

/** Как Jira отрисовала комментарий: картинки, строки таблиц и разметка, которую она не разобрала. */
export function renderStats(html: string): JiraComment['rendered'] {
  const count = (needle: string) => html.split(needle).length - 1;
  return { images: count('<img'), rows: count('<tr'), unresolved: count('|thumbnail!') + count('[^') };
}

function sprintFromString(value: string): SprintRef | null {
  const inner = /\[(.*)\]\s*$/.exec(value)?.[1];
  if (!inner) return null;
  const fields = Object.fromEntries(
    inner.split(/,(?=[A-Za-z]+=)/).map((pair) => {
      const i = pair.indexOf('=');
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );
  const id = Number(fields.id);
  return Number.isFinite(id) && fields.name ? { id, name: fields.name, state: String(fields.state ?? '').toLowerCase() } : null;
}

/**
 * Спринты задачи из поля gh-sprint. Jira Server отдает их строками вида
 * "com.atlassian.greenhopper.service.sprint.Sprint@...[id=4911,state=ACTIVE,name=...]",
 * mcp-atlassian кладет список в value; объекты с id и name тоже понимаются.
 */
export function parseSprints(raw: unknown): SprintRef[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { value?: unknown }).value) ? (raw as { value: unknown[] }).value : [];
  return list.flatMap((v): SprintRef[] => {
    if (typeof v === 'string') {
      const s = sprintFromString(v);
      return s ? [s] : [];
    }
    if (v && typeof v === 'object' && 'id' in v && 'name' in v) {
      const o = v as { id: unknown; name: unknown; state?: unknown };
      return [{ id: Number(o.id), name: String(o.name), state: String(o.state ?? '').toLowerCase() }];
    }
    return [];
  });
}

/** Текущий спринт задачи: активный, иначе последний из списка. */
export function currentSprint(sprints: SprintRef[]): SprintRef | null {
  return sprints.find((s) => s.state === 'active') ?? sprints.at(-1) ?? null;
}

/** Карточка задачи из ответа mcp-atlassian. */
export function toIssueRef(raw: RawIssue, options: JiraMcpOptions): IssueRef {
  const key = raw.key ?? '';
  return {
    key,
    summary: raw.summary ?? '',
    status: raw.status?.name ?? '',
    type: raw.issue_type?.name,
    updated: raw.updated,
    url: raw.browse_url ?? `${options.baseUrl.replace(/\/$/, '')}/browse/${key}`,
    labels: raw.labels ?? [],
    components: (raw.components ?? []).map((c) => (typeof c === 'string' ? c : (c.name ?? ''))).filter(Boolean),
    sprint: options.sprintField ? currentSprint(parseSprints(raw[options.sprintField])) : null,
    assignee: raw.assignee?.name ? { name: raw.assignee.name, displayName: raw.assignee.display_name } : null,
    ...(options.epicField ? { epic: epicOf(raw[options.epicField]) } : {}),
  };
}

/** Ключ эпика из поля Epic Link: mcp-atlassian отдает его объектом { value } или строкой. */
export function epicOf(raw: unknown): string | null {
  const value = raw && typeof raw === 'object' ? (raw as { value?: unknown }).value : raw;
  return typeof value === 'string' && value ? value : null;
}

/** Задача с полями для шагов из ответа mcp-atlassian; от комментариев остаются id, автор и время. */
export function toIssue(raw: RawIssue, options: JiraMcpOptions): Issue {
  return {
    ...toIssueRef(raw, options),
    description: (raw.description ?? '').replace(/\r\n?/g, '\n'),
    ...(Array.isArray(raw.comments) ? { comments: raw.comments.map((c) => ({ id: String(c.id ?? ''), author: c.author?.name ?? '', created: c.created ?? '' })) } : {}),
  };
}

/** Порт Jira поверх инструментов mcp-atlassian. */
export function createJiraMcp(call: McpCall, options: JiraMcpOptions): JiraPort {
  const refFields = ['summary', 'status', 'issuetype', 'updated', 'labels', 'components', 'assignee', options.sprintField, options.epicField].filter(Boolean).join(',');
  let restWarned = false;
  return {
    async search(jql, limit) {
      const r = (await call('jira_search', { jql, fields: refFields, limit })) as { issues?: RawIssue[] };
      return (r.issues ?? []).map((i) => toIssueRef(i, options));
    },
    async getIssue(key) {
      const r = (await call('jira_get_issue', {
        issue_key: key,
        fields: `${refFields},description,comment`,
        // Комментарии нужны наблюдателю: новые комментарии других людей он показывает как изменение задачи.
        comment_limit: COMMENT_LIMIT,
        update_history: false,
      })) as RawIssue;
      if (!r?.key) throw new Error(`Задача ${key} не найдена`);
      return toIssue(r, options);
    },
    async getTransitions(key) {
      const rest = restOf(options);
      if (rest) {
        try {
          return await restTransitions(rest, key);
        } catch (e) {
          // Переходы те же и в mcp-atlassian, только без целевых статусов: доска возьмет их из профиля.
          if (!restWarned) console.warn(`REST Jira недоступен, переходы берутся из mcp-atlassian: ${e instanceof Error ? e.message : String(e)}`);
          restWarned = true;
        }
      }
      const r = (await call('jira_get_transitions', { issue_key: key })) as { id: string | number; name: string }[];
      return (Array.isArray(r) ? r : []).map((t): Transition => ({ id: String(t.id), name: t.name }));
    },
    async transition(key, transitionId) {
      await call('jira_transition_issue', { issue_key: key, transition_id: String(transitionId) });
    },
    async assign(key, username) {
      await call('jira_assign_issue', { issue_key: key, assignee: username });
    },
    async sprints(boardId, state) {
      const r = (await call('jira_get_sprints_from_board', { board_id: String(boardId), state, limit: 20 })) as { id: string | number; name: string; state?: string }[];
      return (Array.isArray(r) ? r : []).map((s) => ({ id: Number(s.id), name: s.name, state: String(s.state ?? state).toLowerCase() }));
    },
    // Вложения и комментарии идут через REST: в mcp-atlassian нет загрузки, а его конвертер Markdown
    // экранирует подчеркивания и ломает миниатюры !file|thumbnail!.
    async attachments(key) {
      const r = (await restCall(needRest(options), 'GET', `/issue/${encodeURIComponent(key)}?fields=attachment`)) as { fields?: { attachment?: unknown[] } };
      return (r.fields?.attachment ?? []).map((a) => toAttachment(a as Parameters<typeof toAttachment>[0]));
    },
    async attach(key, file) {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(file)]), basename(file));
      const r = (await restCall(needRest(options), 'POST', `/issue/${encodeURIComponent(key)}/attachments`, { form })) as unknown[];
      return toAttachment((Array.isArray(r) ? r[0] : undefined) as Parameters<typeof toAttachment>[0]);
    },
    async deleteAttachment(id) {
      await restCall(needRest(options), 'DELETE', `/attachment/${encodeURIComponent(id)}`);
    },
    async comment(key, body, commentId) {
      const rest = needRest(options);
      const base = `/issue/${encodeURIComponent(key)}/comment`;
      const saved = (await restCall(rest, commentId ? 'PUT' : 'POST', commentId ? `${base}/${encodeURIComponent(commentId)}` : base, { json: { body } })) as { id?: unknown };
      const id = String(saved?.id ?? commentId ?? '');
      const shown = (await restCall(rest, 'GET', `${base}/${encodeURIComponent(id)}?expand=renderedBody`)) as { renderedBody?: string };
      return {
        id,
        url: `${options.baseUrl.replace(/\/$/, '')}/browse/${key}?focusedCommentId=${id}#comment-${id}`,
        rendered: renderStats(shown?.renderedBody ?? ''),
      };
    },
  };
}
