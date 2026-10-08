import type { Preset, StepManifest } from './manifest.ts';

/** Ключи контекста, которые открытие задачи кладет в прогон до первого шага: задача и ее критерии приемки. */
export const TASK_INPUTS = ['issue', 'ac'] as const;

/** Замечание к порядку шагов пресета: ошибка не дает сохранить пресет, предупреждение только показывается. */
export interface PresetOrderIssue {
  level: 'error' | 'warning';
  /** Шаг, которому не хватает ключа. */
  stepId: string;
  key: string;
  message: string;
}

/**
 * Проверяет порядок шагов пресета по манифестам: идет по шагам по порядку и держит ключи, доступные к шагу, - сначала
 * inputs пресета, потом provides пройденных шагов. На ключ из requires, которого еще нет, дает замечание: поставщик
 * стоит позже или его нет в пресете - ошибка, поставщик выключен по умолчанию, а сам шаг нет - предупреждение. Шаги
 * вне каталога (manifests не знает их) пропускаются: неизвестные шаги находит другая проверка.
 */
export function presetOrderIssues(
  preset: Pick<Preset, 'steps' | 'off' | 'inputs'>,
  manifests: (id: string) => Pick<StepManifest, 'title' | 'requires' | 'provides'> | undefined,
): PresetOrderIssue[] {
  const title = (id: string) => manifests(id)?.title ?? id;
  const off = new Set(preset.off);
  // Ключи от шагов, включенных по умолчанию, и кто из выключенных шагов дает остальные.
  const ready = new Set(preset.inputs);
  const fromOff = new Map<string, string>();
  const issues: PresetOrderIssue[] = [];
  for (const [i, stepId] of preset.steps.entries()) {
    const m = manifests(stepId);
    if (!m) continue;
    for (const key of m.requires) {
      if (ready.has(key)) continue;
      const offProvider = fromOff.get(key);
      if (offProvider) {
        if (!off.has(stepId)) issues.push({ level: 'warning', stepId, key, message: `${key} для шага "${m.title}" дает шаг "${title(offProvider)}", выключенный по умолчанию` });
        continue;
      }
      const later = preset.steps.slice(i + 1).find((id) => manifests(id)?.provides.includes(key));
      issues.push(
        later
          ? { level: 'error', stepId, key, message: `шаг "${m.title}" требует ${key}, который дает шаг "${title(later)}", стоящий позже` }
          : { level: 'error', stepId, key, message: `ключ ${key} для шага "${m.title}" не дает ни один шаг пресета` },
      );
    }
    for (const key of m.provides) {
      if (off.has(stepId)) {
        if (!fromOff.has(key)) fromOff.set(key, stepId);
      } else {
        ready.add(key);
      }
    }
  }
  return issues;
}
