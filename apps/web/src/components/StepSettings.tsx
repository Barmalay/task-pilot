import { Save, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { settingValueText, type ParamValue, type ParamValues, type StepSetting, type StepStatus } from '@task-pilot/step-kit';
import { customSettings, settingChipText, settingsApplyHint, settingsPatch, SOURCE_HINT } from '../settings.ts';
import { Button, Chip, Tip } from '../ui.tsx';

const FIELD = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900';

/**
 * Поле одной настройки шага: список вариантов, галочка или текст. Значение, которого среди вариантов уже нет (статус
 * убрали с доски), остается в списке с пометкой, а не подменяется первым вариантом.
 */
export function SettingControl({ setting, value, disabled, onChange }: { setting: StepSetting; value: ParamValue; disabled?: boolean; onChange: (value: ParamValue) => void }) {
  if (setting.type === 'boolean') {
    return <input type="checkbox" className="size-4 accent-blue-600" aria-label={setting.label} checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (setting.type === 'text') {
    return <input className={FIELD} aria-label={setting.label} value={String(value)} maxLength={200} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
  const known = setting.options.some((o) => o.value === value);
  return (
    <select className={FIELD} aria-label={setting.label} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={String(value)}>{`${String(value)} (такого варианта больше нет)`}</option>}
      {setting.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Плашки настроек, с которыми шаг выполнится не как обычно: выбранных в прогоне или заданных пресетом. */
export function SettingChips({ settings }: { settings: StepSetting[] }) {
  return (
    <>
      {customSettings(settings).map((s) => (
        <Tip key={s.key} text={`${s.label}: ${settingValueText(s)}. ${SOURCE_HINT[s.source]}`}>
          <Chip tone="violet">
            <SlidersHorizontal className="size-3" aria-hidden />
            {settingChipText(s)}
          </Chip>
        </Tip>
      ))}
    </>
  );
}

/**
 * Форма настроек шага в прогоне: значения меняются в форме, а "Сохранить" отправляет только измененные. Значение,
 * равное умолчанию, возвращает умолчание пресета или манифеста; "По умолчанию" ставит умолчания во все поля. Под
 * полями сказано, когда шаг получит сохраненное.
 */
export function StepSettingsForm({
  settings,
  status,
  busy,
  onSave,
  onCancel,
}: {
  settings: StepSetting[];
  status: StepStatus;
  busy: boolean;
  onSave: (patch: Record<string, ParamValue | null>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<ParamValues>(() => Object.fromEntries(settings.map((s) => [s.key, s.value])));
  const patch = settingsPatch(settings, values);
  const dirty = Object.keys(patch).length > 0;
  const atDefaults = settings.every((s) => values[s.key] === s.defaultValue);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" data-settings-form>
      {settings.map((s) => (
        <div key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-slate-700 dark:text-slate-200">{s.label}</span>
          <SettingControl setting={s} value={values[s.key] ?? s.value} disabled={busy} onChange={(v) => setValues({ ...values, [s.key]: v })} />
          <span className="text-xs text-slate-500">по умолчанию: {settingValueText({ ...s, value: s.defaultValue })}</span>
        </div>
      ))}
      <p className="text-xs text-slate-500">{settingsApplyHint(status)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={Save} disabled={busy || !dirty} onClick={() => onSave(patch)}>
          Сохранить
        </Button>
        <Button variant="ghost" size="sm" icon={Undo2} disabled={busy || atDefaults} onClick={() => setValues(Object.fromEntries(settings.map((s) => [s.key, s.defaultValue])))}>
          По умолчанию
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </div>
  );
}
