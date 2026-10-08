import type { RunStatus, StepStatus, WaitEvent } from '@task-pilot/step-kit';

/** Подписи статусов шага для журнала и интерфейса. */
export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  pending: 'ожидает',
  running: 'выполняется',
  waiting_owner: 'ждет подтверждения',
  succeeded: 'готово',
  already: 'уже сделано',
  simulated: 'пробный прогон',
  skipped: 'пропущен',
  failed: 'ошибка',
  blocked: 'заблокирован',
  waiting: 'ждет события',
};

/** Подписи статусов прогона для журнала. */
export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  idle: 'не запускался',
  running: 'выполняется',
  waiting_owner: 'ждет подтверждения',
  waiting: 'ждет события',
  paused: 'на паузе',
  completed: 'выполнен',
  failed: 'остановлен из-за ошибки',
};

/** Статусы шагов, которые сбрасываются при повторе и новом круге петли. */
export const RESETTABLE: StepStatus[] = ['failed', 'blocked', 'skipped', 'succeeded', 'already', 'simulated', 'waiting'];

/** Статусы шага, на котором прогон остановился и который владелец может пропустить, чтобы идти дальше. */
export const STUCK: StepStatus[] = ['failed', 'blocked', 'waiting_owner', 'waiting'];

/** Шаги, на которых проход движка останавливается, и статус прогона, который встает на них. */
export const STOPS: Partial<Record<StepStatus, RunStatus>> = { failed: 'failed', blocked: 'paused', waiting: 'waiting' };

/** Статусы шагов, которые ничего не сделали: пока все шаги в них, репозиторий прогона можно сменить. */
export const UNTOUCHED: StepStatus[] = ['pending', 'skipped', 'blocked'];

/** Ошибки шагов, прерванных владельцем или перезапуском: это не сбой шага. */
export const STOPPED = 'Остановлено владельцем';
export const RESTARTED = 'Прервано перезапуском сервера';
/** Причина прерывания, с которой сервер останавливает прогоны при завершении. */
export const SHUTDOWN = 'shutdown';

/**
 * Запись waiting в контексте прогона: какой шаг чего ждет и с какого времени. from - откуда шаг бросил ожидание:
 * run - подтвержденное действие уже идет, и шаг с resume продолжит его; нет - шаг выполнится с начала.
 */
export interface Waiting {
  stepId: string;
  event: WaitEvent;
  since: string;
  from?: 'run';
}
