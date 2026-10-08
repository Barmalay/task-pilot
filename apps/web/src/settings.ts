import { settingValueText, type ParamValue, type ParamValues, type StepSetting, type StepStatus } from '@task-pilot/step-kit';

/** Откуда значение настройки, словами для подсказки. */
export const SOURCE_HINT: Record<StepSetting['source'], string> = {
  run: 'Выбрано в этом прогоне',
  preset: 'Умолчание пресета',
  manifest: 'Как обычно для шага',
};

/**
 * Что отправить серверу из формы настроек: только измененные значения. Значение, равное умолчанию, уходит как null:
 * прогон не закрепляет его за собой, и шаг снова идет с умолчанием пресета или манифеста.
 */
export function settingsPatch(settings: StepSetting[], values: ParamValues): Record<string, ParamValue | null> {
  const patch: Record<string, ParamValue | null> = {};
  for (const s of settings) {
    if (!Object.hasOwn(values, s.key) || values[s.key] === s.value) continue;
    patch[s.key] = values[s.key] === s.defaultValue ? null : values[s.key]!;
  }
  return patch;
}

/** Настройки, которые шаг выполнит не как обычно: выбранные в прогоне или заданные пресетом. */
export const customSettings = (settings: StepSetting[]) => settings.filter((s) => s.source !== 'manifest');

/** Текст плашки настройки у шага: перевод по доске - коротко "Jira: ...", остальные - название и значение. */
export const settingChipText = (s: StepSetting) => `${s.type === 'jiraStatus' ? 'Jira' : s.label}: ${settingValueText(s)}`;

/** Когда шаг получит настройки, сохраненные сейчас: зависит от того, где он в прогоне. */
export function settingsApplyHint(status: StepStatus): string {
  if (status === 'pending') return 'Шаг выполнится с этими настройками';
  if (status === 'waiting_owner') return 'Шаг ждет подтверждения: после сохранения он сразу спросит его заново, уже с новыми настройками';
  if (status === 'waiting' || status === 'blocked') return 'Настройки применятся, когда шаг продолжится';
  return 'Шаг уже выполнялся: настройки применятся, когда его повторят';
}

/**
 * Настройки шага в редакторе пресета: умолчание манифеста из каталога и значение пресета поверх него. Значение,
 * равное умолчанию манифеста, пресет не хранит.
 */
export function presetSettings(settings: StepSetting[], params: ParamValues = {}): StepSetting[] {
  return settings.map((s) => (Object.hasOwn(params, s.key) ? { ...s, value: params[s.key]!, source: 'preset' as const } : s));
}
