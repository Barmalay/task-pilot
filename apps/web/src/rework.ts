import type { CatalogDto, RunViewDto } from '@task-pilot/api-types';

/** Пресет, на который прогон переключается, чтобы доработать задачу после ее изменений в Jira. */
export const REWORK_PRESET = 'rework';

/**
 * Шаг, которым прогон дорабатывает задачу после ее изменений в Jira: шаг пресета доработки с триггером
 * issue.changed. Прогон на этом пресете ищет его среди своих шагов, другой прогон - среди шагов пресета в каталоге,
 * на который он переключится. null - такого шага нет, и дорабатывать нечем.
 */
export function issueReworkStep(view: Pick<RunViewDto, 'run' | 'steps'>, catalog: Pick<CatalogDto, 'steps' | 'presets'> | undefined): string | null {
  if (view.run.presetId === REWORK_PRESET) return view.steps.find((s) => s.trigger?.event === 'issue.changed')?.stepId ?? null;
  const steps = catalog?.presets.find((p) => p.id === REWORK_PRESET)?.steps ?? [];
  return steps.find((id) => catalog?.steps.find((s) => s.id === id)?.trigger?.event === 'issue.changed') ?? null;
}
