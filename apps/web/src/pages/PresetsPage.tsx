import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Save, SlidersHorizontal, Trash2, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { settingValueText, type Preset } from '@task-pilot/step-kit';
import type { CatalogStepDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { SettingChips, SettingControl } from '../components/StepSettings.tsx';
import { addStep, draftChanged, draftOf, draftOrderIssues, draftProblems, emptyDraft, moveStep, presetOf, setStepParam, type PresetDraft } from '../presets.ts';
import { presetSettings } from '../settings.ts';
import { PHASE_LABEL, stageHint } from '../status.tsx';
import { Button, Card, Chip, cx, ErrorBox, Loading, PageHeader, Tip } from '../ui.tsx';

const FIELD = 'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:disabled:bg-slate-900';

/** Выбор шага для добавления: шаги каталога, которых в пресете нет, по фазам. */
function AddStep({ steps, taken, onAdd }: { steps: CatalogStepDto[]; taken: string[]; onAdd: (step: CatalogStepDto) => void }) {
  const free = steps.filter((s) => !taken.includes(s.id));
  if (!free.length) return <p className="text-xs text-slate-500">В пресете уже все шаги каталога</p>;
  return (
    <label className="flex items-center gap-2 text-sm">
      <Plus className="size-4 text-slate-400" aria-hidden />
      <select
        className={cx(FIELD, 'max-w-md')}
        value=""
        onChange={(e) => {
          const step = free.find((s) => s.id === e.target.value);
          if (step) onAdd(step);
        }}
      >
        <option value="">Добавить шаг</option>
        {(Object.keys(PHASE_LABEL) as (keyof typeof PHASE_LABEL)[]).map((phase) => {
          const list = free.filter((s) => s.phase === phase);
          return list.length ? (
            <optgroup key={phase} label={PHASE_LABEL[phase]}>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.id}){s.implemented ? '' : `, этап ${s.stage}`}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
    </label>
  );
}

/**
 * Форма пресета: название, описание, шаги по порядку, какие из них включены в новом прогоне и умолчания настроек
 * шагов (куда перевести задачу по доске), которые прогон может поменять у себя.
 */
function Editor({ preset, steps, taken, locked, onSaved, onDeleted }: { preset: Preset | undefined; steps: CatalogStepDto[]; taken: string[]; locked: boolean; onSaved: (id: string) => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<PresetDraft>(() => (preset ? draftOf(preset) : emptyDraft()));
  const isNew = !preset;
  const byId = new Map(steps.map((s) => [s.id, s]));
  // Порядок шагов проверяется, как проверит сервер: ошибка не дает сохранить, предупреждение только показывается.
  const order = draftOrderIssues(draft, steps);
  const problems = [...draftProblems(draft, isNew, taken), ...order.filter((i) => i.level === 'error').map((i) => i.message)];
  const changed = draftChanged(draft, preset);
  const save = useMutation({
    mutationFn: () => (isNew ? api.createPreset(presetOf(draft)) : api.updatePreset(presetOf(draft))),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ['catalog'] });
      onSaved(saved.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deletePreset(draft.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['catalog'] });
      onDeleted();
    },
  });
  const set = (patch: Partial<PresetDraft>) => setDraft({ ...draft, ...patch });
  // Шаг, у которого открыты умолчания настроек.
  const [tuning, setTuning] = useState<string | null>(null);
  const setOn = (index: number, on: boolean) => set({ steps: draft.steps.map((s, i) => (i === index ? { ...s, on } : s)) });

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">{isNew ? 'Новый пресет' : preset.title}</h2>
        {!isNew && <span className="font-mono text-xs text-slate-400">pipelines/{preset.id}.yaml</span>}
      </div>
      <div className="space-y-4 px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-slate-500">id</span>
            <input className={cx(FIELD, 'font-mono')} value={draft.id} disabled={!isNew} placeholder="docs-only" onChange={(e) => set({ id: e.target.value })} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-slate-500">Название</span>
            <input className={FIELD} value={draft.title} placeholder="Только документы" onChange={(e) => set({ title: e.target.value })} />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-xs text-slate-500">Когда брать этот пресет</span>
          <input className={FIELD} value={draft.hint} placeholder="Задача без кода: страница вики и итоги в Jira" onChange={(e) => set({ hint: e.target.value })} />
        </label>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-slate-500">Шаги по порядку</span>
            <span className="text-xs text-slate-500">галочка - шаг включен в новом прогоне</span>
          </div>
          <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {draft.steps.map((s, i) => {
              const step = byId.get(s.id);
              const settings = step ? presetSettings(step.settings, s.params) : [];
              return (
                <li key={s.id} className="px-3 py-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-right text-xs text-slate-400 tabular-nums">{i + 1}</span>
                    <Tip text={step?.implemented === false ? `${stageHint(step.stage)}: включится, когда шаг реализуют` : 'Включен в новом прогоне; владелец может переключить его в прогоне'}>
                      <input type="checkbox" className="size-4 accent-blue-600" aria-label={`Включен по умолчанию: ${step?.title ?? s.id}`} checked={s.on} onChange={(e) => setOn(i, e.target.checked)} />
                    </Tip>
                    <span className={cx('min-w-0 flex-1 truncate', !s.on && 'text-slate-500')}>
                      {step?.title ?? s.id} <span className="font-mono text-xs text-slate-400">{s.id}</span>
                    </span>
                    <SettingChips settings={settings} />
                    {step && !step.implemented && <Chip>этап {step.stage}</Chip>}
                    {!step && <Chip tone="red">нет в каталоге</Chip>}
                    {settings.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={SlidersHorizontal}
                        aria-label="Настройки шага"
                        aria-expanded={tuning === s.id}
                        title={`Умолчания настроек шага в прогонах этого пресета: ${settings.map((x) => x.label.toLowerCase()).join(', ')}`}
                        onClick={() => setTuning(tuning === s.id ? null : s.id)}
                      />
                    )}
                    <Button variant="ghost" size="sm" icon={ArrowUp} aria-label="Выше" disabled={i === 0} onClick={() => setDraft(moveStep(draft, i, -1))} />
                    <Button variant="ghost" size="sm" icon={ArrowDown} aria-label="Ниже" disabled={i === draft.steps.length - 1} onClick={() => setDraft(moveStep(draft, i, 1))} />
                    <Button variant="ghost" size="sm" icon={X} aria-label="Убрать из пресета" onClick={() => set({ steps: draft.steps.filter((_x, k) => k !== i) })} />
                  </div>
                  {tuning === s.id && settings.length > 0 && (
                    <div className="mt-1.5 mb-1 ml-7 space-y-1.5" data-preset-settings>
                      {settings.map((x) => (
                        <div key={x.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-slate-700 dark:text-slate-200">{x.label}</span>
                          <SettingControl setting={x} value={x.value} onChange={(v) => setDraft(setStepParam(draft, s.id, x.key, v === x.defaultValue ? null : v))} />
                          <span className="text-xs text-slate-500">у шага: {settingValueText({ ...x, value: x.defaultValue })}</span>
                        </div>
                      ))}
                      <p className="text-xs text-slate-500">Умолчание для прогонов с этим пресетом, в том числе уже открытых; в самом прогоне его меняет кнопка "Настроить" у шага</p>
                    </div>
                  )}
                </li>
              );
            })}
            {!draft.steps.length && <li className="px-3 py-3 text-sm text-slate-500">Шагов пока нет</li>}
          </ol>
          <AddStep steps={steps} taken={draft.steps.map((s) => s.id)} onAdd={(step) => setDraft(addStep(draft, step.id, step.implemented))} />
        </div>

        {order.length > 0 && (
          <div className="space-y-1" data-order-issues>
            <span className="text-xs text-slate-500">Порядок шагов: шаг получает ключи от шагов выше и из входов прогона ({draft.inputs.join(', ')})</span>
            <ul className="space-y-1 text-sm">
              {order.map((i) => (
                <li key={`${i.stepId}-${i.key}`} className={i.level === 'error' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}>
                  {i.level === 'error' ? 'Ошибка' : 'Предупреждение'}: {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(save.error || remove.error) && <ErrorBox title="Не сохранилось" error={save.error ?? remove.error} />}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <Button icon={Save} spin={save.isPending} disabled={!changed || problems.length > 0 || save.isPending} title={problems.length ? problems.join('; ') : undefined} onClick={() => save.mutate()}>
            {isNew ? 'Создать' : 'Сохранить'}
          </Button>
          {!isNew && (
            <Button variant="secondary" icon={Undo2} disabled={!changed} onClick={() => setDraft(draftOf(preset))}>
              Отменить правки
            </Button>
          )}
          {!isNew && (
            <Button
              variant="danger"
              icon={Trash2}
              className="ml-auto"
              disabled={locked || remove.isPending}
              title={locked ? 'На этот пресет опирается Task Pilot: его можно изменить, но не удалить' : 'Прогоны с этим пресетом останутся как есть'}
              onClick={() => {
                if (window.confirm(`Удалить пресет "${preset.title}"?`)) remove.mutate();
              }}
            >
              Удалить
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Экран "Пресеты": наборы шагов цикла, из которых начинается прогон. Слева пресеты, справа форма выбранного:
 * название, когда его брать, шаги по порядку, какие включены в новом прогоне, и умолчания настроек шагов.
 * Сохранение пишет pipelines/<id>.yaml, и каталог перечитывается сразу. Пресеты, на которые опирается Task Pilot,
 * можно изменить, но не удалить.
 */
export function PresetsPage() {
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: api.catalog });
  const [selected, setSelected] = useState<string | null>(null);
  if (catalog.isLoading) return <Loading text="Загружаю пресеты" />;
  if (catalog.error || !catalog.data) return <ErrorBox error={catalog.error ?? 'нет данных'} />;
  const { presets, steps, protectedPresets, presetIssues } = catalog.data;
  const current = selected === '' ? undefined : (presets.find((p) => p.id === selected) ?? presets[0]);
  // Форма начинается заново, когда меняется сам пресет: после сохранения или правки файла.
  const key = current ? JSON.stringify(current) : 'new';

  return (
    <section className="space-y-5">
      <PageHeader
        title="Пресеты"
        help="Наборы шагов, из которых начинается прогон: порядок шагов, какие выбраны по умолчанию и умолчания их настроек. Шаги в прогоне можно включать и выключать и после выбора пресета"
      />
      <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card className="h-fit">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {presets.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-current={current?.id === p.id ? 'true' : undefined}
                  className={cx('w-full px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50', current?.id === p.id && 'bg-blue-50 dark:bg-blue-950/40')}
                  onClick={() => setSelected(p.id)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {p.title}
                    {presetIssues[p.id]?.some((i) => i.level === 'error') && (
                      <Tip text="Шаг стоит раньше шага, который дает нужный ему ключ: прогон на этом пресете остановится на нем">
                        <Chip tone="red">порядок</Chip>
                      </Tip>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    <span className="font-mono">{p.id}</span>, шагов {p.steps.length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-100 p-3 dark:border-slate-800">
            <Button variant="secondary" size="sm" icon={Plus} className="w-full" onClick={() => setSelected('')}>
              Новый пресет
            </Button>
          </div>
        </Card>
        <Editor
          key={key}
          preset={current}
          steps={steps}
          taken={presets.map((p) => p.id)}
          locked={!!current && protectedPresets.includes(current.id)}
          onSaved={(id) => setSelected(id)}
          onDeleted={() => setSelected(null)}
        />
      </div>
    </section>
  );
}
