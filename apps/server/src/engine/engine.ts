import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkOutputs,
  defaultStandLike,
  effectiveParams,
  fillKey,
  isStepWaiting,
  ISSUE_KEY,
  lintBlocks,
  lintText,
  paramProblem,
  settingValueText,
  standEnvId,
  stepSettings,
  stepSigns,
  triggerEvents,
  type JiraConfig,
  type LinkedRun,
  type LintIssue,
  type LintOptions,
  type ParamValue,
  type ParamValues,
  type Ports,
  type Preset,
  type Preview,
  type RepoChoice,
  type RunStatus,
  type StepAgent,
  type StepContext,
  type StepManifest,
  type StepStatus,
  type StepTeam,
  type StepTexts,
  type WaitEvent,
} from '@task-pilot/step-kit';
import { NO_STYLE } from '@task-pilot/step-kit';
import type { CatalogView } from '../catalog/catalog.ts';
import type { Profiles } from '../config.ts';
import { stableHash } from '../lib/hash.ts';
import type { Redactor } from '../lib/redact.ts';
import type { EventRow, RunRow, RunStepRow, Store } from '../store/db.ts';
import type { EventBus } from './events.ts';
import { EngineError } from './errors.ts';
import { RESETTABLE, RESTARTED, RUN_STATUS_TEXT, SHUTDOWN, STEP_STATUS_TEXT, STOPPED, STOPS, STUCK, UNTOUCHED, type Waiting } from './status.ts';
import type { RunView, StepView } from './view.ts';

export { EngineError } from './errors.ts';
export { RESTARTED, RUN_STATUS_TEXT, STEP_STATUS_TEXT, STOPPED } from './status.ts';
export type { RunView, StepView } from './view.ts';

type Outcome = 'next' | 'wait' | 'stop';

/** Откуда движок берет агента для шага. */
export interface AgentFactory {
  forStep(target: { runId: string; stepId: string; manifest: StepManifest; signal: AbortSignal }): StepAgent;
}

/** Зависимости движка. */
export interface EngineDeps {
  store: Store;
  bus: EventBus;
  catalog: CatalogView;
  profiles: Profiles;
  ports: Ports;
  redact: Redactor;
  agents: AgentFactory;
  /** Секреты и имена для линтера публикуемых текстов. */
  lint: LintOptions;
  /** Служебная папка: в ней у каждого прогона свои журналы сборок. */
  dataDir: string;
  /** Профиль доски для шагов с логином активного аккаунта Jira; без него - профиль доски слоев как есть. */
  jira?: () => JiraConfig;
  /** Пакет команды для шагов; без него у шагов нет скиллов команды. */
  team?: StepTeam;
  /** Правила текстов команды и личный стиль; читаются заново для каждого шага, правка rules.md действует сразу. */
  texts?: () => StepTexts;
}

/** Команда без пакета: скиллов нет, шаги теста на стенде и вики скажут, чего не хватает. */
export const NO_TEAM: StepTeam = { id: '', title: '', qaSkill: null, wikiSkill: null, wikiSpace: null };

/**
 * Замечание владельца к повтору упавшего шага для агента: ошибка прошлой попытки и что просит владелец. Движок
 * дописывает его к заданию агента в следующей попытке шага.
 */
export function retryNoteText(note: string, error: string | null): string {
  return [
    '## Замечание владельца к повтору шага',
    ...(error ? ['', 'Прошлая попытка шага упала с ошибкой:', error] : []),
    '',
    `Владелец просит: ${note}`,
    '',
    'Учти замечание владельца в первую очередь: шаг запущен заново именно ради него.',
  ].join('\n');
}

/** Шаг закончен: фоновый шаг ниже него может стартовать, а прогон без незаконченных шагов выполнен. */
const DONE = new Set<StepStatus>(['succeeded', 'already', 'skipped', 'simulated']);

/**
 * Движок прогонов. Выполняет отмеченные шаги основной цепочки по порядку и останавливается на первом, которому
 * нужны данные, подтверждение владельца или который упал; фоновые шаги (`background` в манифесте) идут рядом с
 * цепочкой и ее не останавливают. Для каждого шага сначала спрашивает done (уже сделано?), затем prepare готовит
 * черновик, в пробном прогоне вместо run вызывается simulate, а шаги с подтверждением выполняются только по
 * одобрению ровно того содержимого, которое видел владелец. Публикуемые тексты перед подтверждением проходят линтер.
 */
export class Engine {
  private readonly d: EngineDeps;
  /** Идущая цепочка прогона. */
  private readonly active = new Map<string, Promise<void>>();
  /** Идущие фоновые шаги прогона. */
  private readonly backgrounds = new Map<string, Map<string, Promise<void>>>();
  /** Сигнал остановки прогона, общий для цепочки и фоновых шагов. */
  private readonly controllers = new Map<string, AbortController>();

  constructor(deps: EngineDeps) {
    this.d = deps;
    // Событие прогона с триггером на его шаг запускает этот шаг: движок сам слушает шину (onEvent).
    this.d.bus.on('event', (e: EventRow) => this.onEvent(e));
  }

  /**
   * Восстанавливает состояние после перезапуска сервера и подстраивает под текущий каталог прогоны,
   * в которых еще ничего не выполнялось.
   */
  recover(): void {
    const r = this.d.store.markInterrupted();
    if (r.steps || r.runs) {
      this.d.bus.emitEvent({ type: 'engine.recovered', message: `После перезапуска прервано шагов: ${r.steps}, прогонов на паузе: ${r.runs}` });
    }
    for (const run of this.d.store.listRuns(1000)) {
      this.adoptWaiting(run);
      this.syncSteps(run.id);
    }
  }

  /**
   * Ожидание в прежнем виде: у шага с записью waiting в контексте статус blocked, а прогон на паузе. Шаг и прогон
   * получают waiting, и наблюдатель продолжает их, как любое ожидание.
   */
  private adoptWaiting(run: RunRow): void {
    const waiting = this.d.store.getContext(run.id).waiting as Waiting | undefined;
    if (!waiting?.stepId || this.d.store.getStep(run.id, waiting.stepId)?.status !== 'blocked') return;
    this.d.store.updateStep(run.id, waiting.stepId, { status: 'waiting' });
    if (run.status === 'paused') this.d.store.updateRun(run.id, { status: 'waiting' });
  }

  /**
   * Прерывает все прогоны при завершении сервера: агенты и сборки текущих шагов останавливаются,
   * шаги помечаются прерванными перезапуском. Ждет завершения не дольше capMs.
   */
  async shutdown(capMs: number): Promise<void> {
    for (const c of this.controllers.values()) c.abort(SHUTDOWN);
    const all = Promise.allSettled([...this.active.values(), ...[...this.backgrounds.values()].flatMap((m) => [...m.values()])]);
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, capMs).unref())]);
  }

  /** Ждет, пока в прогоне не останется ни цепочки, ни фоновых шагов, в том числе запущенных за время ожидания. */
  async settled(runId: string): Promise<void> {
    for (;;) {
      const busy = [...(this.active.has(runId) ? [this.active.get(runId)!] : []), ...(this.backgrounds.get(runId)?.values() ?? [])];
      if (!busy.length) return;
      await Promise.allSettled(busy);
    }
  }

  /**
   * Подстраивает прогон под текущий пресет, пока в нем ничего не выполнялось: порядок шагов, новые
   * шаги и выбор по умолчанию для только что реализованных. Шаги, которые владелец включал или
   * выключал сам, сохраняют его выбор. Прогон, где что-то уже сделано, не трогается.
   */
  syncSteps(runId: string): void {
    const run = this.d.store.getRun(runId);
    if (!run || this.isActive(runId)) return;
    const preset = this.d.catalog.preset(run.presetId);
    const current = this.d.store.getSteps(runId);
    if (!preset || current.some((s) => !UNTOUCHED.includes(s.status)) || this.d.store.pendingApproval(runId)) return;
    const toggled = this.d.store.toggledSteps(runId);
    const byId = new Map(current.map((s) => [s.stepId, s]));
    const defaults = (stepId: string) => this.d.catalog.entry(stepId)?.implemented === true && !preset.off.includes(stepId);
    const wanted = [
      ...preset.steps.map((stepId) => ({ stepId, selected: toggled.has(stepId) && byId.has(stepId) ? byId.get(stepId)!.selected : defaults(stepId) })),
      ...current.filter((s) => !preset.steps.includes(s.stepId)).map((s) => ({ stepId: s.stepId, selected: s.selected })),
    ];
    const same = wanted.length === current.length && wanted.every((w, i) => current[i]?.stepId === w.stepId && current[i]?.selected === w.selected);
    if (same) return;
    this.d.store.resyncSteps(runId, wanted);
    this.d.bus.emitEvent({ runId, type: 'run.steps', message: `Шаги прогона обновлены по пресету "${preset.title}": порядок и шаги, реализованные после его создания` });
  }

  /** Прогон сейчас выполняется в этом процессе: идет его цепочка или фоновый шаг. */
  isActive(runId: string): boolean {
    return this.active.has(runId) || this.backgrounds.has(runId);
  }

  /** Идет цепочка прогона; фоновые шаги не в счет: ждущую цепочку можно продолжить и рядом с ними. */
  isChainActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Фоновый ли шаг по манифесту. */
  private isBackground(stepId: string): boolean {
    return this.d.catalog.entry(stepId)?.manifest.background === true;
  }

  /** Создает прогон по задаче с шагами пресета; реализованные шаги отмечены, кроме выключенных в пресете. */
  createRun(input: { issueKey: string; presetId?: string; repoId?: string; standId?: string | null; dryRun?: boolean }): RunRow {
    const issueKey = input.issueKey.trim().toUpperCase();
    if (!ISSUE_KEY.test(issueKey)) throw new EngineError(`Некорректный ключ задачи: ${input.issueKey}`);
    const preset = this.d.catalog.preset(input.presetId ?? 'full');
    if (!preset) throw new EngineError(`Пресет ${input.presetId ?? 'full'} не найден`);
    const repoId = input.repoId ?? (this.d.profiles.repos.find((r) => r.default) ?? this.d.profiles.repos[0]!).id;
    if (!this.d.profiles.repos.some((r) => r.id === repoId)) throw new EngineError(`Профиль репозитория ${repoId} не найден`);
    const standId = input.standId === undefined ? this.defaultStand(repoId) : input.standId;
    if (standId !== null && !this.d.profiles.stands.some((s) => s.id === standId)) throw new EngineError(`Стенд ${standId} не найден`);
    const steps = preset.steps.map((stepId) => ({
      stepId,
      selected: this.d.catalog.entry(stepId)?.implemented === true && !preset.off.includes(stepId),
    }));
    const run = this.d.store.createRun({ issueKey, repoId, standId, presetId: preset.id, dryRun: input.dryRun ?? false }, steps);
    this.d.bus.emitEvent({ runId: run.id, type: 'run.created', message: `Прогон ${issueKey}: пресет "${preset.title}"` });
    return run;
  }

  /** Доска Jira: ее статусы - варианты перевода по доске в настройках шагов. */
  private board(): JiraConfig {
    return this.d.jira?.() ?? this.d.profiles.jira;
  }

  /** Умолчания настроек шага из пресета прогона. */
  private presetParams(run: RunRow, stepId: string): ParamValues {
    return this.d.catalog.preset(run.presetId)?.params?.[stepId] ?? {};
  }

  /** Состояние прогона для интерфейса. */
  view(runId: string): RunView {
    const run = this.mustRun(runId);
    const stats = this.d.store.agentStats(runId);
    const board = this.board();
    const steps = this.d.store.getSteps(runId).map((s): StepView => {
      const e = this.d.catalog.entry(s.stepId);
      return {
        ...s,
        title: e?.manifest.title ?? s.stepId,
        hint: e?.manifest.hint ?? 'Шага нет в каталоге',
        phase: e?.manifest.phase ?? 'meta',
        kind: e?.manifest.kind ?? 'code',
        gate: e?.manifest.gate ?? 'none',
        implemented: e?.implemented === true,
        stage: e?.stage ?? null,
        ...stepSigns(e?.manifest),
        canRework: typeof e?.module?.prepare === 'function',
        agent: stats.get(s.stepId) ?? null,
        settings: e ? stepSettings(e.manifest, board, this.presetParams(run, s.stepId), s.params) : [],
      };
    });
    // Подтверждений бывает несколько (шаг цепочки и фоновые шаги), approval - первое из них.
    const approvals = this.d.store
      .pendingApprovals(runId)
      .map((a) => ({ id: a.id, stepId: a.stepId, preview: a.preview, createdAt: a.createdAt, blocked: lintBlocks(a.preview.lint) }));
    return {
      run,
      steps,
      context: this.d.store.getContext(runId),
      approval: approvals[0] ?? null,
      approvals,
      questions: this.d.store.openQuestions(runId),
      active: this.isActive(runId),
    };
  }

  /**
   * Включает или выключает шаг в плане прогона. Меняется только шаг, который еще не начинался: начатый шаг
   * повторяют, а тот, на котором прогон остановился, пропускают (`skip`).
   */
  setSelected(runId: string, stepId: string, selected: boolean): void {
    this.mustIdle(runId);
    const step = this.mustStep(runId, stepId);
    if (selected && !this.d.catalog.entry(stepId)?.implemented) throw new EngineError('Шаг еще не реализован');
    if (step.status !== 'pending') {
      throw new EngineError('Шаг уже начинался: отметка меняет план только у шагов, которые еще не начинались. Шаг можно повторить, а упавший - пропустить', 409);
    }
    this.d.store.updateStep(runId, stepId, { selected });
    this.d.bus.emitEvent({ runId, stepId, type: 'step.selected', message: `${this.title(stepId)}: ${selected ? 'включен' : 'выключен'}` });
  }

  /**
   * Меняет пресет, репозиторий, стенд и режим пробного прогона в этом же прогоне. Репозиторий меняется
   * только до первого выполненного шага: ветка и рабочая папка в контексте относятся к прежнему. Смена
   * пресета меняет шаги прогона (`applyPreset`), а результаты уже выполненных шагов остаются в контексте.
   * Ожидающее подтверждение при любой смене сгорает: владелец подтверждал действия для прежних параметров. Шаг,
   * который ждет события, после смены стенда или режима выполнится заново, а не продолжит ожидание прежнего.
   */
  setOptions(runId: string, options: { presetId?: string; repoId?: string; standId?: string | null; dryRun?: boolean }): void {
    this.mustIdle(runId);
    if (options.standId !== undefined && options.standId !== null && !this.d.profiles.stands.some((s) => s.id === options.standId)) {
      throw new EngineError(`Стенд ${options.standId} не найден`);
    }
    const preset = options.presetId === undefined ? undefined : this.d.catalog.preset(options.presetId);
    if (options.presetId !== undefined && !preset) throw new EngineError(`Пресет ${options.presetId} не найден`);
    const previousPreset = this.mustRun(runId).presetId;
    if (options.repoId !== undefined) {
      if (!this.d.profiles.repos.some((r) => r.id === options.repoId)) throw new EngineError(`Профиль репозитория ${options.repoId} не найден`);
      const started = this.d.store.getSteps(runId).some((s) => !UNTOUCHED.includes(s.status));
      if (started) throw new EngineError('Репозиторий меняется только до первого выполненного шага; для другого репозитория откройте новый прогон', 409);
    }
    const wasDry = this.mustRun(runId).dryRun;
    // Репозиторий другого контура не деплоится на стенд прежнего: стенд меняется на стенд по умолчанию его контура.
    const current = this.mustRun(runId);
    const standOf = (id: string | null) => (id ? this.d.profiles.stands.find((s) => s.id === id) : undefined);
    const repoOf = (id: string) => this.d.profiles.repos.find((r) => r.id === id);
    if (options.repoId !== undefined && options.standId === undefined && standOf(current.standId) && standOf(current.standId)?.contour !== repoOf(options.repoId)?.contour) {
      options = { ...options, standId: this.defaultStand(options.repoId) };
    }
    this.d.store.updateRun(runId, options);
    if (options.repoId !== undefined) {
      // Репозиторий выбрал владелец, в том числе оставил тот, что не определился по задаче: запуск больше не ждет выбора.
      const choice = this.d.store.getContext(runId).repoChoice as RepoChoice | null | undefined;
      if (choice) this.d.store.setContext(runId, 'repoChoice', { repoId: options.repoId, reason: 'владельцем', candidates: choice.candidates } satisfies RepoChoice, null);
    }
    const pending = this.d.store.pendingApprovals(runId);
    // Одобрения, которые еще не израсходованы, тоже сгорают: владелец подтверждал действия для прежних параметров.
    this.d.store.staleApprovals(runId);
    for (const a of pending) this.setStep(runId, a.stepId, 'pending', { note: 'Параметры прогона изменились, подтверждение нужно заново' });
    if (pending.length) this.setRunStatus(runId, 'paused');
    // Ждущий шаг ждал события прежнего стенда или режима: он не продолжает его, а выполнится заново.
    const waiting = this.d.store.getContext(runId).waiting as Waiting | undefined;
    const moved = (options.standId !== undefined && options.standId !== current.standId) || (options.dryRun !== undefined && options.dryRun !== current.dryRun);
    if (waiting && moved && this.d.store.getStep(runId, waiting.stepId)?.status === 'waiting') {
      this.d.store.deleteContext(runId, 'waiting');
      this.setStep(runId, waiting.stepId, 'pending', { note: 'Параметры прогона изменились, шаг выполнится заново' });
      this.setRunStatus(runId, 'paused');
    }
    if (wasDry && options.dryRun === false) {
      // После пробного прогона шаги выполняются по-настоящему, а их имитированные выходы убираются из контекста.
      for (const s of this.d.store.getSteps(runId).filter((x) => x.status === 'simulated')) {
        this.d.store.deleteContextOf(runId, s.stepId);
        this.d.store.updateStep(runId, s.stepId, { status: 'pending', note: null, startedAt: null, finishedAt: null });
      }
    }
    // После сгорания подтверждения: шаг, который его ждал, уже вернулся в ожидание и может уйти вместе с пресетом.
    if (preset && preset.id !== previousPreset) this.applyPreset(runId, preset);
    this.d.bus.emitEvent({ runId, type: 'run.options', message: 'Параметры прогона изменены', data: options });
  }

  /**
   * Ставит прогону шаги пресета с его отметками. Выполненные шаги, которых в пресете нет, остаются в начале
   * списка неотмеченными, как история прогона: их результаты уже в контексте и нужны следующим шагам.
   * Невыполненные шаги не из пресета убираются. Статус прогона пересчитывается по новому набору шагов.
   */
  private applyPreset(runId: string, preset: Preset): void {
    const current = this.d.store.getSteps(runId);
    const history = current.filter((s) => !preset.steps.includes(s.stepId) && !UNTOUCHED.includes(s.status)).map((s) => ({ stepId: s.stepId, selected: false }));
    const steps = preset.steps.map((stepId) => ({ stepId, selected: this.d.catalog.entry(stepId)?.implemented === true && !preset.off.includes(stepId) }));
    this.d.store.resyncSteps(runId, [...history, ...steps]);
    this.dropWaiting(runId);
    this.settleStatus(runId);
    this.d.bus.emitEvent({ runId, type: 'run.steps', message: `Пресет прогона: "${preset.title}"` });
  }

  /** Чего ждет шаг прогона: запись waiting в контексте, если она этого шага. */
  private waitingOf(runId: string, stepId: string): Waiting | undefined {
    const waiting = this.d.store.getContext(runId).waiting as Waiting | undefined;
    return waiting?.stepId === stepId ? waiting : undefined;
  }

  /**
   * Убирает запись waiting, когда ее шаг больше не ждет: шаг stepId повторяют или пропускают, или шаг ушел из плана
   * прогона. Иначе наблюдатель продолжал бы прогон ради шага, который уже не ждет.
   */
  private dropWaiting(runId: string, stepId?: string): void {
    const waiting = this.d.store.getContext(runId).waiting as Waiting | undefined;
    if (!waiting) return;
    const step = this.d.store.getStep(runId, waiting.stepId);
    if (waiting.stepId === stepId || !step?.selected || step.status !== 'waiting') this.d.store.deleteContext(runId, 'waiting');
  }

  /** Сколько кругов уже прошли петли доработки прогона, по шагу петли. */
  private loopRounds(runId: string): Record<string, number> {
    const loops = this.d.store.getContext(runId).loops;
    return loops && typeof loops === 'object' ? (loops as Record<string, number>) : {};
  }

  /**
   * Новый круг петли доработки: шаги restart этого прогона и сам шаг петли снова ждут выполнения и включаются,
   * если были выключены (без них исправление не дойдет до коммита и стенда), их черновики и подтверждения прежнего
   * круга сгорают. Результаты шагов остаются в контексте: по ним шаги сами поймут, что изменилось (новый коммит,
   * новая сборка, непройденные AC).
   */
  private restartLoop(runId: string, stepId: string, loop: { restart: string[]; max: number }): void {
    const rounds = this.loopRounds(runId);
    const round = (rounds[stepId] ?? 0) + 1;
    this.d.store.setContext(runId, 'loops', { ...rounds, [stepId]: round }, stepId);
    const inRun = new Set(this.d.store.getSteps(runId).map((s) => s.stepId));
    const again = [...loop.restart.filter((id) => inRun.has(id) && id !== stepId), stepId];
    for (const id of again) {
      this.burnApprovals(runId, id);
      this.d.store.setDraft(runId, id, undefined);
      this.d.store.updateStep(runId, id, { status: 'pending', selected: true, note: `Повтор после доработки, круг ${round} из ${loop.max}`, error: null, startedAt: null, finishedAt: null, feedback: null });
    }
    this.d.bus.emitEvent({
      runId,
      stepId,
      type: 'loop.restart',
      message: `${this.title(stepId)}: круг ${round} из ${loop.max} готов, заново ${again.filter((id) => id !== stepId).map((id) => this.title(id)).join(', ')}`,
      data: { round, max: loop.max, steps: again },
    });
  }

  /** Статус прогона по его шагам без выполнения: как его поставил бы проход движка. */
  private settleStatus(runId: string): void {
    this.setRunStatus(runId, this.chainStatus(runId));
  }

  /**
   * Статус цепочки прогона по ее шагам: идет, стоит на шаге (упал, заблокирован, ждет события), ждет следующего
   * запуска или выполнена. owner - шаг, который ждет подтверждения, дает waiting_owner, а не паузу.
   */
  private chainStatus(runId: string, owner = false): RunStatus {
    if (this.active.has(runId)) return 'running';
    const steps = this.d.store.getSteps(runId);
    const chain = steps.filter((s) => s.selected && !this.isBackground(s.stepId));
    const next = chain.find((s) => s.status === 'pending' || s.status === 'waiting_owner');
    const stuck = chain.find((s) => STOPS[s.status] !== undefined);
    if (steps.every((s) => UNTOUCHED.includes(s.status))) return 'idle';
    if (stuck && (!next || stuck.position < next.position)) return STOPS[stuck.status]!;
    if (!next) return 'completed';
    return owner && next.status === 'waiting_owner' ? 'waiting_owner' : 'paused';
  }

  /**
   * Статус прогона с его фоновыми шагами поверх статуса цепочки: подтверждение, которого ждет любой шаг, важнее
   * работы, а работа фонового шага важнее паузы и ожидания цепочки. Выполненная цепочка дает выполненный прогон,
   * только когда выполнены и фоновые шаги: упавший фоновый шаг - упавший прогон, неначатый или отклоненный - пауза.
   */
  private withBackground(runId: string, chain: RunStatus): RunStatus {
    const background = this.d.store.getSteps(runId).filter((s) => s.selected && this.isBackground(s.stepId));
    if (!background.length) return chain;
    if (chain === 'waiting_owner' || background.some((s) => s.status === 'waiting_owner')) return 'waiting_owner';
    if (chain === 'running' || this.backgrounds.has(runId)) return 'running';
    if (chain !== 'completed') return chain;
    if (background.some((s) => s.status === 'failed')) return 'failed';
    return background.every((s) => DONE.has(s.status)) ? 'completed' : 'paused';
  }

  /** Папка артефактов задачи прогона в репозитории (artifactsDir профиля): скриншоты QA кладутся в ее qa/. */
  artifactsDir(runId: string): string {
    const run = this.mustRun(runId);
    const repo = this.d.profiles.repos.find((r) => r.id === run.repoId);
    if (!repo) throw new EngineError(`Профиль репозитория ${run.repoId} не найден`);
    return resolve(repo.path, fillKey(repo.artifactsDir, run.issueKey));
  }

  /**
   * Удаляет прогон насовсем: шаги, контекст, ленту, подтверждения, вопросы, служебную папку прогона и журналы его
   * агентов. Выполняющийся прогон не удаляется. Ветки, рабочие папки и доки задачи принадлежат задаче, а не
   * прогону, и остаются. Возвращает самый свежий из оставшихся прогонов задачи.
   */
  deleteRun(runId: string): { next: string | null } {
    const run = this.mustRun(runId);
    this.mustIdle(runId);
    const sessions = this.d.store.agentSessionIds(runId);
    this.d.store.deleteRun(runId);
    rmSync(resolve(this.d.dataDir, 'runs', runId), { recursive: true, force: true });
    for (const id of sessions) rmSync(resolve(this.d.dataDir, 'agent', id), { recursive: true, force: true });
    this.d.bus.emitEvent({ runId: null, type: 'run.deleted', message: `Прогон ${run.issueKey} удален`, data: { runId, issueKey: run.issueKey } });
    return { next: this.d.store.runsOfIssue(run.issueKey)[0]?.id ?? null };
  }

  /**
   * Запускает цепочку отмеченных шагов; повторный вызов, пока она идет, возвращает тот же промис, а идущие фоновые
   * шаги новой цепочке не мешают. Заблокированные шаги проверяются заново: владелец мог включить шаг, который дает
   * нужные данные.
   */
  start(runId: string): Promise<void> {
    const run = this.mustRun(runId);
    const current = this.active.get(runId);
    if (current) return current;
    this.mustBeOnlyActive(runId, run.issueKey);
    // Задача не подсказала репозиторий: код не пишется в репозиторий по умолчанию, пока владелец не выберет свой.
    if ((this.d.store.getContext(runId).repoChoice as RepoChoice | null | undefined)?.unsure) {
      throw new EngineError('Репозиторий не определился по задаче: выберите его в карточке прогона или оставьте выбранный', 409);
    }
    // Заблокированный шаг цепочки проверяется заново, а ждущий - продолжается: событие случилось, или владелец проверяет
    // сейчас. Отклоненный фоновый шаг остается как есть: его повторяет владелец.
    for (const s of this.d.store.getSteps(runId)) {
      if (s.selected && !this.isBackground(s.stepId) && (s.status === 'blocked' || s.status === 'waiting')) this.d.store.updateStep(runId, s.stepId, { status: 'pending', note: null });
    }
    const controller = this.controllerOf(runId);
    const p = this.advance(runId, controller.signal)
      .catch((e: unknown) => {
        this.d.bus.emitEvent({ runId, type: 'engine.error', message: e instanceof Error ? e.message : String(e) });
        this.setRunStatus(runId, 'failed');
      })
      .finally(() => {
        this.active.delete(runId);
        this.releaseController(runId);
      });
    this.active.set(runId, p);
    return p;
  }

  /** Сигнал остановки прогона: общий для цепочки и фоновых шагов, после остановки - новый. */
  private controllerOf(runId: string): AbortController {
    const current = this.controllers.get(runId);
    if (current && !current.signal.aborted) return current;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  /** Сигнал больше не нужен, когда в прогоне ничего не идет. */
  private releaseController(runId: string): void {
    if (!this.isActive(runId)) this.controllers.delete(runId);
  }

  /**
   * Останавливает выполнение прогона: агенты и сборки текущего шага цепочки и фоновых шагов завершаются, шаги
   * помечаются остановленными, следующие шаги не запускаются. Кодовый шаг без ожидания доходит до конца.
   */
  stop(runId: string): void {
    this.mustRun(runId);
    const controller = this.controllers.get(runId);
    if (!controller) throw new EngineError('Прогон сейчас не выполняется', 409);
    this.d.bus.emitEvent({ runId, type: 'run.stopping', message: 'Владелец остановил прогон' });
    controller.abort();
  }

  /**
   * Меняет настройки шага в этом прогоне: значения поверх умолчаний пресета и манифеста, null возвращает умолчание.
   * Идущий шаг не меняется, остальные получат настройки, когда выполнятся. Подтверждение шага, который его ждал, было
   * на прежние настройки: оно сгорает, и шаг сразу выполняется снова, чтобы спросить его заново уже с новыми.
   */
  setParams(runId: string, stepId: string, patch: Record<string, ParamValue | null>): Promise<void> {
    const run = this.mustRun(runId);
    const step = this.mustStep(runId, stepId);
    const entry = this.d.catalog.entry(stepId);
    if (!entry) throw new EngineError('Шага нет в каталоге', 404);
    const running = step.status === 'running' || this.backgrounds.get(runId)?.has(stepId) === true;
    if (running) throw new EngineError('Шаг выполняется: настройки меняются, когда он не идет', 409);
    const asking = step.status === 'waiting_owner';
    // Шаг, который ждал подтверждения, запустится снова: проверка запуска - до того, как настройки поменялись.
    if (asking) this.mustBeOnlyActive(runId, run.issueKey);
    const settings = stepSettings(entry.manifest, this.board(), this.presetParams(run, stepId), step.params);
    const next: ParamValues = { ...step.params };
    for (const [key, value] of Object.entries(patch)) {
      const setting = settings.find((s) => s.key === key);
      if (!setting) throw new EngineError(`У шага "${entry.manifest.title}" нет настройки ${key}`);
      if (value === null) {
        delete next[key];
        continue;
      }
      const problem = paramProblem(setting, value);
      if (problem) throw new EngineError(problem);
      next[key] = value;
    }
    this.d.store.setStepParams(runId, stepId, next);
    const chosen = stepSettings(entry.manifest, this.board(), this.presetParams(run, stepId), next);
    const text = chosen.map((s) => `${s.label.toLowerCase()} - ${settingValueText(s)}`).join('; ');
    this.d.bus.emitEvent({ runId, stepId, type: 'step.params', message: `${this.title(stepId)}: настройки ${text}`, data: { params: next } });
    if (!asking) return Promise.resolve();
    this.burnApprovals(runId, stepId);
    this.setStep(runId, stepId, 'pending', { note: 'Настройки шага изменились: шаг спросит подтверждение заново, уже с ними' });
    // Черновик шага остается: агент его не переделывает, шаг только заново показывает, что сделает с новыми настройками.
    return this.isBackground(stepId) ? this.runBackground(runId, stepId) : this.start(runId);
  }

  /**
   * Сбрасывает шаг в ожидание и запускает его: шаг цепочки - вместе с цепочкой, когда она не идет, фоновый шаг -
   * один, когда не идет он сам. С замечанием владельца (note) агент шага получит его вместе с ошибкой прошлой попытки;
   * шагу без агента замечание передать некому.
   */
  retry(runId: string, stepId: string, note?: string): Promise<void> {
    this.mustStepIdle(runId, stepId);
    const step = this.mustStep(runId, stepId);
    const entry = this.d.catalog.entry(stepId);
    if (!RESETTABLE.includes(step.status) && step.status !== 'pending') throw new EngineError('Этот шаг сейчас нельзя повторить', 409);
    if (!entry?.implemented) throw new EngineError('Шаг еще не реализован');
    const remark = note?.trim() || null;
    if (remark && entry.manifest.kind === 'code') throw new EngineError('У шага нет агента, и замечание передать некому: повторите шаг без замечания');
    this.mustBeOnlyActive(runId, this.mustRun(runId).issueKey);
    this.burnApprovals(runId, stepId);
    // Повтор начинает шаг с начала, а не продолжает то, чего он ждал.
    this.dropWaiting(runId, stepId);
    const retryNote = remark ? retryNoteText(this.d.redact.text(remark), step.error) : null;
    this.d.store.updateStep(runId, stepId, { status: 'pending', selected: true, note: null, error: null, startedAt: null, finishedAt: null, feedback: null, retryNote });
    // Повтор начинает шаг заново: прежний черновик больше не нужен.
    this.d.store.setDraft(runId, stepId, undefined);
    this.d.bus.emitEvent({
      runId,
      stepId,
      type: 'step.status',
      message: `${this.title(stepId)}: повтор${remark ? ` с замечанием: ${this.d.redact.text(remark)}` : ''}`,
      // Замечание к повтору и ошибка, к которой оно относится, остаются в ленте: по ним журнал показывает правку владельца.
      data: { status: 'pending', ...(remark ? { note: this.d.redact.text(remark), error: step.error } : {}) },
    });
    return this.isBackground(stepId) ? this.runBackground(runId, stepId) : this.start(runId);
  }

  /**
   * Пропускает шаг, на котором прогон остановился: упавший, заблокированный, ждущий подтверждения или события, - и сразу
   * продолжает прогон, следующие шаги идут без него. Шаг, который еще не начинался, не пропускается, а выключается
   * отметкой (`setSelected`).
   */
  skip(runId: string, stepId: string): Promise<void> {
    this.mustStepIdle(runId, stepId);
    const step = this.mustStep(runId, stepId);
    if (!STUCK.includes(step.status)) {
      throw new EngineError('Пропустить можно шаг, на котором прогон остановился: упавший, заблокированный, ждущий подтверждения или события. Шаг, который еще не начинался, выключается отметкой', 409);
    }
    this.mustBeOnlyActive(runId, this.mustRun(runId).issueKey);
    this.burnApprovals(runId, stepId);
    this.dropWaiting(runId, stepId);
    this.setStep(runId, stepId, 'skipped', { note: 'Пропущен владельцем' });
    // Пропуск фонового шага цепочку не трогает: меняется только статус прогона.
    if (this.isBackground(stepId)) {
      this.setRunStatus(runId, this.chainStatus(runId, true));
      return Promise.resolve();
    }
    return this.start(runId);
  }

  /**
   * Срок ожидания шага вышел: наблюдатель роняет шаг с ошибкой, которую шаг бросил бы сам, и прогон
   * останавливается на нем. Шаг, который уже не ждет (продолжился, повторен, пропущен), и выполняющийся прогон
   * не трогаются.
   */
  failWaiting(runId: string, stepId: string, error: string): void {
    if (this.active.has(runId) || !this.waitingOf(runId, stepId) || this.d.store.getStep(runId, stepId)?.status !== 'waiting') return;
    this.d.store.deleteContext(runId, 'waiting');
    this.setStep(runId, stepId, 'failed', { error, finished: true });
    this.setRunStatus(runId, 'failed');
  }

  /**
   * Запуск по событию прогона: если прогон не выполняется, а у его отмеченного шага в манифесте trigger на это
   * событие с auto, шаг запускается заново. Так замечания в PR, которые нашел наблюдатель (pr.review), запускают
   * ответ на ревью; событие без такого шага ничего не запускает.
   */
  onEvent(e: Pick<EventRow, 'runId' | 'type'>): void {
    const runId = e.runId;
    if (!runId || !(triggerEvents as readonly string[]).includes(e.type) || this.active.has(runId)) return;
    const step = this.d.store.getSteps(runId).find((s) => {
      const trigger = this.d.catalog.entry(s.stepId)?.manifest.trigger;
      return s.selected && trigger?.auto === true && trigger.event === e.type;
    });
    if (!step) return;
    try {
      void this.retry(runId, step.stepId).catch(() => undefined);
    } catch {
      // Шаг сейчас нельзя повторить или задачу ведет другой прогон: событие остается в ленте, решает владелец.
    }
  }

  /**
   * Решение владельца по запросу подтверждения. Одобрение продолжает прогон, отказ ставит его на
   * паузу, "переделать" возвращает черновик шагу вместе с замечанием и сразу запускает прогон.
   */
  decide(approvalId: string, decision: 'approve' | 'reject' | 'rework', comment?: string): Promise<void> {
    const a = this.d.store.getApproval(approvalId);
    if (!a) throw new EngineError('Запрос подтверждения не найден', 404);
    if (a.status !== 'pending') throw new EngineError('Запрос подтверждения уже неактуален', 409);
    if (decision === 'approve') {
      if (lintBlocks(a.preview.lint)) {
        throw new EngineError('Публикация заблокирована линтером: исправьте текст через "Переделать" или отклоните', 409);
      }
      this.mustBeOnlyActive(a.runId, this.mustRun(a.runId).issueKey);
      this.d.store.updateApproval(a.id, { status: 'approved', comment: comment ?? null });
      this.d.bus.emitEvent({ runId: a.runId, stepId: a.stepId, type: 'approval.decided', message: `Подтверждено: ${a.preview.title}`, data: { approvalId: a.id, decision: 'approved' } });
      // Одобрение фонового шага запускает только его: цепочка идет своим ходом.
      return this.isBackground(a.stepId) ? this.runBackground(a.runId, a.stepId) : this.start(a.runId);
    }
    if (decision === 'rework') {
      const feedback = comment?.trim();
      if (!feedback) throw new EngineError('Напишите, что переделать');
      if (typeof this.d.catalog.entry(a.stepId)?.module?.prepare !== 'function') {
        throw new EngineError('Этот шаг не готовит черновик и переделать его нельзя: отклоните и повторите шаг', 409);
      }
      this.mustBeOnlyActive(a.runId, this.mustRun(a.runId).issueKey);
      this.d.store.updateApproval(a.id, { status: 'rework', comment: feedback });
      this.d.store.updateStep(a.runId, a.stepId, { feedback });
      this.d.bus.emitEvent({ runId: a.runId, stepId: a.stepId, type: 'approval.decided', message: `На доработку: ${a.preview.title}`, data: { approvalId: a.id, decision: 'rework', comment: feedback } });
      this.setStep(a.runId, a.stepId, 'pending', { note: `Переделать: ${feedback}` });
      return this.isBackground(a.stepId) ? this.runBackground(a.runId, a.stepId) : this.start(a.runId);
    }
    // Во время выполнения отказ потерялся бы: движок дошел бы до шага и попросил то же подтверждение снова.
    this.mustStepIdle(a.runId, a.stepId);
    this.d.store.updateApproval(a.id, { status: 'rejected', comment: comment ?? null });
    this.d.bus.emitEvent({ runId: a.runId, stepId: a.stepId, type: 'approval.decided', message: `Отклонено: ${a.preview.title}`, data: { approvalId: a.id, decision: 'rejected', comment } });
    const note = `Отклонено владельцем${comment ? `: ${comment}` : ''}`;
    if (this.isBackground(a.stepId)) {
      // Отклоненный фоновый шаг сам не стартует снова: его повторяет или пропускает владелец.
      this.setStep(a.runId, a.stepId, 'blocked', { note });
      this.setRunStatus(a.runId, this.chainStatus(a.runId, true));
      return Promise.resolve();
    }
    this.setStep(a.runId, a.stepId, 'pending', { note });
    this.setRunStatus(a.runId, 'paused');
    return Promise.resolve();
  }

  /**
   * Выполняет отмеченные шаги цепочки по порядку. Упавший или заблокированный шаг останавливает цепочку:
   * следующие шаги не выполняются, пока владелец его не повторит или не пропустит. Перед каждым шагом цепочки
   * стартуют фоновые шаги, которые стали готовы.
   */
  private async advance(runId: string, signal: AbortSignal): Promise<void> {
    this.setRunStatus(runId, 'running');
    for (;;) {
      if (signal.aborted) {
        this.setRunStatus(runId, 'paused');
        return;
      }
      const run = this.mustRun(runId);
      this.launchBackground(run);
      const selected = this.d.store.getSteps(runId).filter((s) => s.selected && !this.isBackground(s.stepId));
      const next = selected.find((s) => s.status === 'pending' || s.status === 'waiting_owner');
      const stuck = selected.find((s) => STOPS[s.status] !== undefined);
      if (stuck && (!next || stuck.position < next.position)) {
        this.setRunStatus(runId, STOPS[stuck.status]!);
        return;
      }
      if (!next) {
        this.setRunStatus(runId, 'completed');
        return;
      }
      const outcome = await this.execute(run, next, signal);
      if (outcome !== 'next') return;
    }
  }

  /**
   * Запускает готовые фоновые шаги: отмеченный шаг в ожидании стартует, когда закончены все отмеченные шаги цепочки
   * выше него и в контексте есть его requires. Упавший и отклоненный (заблокированный) шаг сами не стартуют, а шаг,
   * чье подтверждение сгорело при смене параметров, снова в ожидании и стартует заново.
   */
  private launchBackground(run: RunRow): void {
    const steps = this.d.store.getSteps(run.id).filter((s) => s.selected);
    const context = this.d.store.getContext(run.id);
    for (const s of steps) {
      if (!this.isBackground(s.stepId) || s.status !== 'pending' || this.backgrounds.get(run.id)?.has(s.stepId)) continue;
      const ahead = steps.filter((c) => !this.isBackground(c.stepId) && c.position < s.position);
      if (!ahead.every((c) => DONE.has(c.status))) continue;
      if ((this.d.catalog.entry(s.stepId)?.manifest.requires ?? []).some((key) => context[key] === undefined)) continue;
      void this.runBackground(run.id, s.stepId);
    }
  }

  /**
   * Выполняет фоновый шаг рядом с цепочкой: тот же путь, что у шага цепочки (done, prepare, подтверждение, run), с
   * общим сигналом остановки прогона. Когда шаг закончился, статус прогона пересчитывается, а при простаивающей
   * цепочке стартуют следующие готовые фоновые шаги.
   */
  private runBackground(runId: string, stepId: string): Promise<void> {
    const own = this.backgrounds.get(runId) ?? new Map<string, Promise<void>>();
    const current = own.get(stepId);
    if (current) return current;
    const { signal } = this.controllerOf(runId);
    const p = this.execute(this.mustRun(runId), this.mustStep(runId, stepId), signal, true)
      .then(() => undefined)
      .catch((e: unknown) => {
        this.d.bus.emitEvent({ runId, stepId, type: 'engine.error', message: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        own.delete(stepId);
        if (!own.size) this.backgrounds.delete(runId);
        this.releaseController(runId);
        if (signal.aborted) {
          this.setRunStatus(runId, 'paused');
          return;
        }
        if (!this.active.has(runId)) this.launchBackground(this.mustRun(runId));
        this.setRunStatus(runId, this.chainStatus(runId, true));
      });
    own.set(stepId, p);
    this.backgrounds.set(runId, own);
    return p;
  }

  private async execute(run: RunRow, step: RunStepRow, signal: AbortSignal, background = false): Promise<Outcome> {
    // Статус прогона ставит цепочка; фоновый шаг меняет только свой, а прогон пересчитывается, когда он закончился.
    const setRun = (status: RunStatus) => {
      if (!background) this.setRunStatus(run.id, status);
    };
    const entry = this.d.catalog.entry(step.stepId);
    if (!entry?.implemented || !entry.module) {
      this.setStep(run.id, step.stepId, 'blocked', { note: 'Шаг еще не реализован' });
      setRun('paused');
      return 'stop';
    }
    const { manifest, module } = entry;
    // Замечание к повтору нужно одной попытке: агенты этой попытки получат его, а следующая начнется без него.
    const retryNote = step.retryNote;
    if (retryNote) this.d.store.updateStep(run.id, step.stepId, { retryNote: null });
    // Шаг, который ждал события, запущен снова: наблюдатель увидел событие, или владелец проверяет сейчас.
    const waited = this.waitingOf(run.id, step.stepId);
    if (waited) this.d.store.deleteContext(run.id, 'waiting');
    const context = this.d.store.getContext(run.id);
    const missing = manifest.requires.filter((key) => context[key] === undefined);
    if (missing.length) {
      this.setStep(run.id, step.stepId, 'blocked', { note: `Не хватает данных: ${missing.map((k) => this.providerHint(k)).join(', ')}` });
      setRun('paused');
      return 'stop';
    }
    // Откуда шаг бросит ожидание: из run подтвержденное действие уже идет, и шаг с resume потом продолжит его.
    let from: Waiting['from'];
    try {
      const c = this.makeContext(run, manifest, context, this.d.store.getDraft(run.id, step.stepId), signal, { waited: waited?.event ?? null, background, retryNote });
      const finish = async (outputs: Record<string, unknown>): Promise<Outcome> => {
        this.saveOutputs(run.id, step.stepId, outputs);
        this.setStep(run.id, step.stepId, 'succeeded', { finished: true });
        if (manifest.loop && (module.again ? await module.again(c, outputs) : true)) this.restartLoop(run.id, step.stepId, manifest.loop);
        return 'next';
      };
      if (waited?.from === 'run' && module.resume) {
        // Подтвержденное действие шага уже идет: он продолжает с того места, где ждал, без done и подтверждения.
        from = 'run';
        this.setStep(run.id, step.stepId, 'running');
        return await finish(await module.resume(c, waited.event));
      }
      if (module.done) {
        const done = await module.done(c);
        if (done) {
          // Шаг сделан без подтверждения: прежние запросы по нему больше не нужны.
          this.burnApprovals(run.id, step.stepId);
          this.saveOutputs(run.id, step.stepId, done.outputs);
          this.setStep(run.id, step.stepId, 'already', { note: done.note });
          return 'next';
        }
      }
      if (run.dryRun && manifest.sideEffects) {
        // Черновик готовит агент, а в пробном прогоне он не запускается: план показывается, только если черновик уже есть.
        if (module.preview && (!module.prepare || c.draft !== undefined)) {
          const p = await module.preview(c);
          const plan = p.actions.length ? `: ${p.actions.join('; ')}` : ', действий нет';
          c.log(`Пробный прогон, план "${p.title}"${plan}`, { actions: p.actions });
        }
        this.burnApprovals(run.id, step.stepId);
        this.saveOutputs(run.id, step.stepId, module.simulate ? await module.simulate(c) : undefined);
        this.setStep(run.id, step.stepId, 'simulated', { note: 'Пробный прогон: внешние действия не выполнялись' });
        return 'next';
      }
      if (manifest.loop) {
        const round = this.loopRounds(run.id)[step.stepId] ?? 0;
        if (round >= manifest.loop.max) throw new Error(`Петля исчерпана: кругов ${round} из ${manifest.loop.max}, дальше решает владелец`);
      }
      if (module.prepare && (c.draft === undefined || step.feedback)) {
        this.setStep(run.id, step.stepId, 'running', { started: true, note: step.feedback ? `Переделывает по замечанию: ${step.feedback}` : 'Готовит черновик' });
        c.feedback = step.feedback;
        const draft = (await module.prepare(c)) ?? null;
        c.feedback = null;
        this.d.store.setDraft(run.id, step.stepId, draft);
        this.d.store.updateStep(run.id, step.stepId, { feedback: null });
        c.draft = draft;
      }
      if (manifest.gate !== 'none') {
        if (!module.preview) throw new Error('Шагу с подтверждением нужен preview');
        const preview = this.checkTexts(await module.preview(c));
        const needed = manifest.gate === 'publish' || preview.requiresApproval !== false;
        if (needed && !this.consumeApproval(run.id, step.stepId, preview)) {
          this.setStep(run.id, step.stepId, 'waiting_owner', { note: `Ждет подтверждения: ${preview.title}` });
          setRun('waiting_owner');
          return 'wait';
        }
        if (!needed) this.burnApprovals(run.id, step.stepId);
      }
      from = 'run';
      this.setStep(run.id, step.stepId, 'running', { started: true });
      return await finish(await module.run(c));
    } catch (e) {
      if (signal.aborted) {
        this.setStep(run.id, step.stepId, 'failed', { error: signal.reason === SHUTDOWN ? RESTARTED : STOPPED, finished: true });
        setRun('paused');
        return 'stop';
      }
      if (isStepWaiting(e) && background) {
        // Ожидание события держит цепочку, а фоновый шаг ее не держит: такой шаг должен стоять в цепочке.
        this.setStep(run.id, step.stepId, 'failed', { error: `Фоновый шаг не ждет внешних событий: ${e.message}. Сделайте его шагом цепочки`, finished: true });
        return 'stop';
      }
      if (isStepWaiting(e)) {
        // Не сбой: шаг ждет события, наблюдатель продолжит прогон, когда оно случится. Что шаг успел сделать, сохраняется,
        // если это по контракту: иначе шаг падает, как при выходе не по контракту из run.
        try {
          this.saveOutputs(run.id, step.stepId, e.outputs);
        } catch (bad) {
          this.setStep(run.id, step.stepId, 'failed', { error: bad instanceof Error ? bad.message : String(bad), finished: true });
          setRun('failed');
          return 'stop';
        }
        const waiting: Waiting = { stepId: step.stepId, event: e.event, since: new Date().toISOString(), ...(from ? { from } : {}) };
        this.d.store.setContext(run.id, 'waiting', waiting, step.stepId);
        this.setStep(run.id, step.stepId, 'waiting', { note: e.message });
        this.setRunStatus(run.id, 'waiting');
        return 'stop';
      }
      this.setStep(run.id, step.stepId, 'failed', { error: e instanceof Error ? e.message : String(e), finished: true });
      setRun('failed');
      return 'stop';
    }
  }

  /**
   * Проверяет публикуемые тексты линтером. Шаг обязан сам применить исправления до показа, поэтому
   * текст, который линтер еще исправил бы, блокирует подтверждение так же, как запрещенное содержимое.
   * Текст с `stepLinted` шаг проверил сам по своим правилам, и его замечания уже в `lint` превью.
   */
  private checkTexts(preview: Preview): Preview {
    const texts = (preview.texts ?? []).filter((t) => t.publish && !t.stepLinted);
    if (!texts.length) return preview;
    const issues: LintIssue[] = [...(preview.lint ?? [])];
    for (const t of texts) {
      if (!t.text.trim()) {
        issues.push({ rule: 'empty', severity: 'block', message: `${t.label}: пустой текст` });
        continue;
      }
      const r = lintText(t.text, this.d.lint);
      if (r.text !== t.text) {
        issues.push({ rule: 'unlinted', severity: 'block', message: `${t.label}: текст не прошел исправления линтера` });
      }
      for (const i of r.issues) {
        if (i.severity !== 'fixed') issues.push({ ...i, message: `${t.label}: ${i.message}` });
      }
    }
    return { ...preview, lint: issues };
  }

  /**
   * true, если владелец одобрил ровно это содержимое. Одобрение одноразовое: оно расходуется при
   * выполнении и сгорает, если содержимое изменилось после клика. Иначе создается новый запрос.
   */
  private consumeApproval(runId: string, stepId: string, preview: Preview): boolean {
    // Тексты входят в хэш: владелец подтверждает ровно те слова, которые будут опубликованы.
    // Способ показа текста (format) - не содержимое: подтверждение от него не зависит.
    const texts = preview.texts?.map(({ format: _format, ...t }) => t);
    const hash = stableHash(texts?.length ? { payload: preview.payload, texts } : preview.payload);
    const approved = this.d.store.findApproval(runId, stepId, 'approved');
    if (approved) {
      if (approved.payloadHash === hash) {
        this.d.store.updateApproval(approved.id, { status: 'consumed' });
        return true;
      }
      this.d.store.updateApproval(approved.id, { status: 'stale' });
      this.d.bus.emitEvent({ runId, stepId, type: 'approval.stale', message: 'Содержимое изменилось после подтверждения, нужно подтвердить заново' });
    }
    const pending = this.d.store.findApproval(runId, stepId, 'pending');
    if (pending?.payloadHash === hash) return false;
    if (pending) this.d.store.updateApproval(pending.id, { status: 'stale' });
    const created = this.d.store.createApproval({ runId, stepId, payloadHash: hash, preview: this.d.redact.deep(preview) });
    this.d.bus.emitEvent({ runId, stepId, type: 'approval.requested', message: preview.title, data: { approvalId: created.id } });
    return false;
  }

  private makeContext(
    run: RunRow,
    manifest: StepManifest,
    context: Record<string, unknown>,
    draft: unknown,
    signal: AbortSignal,
    { waited, background, retryNote }: { waited: WaitEvent | null; background: boolean; retryNote: string | null },
  ): StepContext {
    const repo = this.d.profiles.repos.find((r) => r.id === run.repoId);
    const own = this.d.agents.forStep({ runId: run.id, stepId: manifest.id, manifest, signal });
    // Фоновый шаг не пишет в рабочую папку ветки: ее в это время меняет цепочка. Замечание к повтору шага дописывается
    // к заданию каждого запуска агента в этой попытке.
    const agent: StepAgent =
      background || retryNote
        ? {
            run: (request) =>
              own.run({ ...request, ...(background ? { writeCwd: false } : {}), ...(retryNote ? { prompt: `${request.prompt}\n\n${retryNote}` } : {}) }),
            lastSession: (label) => own.lastSession(label),
          }
        : own;
    if (!repo) throw new Error(`Профиль репозитория ${run.repoId} не найден`);
    const stand = run.standId ? this.d.profiles.stands.find((s) => s.id === run.standId) : undefined;
    // Настройки шага: выбор прогона поверх умолчания пресета поверх манифеста; "как обычно" в переводе - веха доски.
    const params = effectiveParams(manifest, this.board(), this.presetParams(run, manifest.id), this.d.store.getStep(run.id, manifest.id)?.params ?? {});
    return {
      run: { id: run.id, issueKey: run.issueKey, dryRun: run.dryRun },
      params,
      get: <T>(key: string) => context[key] as T | undefined,
      repo,
      contour: this.d.profiles.contours.find((c) => c.id === repo.contour),
      stand,
      deployRepo: repo.deployRepo ? this.d.profiles.repos.find((r) => r.id === repo.deployRepo) : undefined,
      team: this.d.team ?? NO_TEAM,
      texts: this.d.texts?.() ?? { rules: '', style: NO_STYLE },
      jira: this.board(),
      ports: this.d.ports,
      agent,
      paths: {
        docs: resolve(repo.path, fillKey(repo.docsDir, run.issueKey)),
        artifacts: resolve(repo.path, fillKey(repo.artifactsDir, run.issueKey)),
        run: resolve(this.d.dataDir, 'runs', run.id),
        // Копия доков для агента: у фонового шага своя, он идет одновременно с шагом цепочки и другими фоновыми шагами.
        agentDocs: resolve(repo.worktreesDir, '.task-pilot', `${repo.id}-${run.issueKey}`, background ? `docs-${manifest.id}` : 'docs'),
      },
      draft,
      feedback: null,
      lint: (text) => lintText(text, this.d.lint),
      linked: () => this.linkedRuns(run),
      standById: (id) => this.d.profiles.stands.find((s) => s.id === id),
      waited,
      signal,
      scratch: new Map(),
      log: (message, data) => this.d.bus.emitEvent({ runId: run.id, stepId: manifest.id, type: 'step.log', message, data }),
    };
  }

  /** Связанные прогоны прогона: самый новый прогон его задачи в каждом другом репозитории. */
  linkedRunsOf(runId: string): LinkedRun[] {
    return this.linkedRuns(this.mustRun(runId));
  }

  /** Самый новый прогон задачи в каждом другом репозитории: его шаги и контекст для связанных шагов. */
  private linkedRuns(run: RunRow): LinkedRun[] {
    const newest = new Map<string, RunRow>();
    // Прогоны задачи идут новыми первыми: первый встреченный по репозиторию - самый новый.
    for (const r of this.d.store.runsOfIssue(run.issueKey)) if (r.repoId !== run.repoId && !newest.has(r.repoId)) newest.set(r.repoId, r);
    return [...newest.values()].flatMap((r): LinkedRun[] => {
      const repo = this.d.profiles.repos.find((p) => p.id === r.repoId);
      if (!repo) return [];
      const context = this.d.store.getContext(r.id);
      return [
        {
          runId: r.id,
          repo,
          status: r.status,
          steps: this.d.store.getSteps(r.id).map((s) => ({ id: s.stepId, selected: s.selected, status: s.status })),
          get: <T>(key: string) => context[key] as T | undefined,
        },
      ];
    });
  }

  /**
   * Пишет выходы шага в контекст. До записи каждый ключ проверяется контрактом (`CONTEXT_SCHEMAS` step-kit или
   * `contracts` модуля шага): нарушение бросает ошибку, и шаг падает, не изменив контекст ни одним ключом. Ключ без
   * контракта записывается как есть, и лента говорит об этом.
   */
  private saveOutputs(runId: string, stepId: string, outputs: Record<string, unknown> | undefined): void {
    if (!outputs) return;
    const { issues, unknown } = checkOutputs(outputs, this.d.catalog.entry(stepId)?.module?.contracts);
    if (issues.length) throw new Error(issues.map((i) => `Шаг вернул ${i.key} не по контракту: ${i.message}`).join('; '));
    for (const key of unknown) this.d.bus.emitEvent({ runId, stepId, type: 'step.log', message: `Выход ${key} без контракта: записан без проверки`, data: { key } });
    for (const [key, value] of Object.entries(outputs)) {
      if (value !== undefined) this.d.store.setContext(runId, key, this.d.redact.deep(value), stepId);
    }
  }

  private setStep(
    runId: string,
    stepId: string,
    status: StepStatus,
    extra: { note?: string; error?: string; started?: boolean; finished?: boolean } = {},
  ): void {
    const ts = new Date().toISOString();
    const note = extra.note ? this.d.redact.text(extra.note) : null;
    const error = extra.error ? this.d.redact.text(extra.error) : null;
    this.d.store.updateStep(runId, stepId, {
      status,
      note,
      error,
      ...(extra.started ? { startedAt: ts, finishedAt: null } : {}),
      ...(extra.finished ? { finishedAt: ts } : {}),
    });
    const detail = error ?? note;
    // Закончившийся шаг говорит интерфейсу, что еще устарело после него: что выкачено на стендах, галерея артефактов.
    const refresh = extra.finished ? (this.d.catalog.entry(stepId)?.manifest.refresh ?? []) : [];
    this.d.bus.emitEvent({
      runId,
      stepId,
      type: 'step.status',
      message: `${this.title(stepId)}: ${STEP_STATUS_TEXT[status]}${detail ? `. ${detail}` : ''}`,
      data: { status, ...(error ? { error } : {}), ...(refresh.length ? { refresh } : {}) },
    });
  }

  /** Ставит прогону статус цепочки status с поправкой на его фоновые шаги (`withBackground`). */
  private setRunStatus(runId: string, chain: RunStatus): void {
    const run = this.d.store.getRun(runId);
    if (!run) return;
    const status = this.withBackground(runId, chain);
    if (run.status === status) return;
    this.d.store.updateRun(runId, { status });
    this.d.bus.emitEvent({ runId, type: 'run.status', message: `Прогон ${RUN_STATUS_TEXT[status]}`, data: { status } });
  }

  /**
   * Стенд по умолчанию для репозитория: первый стенд его контура по правилу defaultStand контура, иначе первый стенд
   * контура, на который деплоится этот репозиторий. У контура без стендов прогон идет без стенда.
   */
  private defaultStand(repoId: string): string | null {
    const repo = this.d.profiles.repos.find((r) => r.id === repoId);
    const contour = this.d.profiles.contours.find((c) => c.id === repo?.contour);
    const own = this.d.profiles.stands.filter((s) => s.contour === repo?.contour && s.deployable && standEnvId(s, repoId) !== null);
    return (own.find((s) => defaultStandLike(contour, s.bambooEnv)) ?? own[0])?.id ?? null;
  }

  private providerHint(key: string): string {
    const provider = this.d.catalog.entries().find((e) => e.manifest.provides.includes(key));
    return provider ? `${key} (дает шаг "${provider.manifest.title}")` : key;
  }

  private title(stepId: string): string {
    return this.d.catalog.entry(stepId)?.manifest.title ?? stepId;
  }

  private mustRun(runId: string): RunRow {
    const run = this.d.store.getRun(runId);
    if (!run) throw new EngineError('Прогон не найден', 404);
    return run;
  }

  private mustStep(runId: string, stepId: string): RunStepRow {
    const step = this.d.store.getStep(runId, stepId);
    if (!step) throw new EngineError('Шаг не найден в прогоне', 404);
    return step;
  }

  /** Гасит запросы подтверждения шага, которые больше не нужны. */
  private burnApprovals(runId: string, stepId: string): void {
    if (this.d.store.staleApprovals(runId, stepId)) {
      this.d.bus.emitEvent({ runId, stepId, type: 'approval.stale', message: 'Запрос подтверждения больше не нужен' });
    }
  }

  /** Два прогона одной задачи не выполняются одновременно: они работали бы в одной рабочей папке. */
  private mustBeOnlyActive(runId: string, issueKey: string): void {
    for (const id of new Set([...this.active.keys(), ...this.backgrounds.keys()])) {
      if (id !== runId && this.d.store.getRun(id)?.issueKey === issueKey) throw new EngineError('По задаче уже выполняется другой прогон', 409);
    }
  }

  private mustIdle(runId: string): void {
    this.mustRun(runId);
    if (this.isActive(runId)) throw new EngineError('Прогон выполняется, дождитесь паузы', 409);
  }

  /** Шаг сейчас не выполняется: у шага цепочки не идет цепочка, фоновый шаг не идет сам. */
  private mustStepIdle(runId: string, stepId: string): void {
    this.mustRun(runId);
    const busy = this.isBackground(stepId) ? this.backgrounds.get(runId)?.has(stepId) === true : this.active.has(runId);
    if (busy) throw new EngineError('Прогон выполняется, дождитесь паузы', 409);
  }
}
