import { ChevronRight, Hand, LoaderCircle, Lock, MessageSquarePlus, RotateCcw, SkipForward, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { StepDto } from '@task-pilot/api-types';
import type { ParamValue } from '@task-pilot/step-kit';
import { BACKGROUND_HINT, GATE_HINT, KIND_LOOK, stageHint, STEP_LOOK, StepStatusIcon, TRIGGER_LABEL, triggerHint } from '../status.tsx';
import { duration } from '../timing.ts';
import { Button, Chip, cx, Tip } from '../ui.tsx';
import { Markdown } from './Markdown.tsx';
import { SettingChips, StepSettingsForm } from './StepSettings.tsx';

const RETRYABLE = new Set(['failed', 'blocked', 'skipped', 'succeeded', 'already', 'simulated', 'waiting']);
/** Шаг, на котором прогон остановился: его пропускают, а не снимают отметку. */
const SKIPPABLE = new Set(['failed', 'blocked', 'waiting_owner', 'waiting']);
/** Упавший или заблокированный шаг с агентом: его можно повторить с замечанием агенту. */
const NOTABLE = new Set(['failed', 'blocked']);

/**
 * Почему шаг можно или нельзя отметить. Отметка - план прогона: она меняется только у шага, который еще не
 * начинался, а начатый шаг повторяют или, если прогон на нем остановился, пропускают.
 */
function toggleHint(step: StepDto, canToggle: boolean): string {
  if (!step.implemented) return `Шаг появится на этапе ${step.stage}`;
  if (step.status !== 'pending') {
    return SKIPPABLE.has(step.status)
      ? 'Шаг уже начинался, отметка не меняется: чтобы идти дальше без него, нажмите Пропустить, чтобы выполнить заново - Повторить'
      : 'Шаг уже начинался, отметка не меняется: выполнить его заново можно кнопкой Повторить';
  }
  if (!canToggle) return 'План не меняется, пока прогон выполняется';
  return step.selected ? 'Шаг в плане прогона и выполнится по порядку. Снимите отметку, чтобы не выполнять его' : 'Отметьте, чтобы шаг выполнился в этом прогоне';
}

function agentText(agent: NonNullable<StepDto['agent']>): string {
  if (agent.running) return agent.runs > 1 ? `агент работает, запуск ${agent.runs}` : 'агент работает';
  return `агент: ${duration(agent.durationMs)}, $${agent.costUsd.toFixed(2)}${agent.runs > 1 ? `, запусков: ${agent.runs}` : ''}`;
}

/**
 * Строка шага в степпере прогона: выбор, статус, пояснение и мини-кнопки. Если на шаге работал
 * агент, рядом с названием видно, что он работает сейчас, или сколько времени и денег ушло
 * на все его запуски. В компактной строке пояснение шага - в подсказке к названию. Шаг, который
 * ждет подтверждения, открывает его своей кнопкой: так владелец доходит до любого из нескольких
 * подтверждений прогона, а не только до первого на главной кнопке. У шага с настройками (куда перевести
 * задачу по доске) кнопка "Настроить" открывает их форму, а плашки у названия показывают, что выбрано не
 * как обычно; настройки меняются у любого шага, который сейчас не идет.
 */
export function StepRow({
  step,
  index,
  locked,
  busy,
  compact = false,
  flash = false,
  onToggle,
  onRetry,
  onSkip,
  onOpenGate,
  onSettings,
}: {
  step: StepDto;
  index: number;
  locked: boolean;
  /** Идет другое действие: кнопки строки ждут его, чтобы двойной клик не дал ложную ошибку. */
  busy: boolean;
  /** Строка без пояснения шага: оно видно только у шага, на котором прогон сейчас. */
  compact?: boolean;
  /** Подсветить строку: к ней только что перешли с полосы шагов. */
  flash?: boolean;
  onToggle: (selected: boolean) => void;
  /** Повторить шаг; с замечанием (note) агент шага получит его вместе с ошибкой прошлой попытки. */
  onRetry: (note?: string) => void;
  onSkip: () => void;
  /** Открыть подтверждение шага: есть, пока шаг ждет решения владельца. */
  onOpenGate?: () => void;
  /** Сохранить настройки шага в прогоне: измененные значения, null - снова умолчание. */
  onSettings: (patch: Record<string, ParamValue | null>) => void;
}) {
  const look = STEP_LOOK[step.status];
  const kind = KIND_LOOK[step.kind];
  const KindIcon = kind.icon;
  const canToggle = step.implemented && !locked && !busy && step.status === 'pending';
  // Замечание к повтору: поле под строкой упавшего шага, у которого есть агент.
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const canNote = step.implemented && !locked && step.kind !== 'code' && NOTABLE.has(step.status);
  const retryWithNote = () => {
    onRetry(note.trim());
    setNoting(false);
    setNote('');
  };
  // Настройки меняются у шага, который сейчас не идет: идущий шаг уже получил свои.
  const [setting, setSetting] = useState(false);
  const canSet = step.implemented && step.settings.length > 0 && step.status !== 'running';
  return (
    <li
      data-step={step.stepId}
      className={cx(
        'flex items-start gap-3 px-4 py-3 transition-shadow',
        compact && 'py-2',
        flash && 'ring-2 ring-inset ring-blue-400',
        !step.implemented && 'opacity-60',
        step.status === 'waiting_owner' && 'bg-amber-50/70 dark:bg-amber-950/40',
        step.status === 'waiting' && 'bg-sky-50/70 dark:bg-sky-950/40',
        step.status === 'running' && 'bg-blue-50/70 dark:bg-blue-950/40',
      )}
    >
      <Tip text={toggleHint(step, canToggle)} className="mt-1">
        <input
          type="checkbox"
          className="size-4 accent-blue-600 disabled:pointer-events-none"
          checked={step.selected}
          disabled={!canToggle}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`Выполнять шаг "${step.title}"`}
        />
      </Tip>
      <StepStatusIcon status={step.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="w-5 text-right text-xs tabular-nums text-slate-400">{index}</span>
          {compact ? (
            <Tip text={step.hint}>
              <span className="font-medium">{step.title}</span>
            </Tip>
          ) : (
            <span className="font-medium">{step.title}</span>
          )}
          <Tip text={kind.hint}>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <KindIcon className="size-3.5" aria-hidden />
              {kind.label}
            </span>
          </Tip>
          {step.gate !== 'none' && (
            <Tip text={GATE_HINT[step.gate]}>
              <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                <Lock className="size-3.5" aria-hidden />
                {step.gate === 'publish' ? 'подтверждение всегда' : 'подтверждение'}
              </span>
            </Tip>
          )}
          {step.background && (
            <Tip text={BACKGROUND_HINT}>
              <Chip>фоновый</Chip>
            </Tip>
          )}
          {!step.implemented && (
            <Tip text={stageHint(step.stage)}>
              <Chip>этап {step.stage}</Chip>
            </Tip>
          )}
          {step.trigger && (
            <Tip text={triggerHint(step.trigger)}>
              <Chip tone="violet">по событию: {TRIGGER_LABEL[step.trigger.event]}</Chip>
            </Tip>
          )}
          <SettingChips settings={step.settings} />
          {step.agent && (
            <Tip text="Время и стоимость всех запусков агента на этом шаге">
              <span
                data-agent={step.agent.running ? 'running' : 'idle'}
                className={cx('inline-flex items-center gap-1 text-xs tabular-nums', step.agent.running ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400')}
              >
                {step.agent.running && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
                {agentText(step.agent)}
              </span>
            </Tip>
          )}
        </div>
        {!compact && <p className="mt-0.5 pl-7 text-sm text-slate-500 dark:text-slate-400">{step.hint}</p>}
        {step.note && <p className="mt-1 pl-7 text-sm text-slate-700 dark:text-slate-300">{step.note}</p>}
        {step.error && <Markdown text={step.error} className="mt-1 ml-7 max-h-60 overflow-y-auto rounded-md bg-red-50 px-2 py-1 text-sm text-red-800 dark:bg-red-950 dark:text-red-200" />}
        {noting && canNote && (
          <div className="mt-2 ml-7 space-y-2">
            <textarea
              className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              rows={3}
              autoFocus
              placeholder="Что сказать агенту: что не так и что сделать иначе. Он получит замечание вместе с ошибкой прошлой попытки"
              aria-label={`Замечание агенту к повтору шага "${step.title}"`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) retryWithNote();
                if (e.key === 'Escape') setNoting(false);
              }}
            />
            <div className="flex gap-2">
              <Button size="sm" icon={RotateCcw} disabled={busy || !note.trim()} onClick={retryWithNote} title={note.trim() ? 'Повторить шаг: агент получит замечание и ошибку прошлой попытки. Cmd+Enter тоже повторяет' : 'Напишите замечание агенту'}>
                Повторить с замечанием
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setNoting(false)}>
                Отмена
              </Button>
            </div>
          </div>
        )}
        {setting && canSet && (
          <div className="mt-2 ml-7">
            <StepSettingsForm
              settings={step.settings}
              status={step.status}
              busy={busy}
              onCancel={() => setSetting(false)}
              onSave={(patch) => {
                onSettings(patch);
                setSetting(false);
              }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onOpenGate && (
          <Button variant="warning" size="sm" icon={Hand} disabled={busy} onClick={onOpenGate} title="Открыть подтверждение шага: что он сделает, и кнопки Подтвердить, Переделать и Отклонить">
            Подтвердить
          </Button>
        )}
        {canSet && !setting && (
          <Button
            variant="ghost"
            size="sm"
            icon={SlidersHorizontal}
            disabled={busy}
            onClick={() => setSetting(true)}
            title={`Настройки шага в этом прогоне: ${step.settings.map((x) => x.label.toLowerCase()).join(', ')}`}
          >
            Настроить
          </Button>
        )}
        {canNote && !noting && (
          <Button variant="ghost" size="sm" icon={MessageSquarePlus} disabled={busy} onClick={() => setNoting(true)} title="Повторить шаг с замечанием агенту: что не так и что сделать иначе">
            С замечанием
          </Button>
        )}
        {step.implemented && !locked && RETRYABLE.has(step.status) && (
          <Button variant="ghost" size="sm" icon={RotateCcw} disabled={busy} onClick={() => onRetry()} title="Выполнить шаг заново: прежний черновик и результат шага сбрасываются">
            Повторить
          </Button>
        )}
        {step.implemented && step.selected && !locked && SKIPPABLE.has(step.status) && (
          <Button variant="ghost" size="sm" icon={SkipForward} disabled={busy} onClick={onSkip} title="Пропустить этот шаг и продолжить прогон: следующие шаги пойдут без него">
            Пропустить
          </Button>
        )}
        <Tip text={look.hint} className="ml-1">
          <Chip tone={look.tone} className="w-28 justify-center">
            {look.label}
          </Chip>
        </Tip>
      </div>
    </li>
  );
}

/** Свернутая группа шагов списка: сколько их и какие, нажатие раскрывает группу. */
export function StepFold({ label, steps, open, onToggle }: { label: string; steps: StepDto[]; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <ChevronRight className={cx('size-4 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        <span className="shrink-0 font-medium text-slate-700 dark:text-slate-200">{label}</span>
        {!open && <span className="min-w-0 truncate text-xs">{steps.map((s) => s.title).join(', ')}</span>}
      </button>
    </li>
  );
}
