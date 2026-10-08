/**
 * MCP-сервер "pipeline" для агентных шагов (stdio). CLI Claude запускает его из конфигурации,
 * которую пишет сервис агентов; сервер говорит с API Task Pilot по одноразовому токену запуска.
 *
 * Инструменты: ask_owner - вопрос владельцу с ожиданием ответа в интерфейсе,
 * report_progress - короткое сообщение о ходе работы в ленту прогона, qa_browser и qa_kibana_logs - QA-браузер
 * для шагов, которым он разрешен манифестом (сервер отклоняет вызовы остальных).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const url = process.env.TASK_PILOT_URL ?? '';
const token = process.env.TASK_PILOT_AGENT_TOKEN ?? '';
const askTimeoutMs = Number(process.env.TASK_PILOT_ASK_TIMEOUT_MS ?? 55 * 60_000);
/** Сколько секунд сервер держит один запрос ожидания ответа. */
const POLL_SECONDS = 25;

interface Question {
  id: string;
  status: 'open' | 'answered' | 'expired';
  answer: string | null;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-task-pilot': '1', 'x-task-pilot-agent': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Task Pilot ответил ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

const server = new McpServer({ name: 'pipeline', version: '0.1.0' });

server.registerTool(
  'ask_owner',
  {
    description:
      'Задать вопрос владельцу задачи и дождаться ответа в интерфейсе Task Pilot. Для кодов из SMS, капчи, выбора между вариантами и спорных решений. Возвращает текст ответа.',
    inputSchema: {
      question: z.string().min(1).max(4000).describe('Вопрос: коротко и с контекстом, чтобы ответить без чтения логов'),
      options: z.array(z.string().min(1).max(200)).max(8).optional().describe('Варианты ответа, если они есть'),
    },
  },
  async ({ question, options }) => {
    const q = await api<Question>('POST', '/api/agent/questions', { question, options: options ?? [] });
    const deadline = Date.now() + askTimeoutMs;
    while (Date.now() < deadline) {
      const wait = Math.max(1, Math.min(POLL_SECONDS, Math.ceil((deadline - Date.now()) / 1000)));
      const current = await api<Question>('GET', `/api/agent/questions/${q.id}?wait=${wait}`);
      if (current.status === 'answered') return text(current.answer ?? '');
      if (current.status !== 'open') break;
    }
    await api('POST', `/api/agent/questions/${q.id}/expire`, {}).catch(() => undefined);
    return text('Владелец не ответил. Не жди дальше: заверши шаг и в итоге опиши, какой ответ нужен и зачем.');
  },
);

server.registerTool(
  'report_progress',
  {
    description: 'Короткое сообщение владельцу о ходе работы: что сделано и что дальше. Не для вопросов.',
    inputSchema: { message: z.string().min(1).max(500) },
  },
  async ({ message }) => {
    await api('POST', '/api/agent/progress', { message });
    return text('ok');
  },
);

server.registerTool(
  'qa_browser',
  {
    description: [
      'Действия в QA-браузере Task Pilot (Chrome, который видит и владелец) драйвером cdp.mjs. Возвращает вывод драйвера.',
      'Действия выполняются по порядку, каждое объект с одним основным ключом: {navigate:url,settle?:мс}, {wait:мс}, {waitFor:css,timeout?:мс},',
      '{click:css,settle?:мс}, {type:{selector,text}}, {eval:js}, {shot:"имя-без-расширения"}, {viewport:{width,height,mobile}|"reset"},',
      '{clearCookies:true}, {cookies:true}, {block:[шаблоны url]}, {unblock:true}, {newTab:url}, {useTab:номер}, {useTabUrl:подстрока},',
      '{useTabTitle:подстрока}, {useTabWhere:{urlIncludes,titleExcludes}}, {mark:"A"}, {listTabs:true}, {closeTabUrl:подстрока}, {log:текст}.',
      'Открываются только адреса http и https не на этой машине. Скриншоты ложатся в папку qa артефактов задачи,',
      'их можно смотреть инструментом Read. Действия block и viewport живут до конца одного вызова.',
    ].join(' '),
    inputSchema: {
      actions: z.array(z.record(z.string(), z.unknown())).min(1).max(60).describe('Действия драйвера по порядку'),
    },
  },
  async ({ actions }) => text((await api<{ output: string }>('POST', '/api/agent/browser', { actions })).output),
);

server.registerTool(
  'qa_kibana_logs',
  {
    description:
      'Текстовая выгрузка логов контейнера стенда через вкладку Kibana в QA-браузере (kibana_logs.mjs драйвера): для анализа, не для артефакта. Вкладка Kibana должна быть открыта. TRACE, DEBUG, Logbook и ACCESS_LOG отбрасываются. Без service - логи, которые команда задала по умолчанию (qa.logs в team.yaml), с service - логи этого сервиса на стенде прогона.',
    inputSchema: {
      minutes: z.number().int().positive().max(1440).optional().describe('Окно последних минут, если не задана пара from и to'),
      from: z.string().optional().describe('Начало окна, ISO 8601 с часовым поясом'),
      to: z.string().optional().describe('Конец окна, ISO 8601 с часовым поясом'),
      phrases: z.array(z.string().min(1).max(300)).max(20).optional().describe('Фразы, например state попытки: запись подходит, если есть любая'),
      service: z.string().optional().describe('Сервис - id профиля репозитория, например mobile: его логи в namespace стенда прогона с индексом и полями источника логов стенда'),
    },
  },
  async ({ minutes, from, to, phrases, service }) =>
    text((await api<{ output: string }>('POST', '/api/agent/kibana-logs', { minutes, from, to, phrases: phrases ?? [], ...(service ? { service } : {}) })).output),
);

await server.connect(new StdioServerTransport());
