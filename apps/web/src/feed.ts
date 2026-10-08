import type { EventDto } from '@task-pilot/api-types';

/** Фильтр полной ленты. */
export type FeedFilter = 'all' | 'file' | 'agent' | 'approval' | 'question' | 'problem';

/** Фильтры полной ленты по порядку показа. */
export const FEED_FILTERS: { id: FeedFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'Все', hint: 'Все события прогона' },
  { id: 'file', label: 'Файлы', hint: 'Правки и новые файлы агента: по клику дифф с номерами строк' },
  { id: 'agent', label: 'Агент', hint: 'Что агент делал: команды, чтение, поиск, правки, его мысли и вехи' },
  { id: 'approval', label: 'Подтверждения', hint: 'Запросы подтверждений и ваши решения: по клику то, что было показано на подтверждении' },
  { id: 'question', label: 'Вопросы', hint: 'Вопросы агента и ваши ответы, ваши вопросы о прогоне и ответы на них' },
  { id: 'problem', label: 'Сбои', hint: 'Падения шагов и прогона, отказы агенту, ошибки движка' },
];

/** Инструменты, которые меняют файлы. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

type Obj = Record<string, unknown>;
const dataOf = (e: Pick<EventDto, 'data'>): Obj => (e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Obj) : {});

/** Инструмент вызова агента: из данных события, у старых событий - по началу сообщения "Edit: путь". */
export function toolOf(e: Pick<EventDto, 'type' | 'message' | 'data'>): string | null {
  if (e.type !== 'agent.tool') return null;
  const tool = dataOf(e).tool;
  if (typeof tool === 'string') return tool;
  return /^([\w.-]+)(?::|$)/.exec(e.message ?? '')?.[1] ?? null;
}

/** Событие - сбой: падение шага или прогона, отказ агенту, ошибка движка, агента, каталога или резервной копии, лимит расхода. */
function isProblem(e: Pick<EventDto, 'type' | 'data'>): boolean {
  if (['agent.denied', 'agent.failed', 'engine.error', 'catalog.error', 'backup.failed', 'budget.exceeded', 'budget.exhausted'].includes(e.type)) return true;
  return (e.type === 'step.status' || e.type === 'run.status') && dataOf(e).status === 'failed';
}

/** Проходит ли событие фильтр и поиск по тексту без учета регистра. */
export function matchesFeed(e: Pick<EventDto, 'type' | 'message' | 'data' | 'stepId'>, filter: FeedFilter, query = ''): boolean {
  const q = query.trim().toLowerCase();
  if (q && !`${e.message ?? ''} ${e.stepId ?? ''}`.toLowerCase().includes(q)) return false;
  switch (filter) {
    case 'all':
      return true;
    case 'file':
      return FILE_TOOLS.has(toolOf(e) ?? '');
    case 'agent':
      return e.type.startsWith('agent.') && !isProblem(e);
    case 'approval':
      return e.type.startsWith('approval.');
    case 'question':
      return e.type.startsWith('question.') || e.type.startsWith('ask.');
    case 'problem':
      return isProblem(e);
  }
}

/**
 * Есть ли у события подробности, которые стоит открыть: вызов агента со ссылкой на журнал, подтверждение, вопрос или
 * данные события, кроме одного статуса шага или прогона.
 */
export function hasDetails(e: Pick<EventDto, 'type' | 'data'>): boolean {
  // Вопрос владельца о прогоне и ответ целиком - в карточке вопросов, у события в ленте подробностей нет.
  if (e.type.startsWith('ask.')) return false;
  const data = dataOf(e);
  if (e.type === 'agent.tool') return typeof data.toolUseId === 'string';
  if (typeof data.approvalId === 'string' || typeof data.questionId === 'string') return true;
  return Object.keys(data).some((k) => k !== 'status' && k !== 'error');
}

/**
 * Отстала ли загруженная история от живого потока. Поток держит только последние события, и когда он целиком новее
 * первой страницы истории, между ними могли выпасть события. Пустая первая страница старше любого события.
 */
export function historyBehind(firstPage: Pick<EventDto, 'id'>[] | undefined, live: Pick<EventDto, 'id'>[]): boolean {
  const oldestLive = live[0];
  if (!firstPage || !oldestLive) return false;
  return oldestLive.id > (firstPage.at(-1)?.id ?? 0);
}

/**
 * С чем открыть окно ленты: с событием по id (запись журнала сбоев и правок) или с первым событием шага с начала
 * отрезка его времени (клик по отрезку в карточке времени).
 */
export type FeedTarget = { eventId: number } | { stepId: string; at: string };

/**
 * Событие цели среди загруженных, по порядку: событие с этим id или первое событие шага не раньше момента. undefined -
 * такого события среди загруженных еще нет, и окно догружает историю раньше.
 */
export function findTarget(events: EventDto[], target: FeedTarget): EventDto | undefined {
  if ('eventId' in target) return events.find((e) => e.id === target.eventId);
  const from = Date.parse(target.at);
  return events.find((e) => e.stepId === target.stepId && Date.parse(e.ts) >= from);
}

/** События из страниц истории и живого потока: каждое один раз, по порядку. */
export function mergeFeed(...lists: EventDto[][]): EventDto[] {
  const byId = new Map<number, EventDto>();
  for (const list of lists) for (const e of list) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Строки диффа с номерами: у удаленной строки номер в старом файле, у добавленной - в новом, у общей - оба. */
export function numberedLines(hunk: { oldStart: number; newStart: number; lines: string[] }): { kind: ' ' | '-' | '+'; old: number | null; new: number | null; text: string }[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
    // Служебная строка диффа ("\ No newline at end of file") номеров не занимает.
    if (line.startsWith('\\')) return { kind: ' ' as const, old: null, new: null, text: line };
    const kind = line.startsWith('-') ? '-' : line.startsWith('+') ? '+' : ' ';
    const text = line.slice(1);
    if (kind === '-') return { kind, old: oldNo++, new: null, text };
    if (kind === '+') return { kind, old: null, new: newNo++, text };
    return { kind, old: oldNo++, new: newNo++, text };
  });
}
