import type { BoardStep, JiraConfig } from './profiles.ts';
import type { JiraPort, Transition } from './types.ts';

/** План движения задачи к вехе доски. */
export type MilestonePlan =
  | { kind: 'done'; status: string }
  | { kind: 'transitions'; steps: BoardStep[] }
  | { kind: 'blocked'; reason: string };

const YO = /ё/g;
const QUOTES = /[«»"'`]/g;

/** Нормализует имя статуса или перехода: регистр, е с точками, кавычки и лишние пробелы не важны. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(YO, 'е').replace(QUOTES, '').replace(/\s+/g, ' ').trim();
}

/** Статусы основного пути доски по порядку, включая статусы после его конца. */
export function boardStatuses(board: Pick<JiraConfig, 'path' | 'after'>): string[] {
  const first = board.path[0];
  return first ? [first.from, ...board.path.map((p) => p.to), ...board.after] : [...board.after];
}

/**
 * Считает, какие переходы нужны, чтобы довести задачу из status до target.
 * Назад по доске не двигает: если задача уже на вехе или дальше, веха считается достигнутой.
 */
export function planMilestone(status: string, target: string, board: Pick<JiraConfig, 'path' | 'after'>): MilestonePlan {
  const order = boardStatuses(board);
  const rank = (s: string) => order.findIndex((x) => normalizeName(x) === normalizeName(s));
  const current = rank(status);
  const goal = rank(target);
  if (goal < 0) return { kind: 'blocked', reason: `Целевой статус ${target} не описан в пути доски` };
  if (current < 0) return { kind: 'blocked', reason: `Статус ${status} вне основного пути доски, к ${target} задачу нужно перевести вручную` };
  if (current >= goal) return { kind: 'done', status };
  return { kind: 'transitions', steps: board.path.slice(current, goal) };
}

/**
 * Находит нужный переход среди доступных: по id, затем по нормализованному имени, затем по статусу, в который он
 * ведет (его сообщает REST Jira). id и имя перехода в профиле доски необязательны.
 */
export function findTransition(available: Transition[], wanted: Pick<BoardStep, 'id' | 'name' | 'to'>): Transition | undefined {
  return (
    (wanted.id === undefined ? undefined : available.find((t) => String(t.id) === String(wanted.id))) ??
    (wanted.name === undefined ? undefined : available.find((t) => normalizeName(t.name) === normalizeName(wanted.name!))) ??
    available.find((t) => t.to !== undefined && normalizeName(t.to) === normalizeName(wanted.to))
  );
}

/** Переход для людей: "имя" из профиля доски, а без имени - в какой статус он ведет. */
export function transitionName(s: Pick<BoardStep, 'name' | 'to'>): string {
  return s.name ? `"${s.name}"` : `в ${s.to}`;
}

/**
 * Проводит задачу по переходам плана. Перед каждым переходом сверяет его с доступными сейчас,
 * после перехода проверяет статус; возвращает итоговый статус.
 */
export async function walkTransitions(jira: JiraPort, key: string, from: string, steps: BoardStep[], log: (message: string) => void): Promise<string> {
  let status = from;
  for (const s of steps) {
    const available = await jira.getTransitions(key);
    const t = findTransition(available, s);
    if (!t) throw new Error(`Переход ${transitionName(s)}${s.id ? ` (${s.id})` : ''} недоступен из статуса ${status}`);
    await jira.transition(key, t.id);
    status = (await jira.getIssue(key)).status;
    if (status !== s.to) throw new Error(`После перехода ${transitionName(s)} статус ${status}, ожидался ${s.to}`);
    log(`${s.from} → ${s.to}`);
  }
  return status;
}
