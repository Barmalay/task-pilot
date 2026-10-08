import type { StepManifest } from './manifest.ts';
import { boardStatuses } from './milestones.ts';
import type { JiraConfig } from './profiles.ts';

/** Значение настройки перевода по доске, которое выключает перевод: задача остается в своем статусе. */
export const NO_MOVE = 'none';

export type ParamValue = string | boolean;
export type ParamValues = Record<string, ParamValue>;

type Board = Pick<JiraConfig, 'path' | 'after' | 'milestones'>;
type ParamDef = StepManifest['params'][string];

/** Настройка шага для экрана: что это, какие есть варианты, что по умолчанию и что выбрано в прогоне. */
export interface StepSetting {
  key: string;
  type: ParamDef['type'];
  label: string;
  /** Варианты: у select - из манифеста, у jiraStatus - "как обычно", "не переводить" и статусы доски; у остальных пусто. */
  options: { value: string; label: string }[];
  /** Значение по умолчанию: из пресета, иначе из манифеста. */
  defaultValue: ParamValue;
  /** Значение, с которым шаг выполнится. */
  value: ParamValue;
  /** Откуда значение: выбрано в прогоне, задано пресетом или взято из манифеста. */
  source: 'run' | 'preset' | 'manifest';
}

const baseDefault = (p: ParamDef): ParamValue => p.default ?? (p.type === 'boolean' ? false : '');

function optionsOf(p: ParamDef, board: Board): StepSetting['options'] {
  if (p.type === 'select') return (p.options ?? []).map((value) => ({ value, label: value }));
  if (p.type !== 'jiraStatus') return [];
  const usual = p.milestone ? board.milestones[p.milestone] : undefined;
  return [
    { value: '', label: usual ? `как обычно (${usual})` : usual === null ? 'как обычно (на этой доске не переводить)' : 'как обычно' },
    { value: NO_MOVE, label: 'не переводить' },
    ...boardStatuses(board).map((value) => ({ value, label: value })),
  ];
}

/**
 * Настройки шага по его манифесту: варианты, умолчание пресета (preset) поверх манифеста и выбор прогона (run) поверх
 * умолчания. Значения для настроек, которых в манифесте нет, не показываются.
 */
export function stepSettings(manifest: Pick<StepManifest, 'params'>, board: Board, preset: ParamValues = {}, run: ParamValues = {}): StepSetting[] {
  return Object.entries(manifest.params).map(([key, p]) => {
    const defaultValue = Object.hasOwn(preset, key) ? preset[key]! : baseDefault(p);
    const value = Object.hasOwn(run, key) ? run[key]! : defaultValue;
    const source = Object.hasOwn(run, key) ? 'run' : Object.hasOwn(preset, key) ? 'preset' : 'manifest';
    return { key, type: p.type, label: p.label, options: optionsOf(p, board), defaultValue, value, source };
  });
}

/** Что не так со значением настройки; null - значение подходит. */
export function paramProblem(setting: Pick<StepSetting, 'type' | 'label' | 'options'>, value: unknown): string | null {
  if (setting.type === 'boolean') return typeof value === 'boolean' ? null : `"${setting.label}": нужно да или нет`;
  if (typeof value !== 'string') return `"${setting.label}": нужен текст`;
  if (setting.type === 'text') return value.length <= 200 ? null : `"${setting.label}": не длиннее 200 знаков`;
  return setting.options.some((o) => o.value === value) ? null : `"${setting.label}": варианта "${value}" нет`;
}

/**
 * Значения настроек, с которыми шаг выполняется (c.params): выбор прогона, иначе умолчание пресета, иначе манифест.
 * Пустой перевод по доске ("как обычно") становится статусом вехи шага на доске.
 */
export function effectiveParams(manifest: Pick<StepManifest, 'params'>, board: Board, preset: ParamValues = {}, run: ParamValues = {}): ParamValues {
  return Object.fromEntries(
    stepSettings(manifest, board, preset, run).map((s) => {
      const milestone = manifest.params[s.key]!.milestone;
      return [s.key, s.type === 'jiraStatus' && s.value === '' && milestone ? (board.milestones[milestone] ?? '') : s.value];
    }),
  );
}

/** Выбранное значение настройки словами: вариант, "да" или "нет", текст; пустой текст - "не задано". */
export function settingValueText(setting: Pick<StepSetting, 'type' | 'options' | 'value'>): string {
  if (setting.type === 'boolean') return setting.value ? 'да' : 'нет';
  const option = setting.options.find((o) => o.value === setting.value);
  return option?.label ?? (String(setting.value) || 'не задано');
}
