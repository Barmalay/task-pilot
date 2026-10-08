import { presetOrderIssues, TASK_INPUTS, type ParamValues, type Preset, type PresetOrderIssue } from '@task-pilot/step-kit';
import type { CatalogStepDto } from '@task-pilot/api-types';

/**
 * Пресет в редакторе: поля формы, шаги по порядку с отметкой "включен по умолчанию" и настройками шага по умолчанию
 * (только измененные) и входы прогона пресета.
 */
export interface PresetDraft {
  id: string;
  title: string;
  hint: string;
  steps: { id: string; on: boolean; params?: ParamValues }[];
  /** Ключи, которые есть в прогоне до первого шага; редактор их не меняет, а сохраняет как были. */
  inputs: string[];
}

/** id пресета: латиница в нижнем регистре, цифры и дефис, как имя файла pipelines/<id>.yaml. */
export const PRESET_ID = /^[a-z][a-z0-9-]*$/;

export function draftOf(preset: Preset): PresetDraft {
  const params = preset.params ?? {};
  return {
    id: preset.id,
    title: preset.title,
    hint: preset.hint,
    steps: preset.steps.map((id) => ({ id, on: !preset.off.includes(id), ...(params[id] && Object.keys(params[id]).length ? { params: params[id] } : {}) })),
    inputs: preset.inputs,
  };
}

export function emptyDraft(): PresetDraft {
  return { id: '', title: '', hint: '', steps: [], inputs: [...TASK_INPUTS] };
}

/** Пресет из черновика: выключенные по умолчанию шаги идут в off в порядке пресета, настройки шагов - в params. */
export function presetOf(d: PresetDraft): Preset {
  const params = Object.fromEntries(d.steps.filter((s) => s.params && Object.keys(s.params).length).map((s) => [s.id, s.params!]));
  return { id: d.id.trim(), title: d.title.trim(), hint: d.hint.trim(), steps: d.steps.map((s) => s.id), off: d.steps.filter((s) => !s.on).map((s) => s.id), inputs: d.inputs, params };
}

/**
 * Настройка шага пресета по умолчанию: значение для шага пресета; null убирает настройку, и шаг снова идет с
 * умолчанием манифеста.
 */
export function setStepParam(d: PresetDraft, stepId: string, key: string, value: string | boolean | null): PresetDraft {
  return {
    ...d,
    steps: d.steps.map((s) => {
      if (s.id !== stepId) return s;
      const { [key]: _old, ...rest } = s.params ?? {};
      const params = value === null ? rest : { ...rest, [key]: value };
      const { params: _was, ...step } = s;
      return Object.keys(params).length ? { ...step, params } : step;
    }),
  };
}

/** Шаг сдвинут на delta позиций; за краями списка шаг не уходит. */
export function moveStep(d: PresetDraft, index: number, delta: number): PresetDraft {
  const to = index + delta;
  if (index < 0 || index >= d.steps.length || to < 0 || to >= d.steps.length) return d;
  const steps = [...d.steps];
  const [step] = steps.splice(index, 1);
  steps.splice(to, 0, step!);
  return { ...d, steps };
}

/** Шаг добавлен в конец; нереализованный шаг добавляется выключенным: включится, когда его реализуют и включат. */
export function addStep(d: PresetDraft, id: string, implemented: boolean): PresetDraft {
  if (d.steps.some((s) => s.id === id)) return d;
  return { ...d, steps: [...d.steps, { id, on: implemented }] };
}

/** Что мешает сохранить пресет; пустой список - можно сохранять. */
export function draftProblems(d: PresetDraft, isNew: boolean, taken: string[]): string[] {
  const problems: string[] = [];
  if (isNew && !PRESET_ID.test(d.id.trim())) problems.push('id: латиница в нижнем регистре, цифры и дефис, с буквы');
  if (isNew && taken.includes(d.id.trim())) problems.push(`пресет ${d.id.trim()} уже есть`);
  if (!d.title.trim()) problems.push('нужно название');
  if (!d.hint.trim()) problems.push('нужно описание');
  if (!d.steps.length) problems.push('нужен хотя бы один шаг');
  return problems;
}

/** Черновик отличается от сохраненного пресета. */
export function draftChanged(d: PresetDraft, preset: Preset | undefined): boolean {
  return !preset || JSON.stringify(presetOf(d)) !== JSON.stringify({ ...preset, off: preset.steps.filter((id) => preset.off.includes(id)), params: presetOf(draftOf(preset)).params });
}

/** Замечания к порядку шагов черновика по шагам каталога: те же, что сервер проверит при сохранении. */
export function draftOrderIssues(d: PresetDraft, steps: Pick<CatalogStepDto, 'id' | 'title' | 'requires' | 'provides'>[]): PresetOrderIssue[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return presetOrderIssues(presetOf(d), (id) => byId.get(id));
}
