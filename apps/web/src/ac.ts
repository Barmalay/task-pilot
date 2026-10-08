import type { StepDto } from '@task-pilot/api-types';

/** Критерии приемки прогона для страницы задачи. */
export interface AcView {
  /** Что стоит в заголовке блока после "Критерии приемки: ". */
  label: string;
  items: string[];
  /** Файл плана, если критерии взяты из его раздела: в описании задачи их нет. */
  planFile: string | null;
}

/** Состояния шага, в которых его работа еще впереди. */
const AHEAD: StepDto['status'][] = ['pending', 'running', 'waiting_owner', 'waiting', 'failed', 'blocked'];

/** Шаг "Анализ и план" отмечен в прогоне и еще не прошел: критерии, которых нет в описании, зафиксирует он. */
export function analysisAhead(steps: Pick<StepDto, 'stepId' | 'selected' | 'status'>[]): boolean {
  return steps.some((s) => s.stepId === 'task.analyze' && s.selected && AHEAD.includes(s.status));
}

/**
 * Критерии приемки для страницы задачи: из описания задачи, а если их там нет - утвержденные с планом, с путем к
 * его файлу. null - блок не нужен: у прогона нет задачи Jira. planned - критерии еще зафиксирует шаг "Анализ и план".
 */
export function acView(context: Record<string, unknown>, planned: boolean): AcView | null {
  const ac = context.ac as string[] | null | undefined;
  if (ac === undefined) return null;
  if (ac?.length) return { label: String(ac.length), items: ac, planFile: null };
  if (ac) return { label: 'нет, метка skip_ac', items: [], planFile: null };
  const plan = context.plan as { file?: unknown; ac?: unknown } | undefined;
  const items = Array.isArray(plan?.ac) ? plan.ac.filter((x): x is string => typeof x === 'string') : [];
  if (items.length) return { label: `${items.length}, из плана: в описании задачи их нет`, items, planFile: typeof plan?.file === 'string' ? plan.file : null };
  return { label: planned ? 'в описании не найдены, их зафиксирует шаг "Анализ и план"' : 'в описании не найдены', items: [], planFile: null };
}
