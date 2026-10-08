import type { RunHistoryDto } from '@task-pilot/api-types';
import { sortBy, type Sort } from './sort.ts';
import { activeMs } from './timing.ts';

const DAY = 86_400_000;

/** Фильтры истории прогонов; null - без ограничения. */
export interface HistoryFilter {
  /** Поиск по ключу задачи и описанию прогона. */
  query: string;
  preset: string | null;
  status: string | null;
  /** Сколько последних дней по началу прогона. */
  days: number | null;
}

export const NO_FILTER: HistoryFilter = { query: '', preset: null, status: null, days: null };

/** Статус прогона в истории: идущий прогон - "идет", как в таблице, а не статус его последнего шага. */
export const historyStatus = (h: RunHistoryDto): string => (h.timing.live ? 'running' : h.run.status);

/** Прогоны истории, которые проходят фильтры: поиск без учета регистра, пресет, статус и период по началу прогона. */
export function filterHistory(rows: RunHistoryDto[], f: HistoryFilter, now: number): RunHistoryDto[] {
  const q = f.query.trim().toLowerCase();
  const since = f.days === null ? null : now - f.days * DAY;
  return rows.filter(
    (h) =>
      (!q || `${h.run.issueKey} ${h.summary ?? ''}`.toLowerCase().includes(q)) &&
      (f.preset === null || h.run.presetId === f.preset) &&
      (f.status === null || historyStatus(h) === f.status) &&
      (since === null || (h.timing.start !== null && Date.parse(h.timing.start) >= since)),
  );
}

/** Столбец истории, по которому она сортируется; без сортировки - новые прогоны сверху. */
export type HistorySortKey = 'issue' | 'start' | 'active' | 'work' | 'agent' | 'owner' | 'pause' | 'cost' | 'problems';

/** Сбои и правки прогона одним числом: падения, переделки, отказы, круги петель и отказы агенту. */
export const problemsOf = (h: RunHistoryDto) => h.journal.failures + h.journal.reworks + h.journal.rejects + h.journal.loops + h.journal.denials;

const VALUE: Record<HistorySortKey, (h: RunHistoryDto) => number | string> = {
  issue: (h) => h.run.issueKey,
  start: (h) => (h.timing.start ? Date.parse(h.timing.start) : 0),
  active: (h) => activeMs(h.timing),
  work: (h) => h.timing.workMs,
  agent: (h) => h.timing.agentMs,
  owner: (h) => h.timing.questionsMs + h.timing.approvalsMs,
  pause: (h) => h.timing.pauseMs,
  cost: (h) => h.timing.costUsd,
  problems: problemsOf,
};

/** История в порядке сортировки по столбцу; без нее - как пришла с сервера, новые сверху. */
export function sortHistory(rows: RunHistoryDto[], sort: Sort<HistorySortKey> | null): RunHistoryDto[] {
  return sortBy(rows, sort, (h, key) => VALUE[key](h));
}

/** Итоги дня: сколько прогонов начато, их время без пауз и стоимость агентов. */
export interface DayStat {
  /** День по местному времени, ГГГГ-ММ-ДД. */
  day: string;
  runs: number;
  activeMs: number;
  costUsd: number;
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Итоги по дням начала прогонов за последние days дней до now включительно, по местному времени и с пустыми днями:
 * по ним видно, как меняются число прогонов, их время без пауз и расход агентов.
 */
export function dailyStats(rows: RunHistoryDto[], now: number, days = 30): DayStat[] {
  const out = new Map<string, DayStat>();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = dayKey(d.getTime());
    out.set(day, { day, runs: 0, activeMs: 0, costUsd: 0 });
  }
  for (const h of rows) {
    if (!h.timing.start) continue;
    const s = out.get(dayKey(Date.parse(h.timing.start)));
    if (!s) continue;
    s.runs += 1;
    s.activeMs += activeMs(h.timing);
    s.costUsd += h.timing.costUsd;
  }
  return [...out.values()];
}

/** Работа шага в прогонах по порядку их начала, последние limit: как меняется обычное время шага. */
export function stepTrend(rows: RunHistoryDto[], stepId: string, limit = 20): number[] {
  return rows
    .filter((h) => h.timing.start)
    .sort((a, b) => a.timing.start!.localeCompare(b.timing.start!))
    .flatMap((h) => {
      const s = h.timing.steps.find((x) => x.stepId === stepId);
      return s ? [s.workMs] : [];
    })
    .slice(-limit);
}
