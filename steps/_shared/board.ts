import type { BoardStep, MilestonePlan, StepContext } from '../../packages/step-kit/src/index.ts';
import { NO_MOVE, planMilestone } from '../../packages/step-kit/src/index.ts';

/** Куда шаг переводит задачу и какие переходы для этого нужны; target null - перевод выключен или вехи нет. */
export interface Move {
  target: string | null;
  plan: MilestonePlan;
  /** Перевод выключен: настройкой шага "не переводить" или пустой вехой доски. */
  off: boolean;
  /** Перевод выключен доской: веха шага на этой доске пустая (null). */
  byBoard: boolean;
}

/**
 * Перевод задачи шагом по доске: к статусу из настройки шага moveTo, а без нее - к вехе шага milestone из
 * профиля доски (jira.yaml). "Не переводить" и пустая веха доски оставляют задачу в ее статусе. Назад по доске шаг не
 * двигает (`planMilestone`).
 */
export function moveOf(c: StepContext, status: string, milestone: string): Move {
  const choice = c.params.moveTo;
  if (choice === NO_MOVE) return { target: null, plan: { kind: 'done', status }, off: true, byBoard: false };
  const target = typeof choice === 'string' && choice ? choice : c.jira.milestones[milestone];
  if (target === null) return { target: null, plan: { kind: 'done', status }, off: true, byBoard: true };
  if (!target) return { target: null, plan: { kind: 'blocked', reason: `В профиле доски (jira.yaml) нет вехи ${milestone}: задайте ее статус или null, если шаг на этой доске задачу не двигает` }, off: false, byBoard: false };
  return { target, plan: planMilestone(status, target, c.jira), off: false, byBoard: false };
}

/** Строка превью, когда перевод выключен: настройкой шага или пустой вехой доски. */
export const moveOffText = (status: string, byBoard = false) =>
  byBoard ? `Jira: задача остается в статусе ${status}, на этой доске шаг задачу не двигает` : `Jira: задача остается в статусе ${status}, перевод по доске выключен в настройках шага`;

/** Переход по доске для превью: из какого статуса в какой и, если профиль его называет, имя перехода. */
export const transitionText = (t: Pick<BoardStep, 'from' | 'to' | 'name'>, separator = ', ') => `${t.from} → ${t.to}${t.name ? `${separator}переход "${t.name}"` : ''}`;

/** Переходы плана для подтверждения: id из профиля доски, а без него - статус, в который ведет переход. */
export const transitionIds = (steps: Pick<BoardStep, 'id' | 'to'>[]) => steps.map((t) => t.id ?? `→ ${t.to}`);
