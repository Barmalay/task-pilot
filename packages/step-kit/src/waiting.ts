import type { ScmRepoRef } from './types.ts';

/** Срок ожидания: после at наблюдатель роняет шаг с ошибкой error, той же, что шаг бросал бы сам по таймауту. */
export interface WaitDeadline {
  at: string;
  error: string;
}

/** Ожидание со сроком: с какого времени шаг ждет и до какого. */
export interface Timed {
  /** Когда шаг начал ждать: продолжая ожидание, шаг считает срок от этого времени, а не заново. */
  since: string;
  deadline: WaitDeadline;
}

/** Проверка ответа после выкатки: адрес и чей ответ ждать - самого сервиса стенда или стенда целиком. */
export interface RolloutProbe {
  url: string;
  /** true - отвечает сам сервис стенда (сверяется и заголовок окружения), false - адрес отвечает 200. */
  service: boolean;
}

/**
 * Событие, которого ждет шаг. Поля - в терминах портов: наблюдатель только спрашивает порт "готово или нет", а что
 * делать дальше, решает шаг, когда прогон продолжится. contour, standId и repoId - id из профилей.
 */
export type WaitEvent =
  /** Мерж или отклонение PR; новые замечания в нем наблюдатель сообщает событием pr.review. Срока нет: ревью идет днями. */
  | { kind: 'pr'; scm: ScmRepoRef; pr: number }
  /** Bamboo завел ветку плана сборки для ветки git. */
  | ({ kind: 'plan-branch'; contour: string; plan: string; branch: string } & Timed)
  /** Сборка коммита в ветке плана закончилась или не выполнялась. */
  | ({ kind: 'build'; contour: string; planKey: string; revision: string } & Timed)
  /** Деплой релиза на окружение, который владелец запускает в Bamboo сам (Customize Deploy), начался. */
  | ({ kind: 'manual-deploy'; contour: string; envId: number; versionId: number } & Timed)
  /** Деплой закончился. */
  | ({ kind: 'deploy'; contour: string; resultId: number } & Timed)
  /** Выкатка на стенде: в namespace стенда под с образом сборки (tag), и адрес проверки отвечает. */
  | ({ kind: 'rollout'; standId: string; repoId: string; app: string; tag: string | null; probe: RolloutProbe | null; resultId: number } & Timed)
  /** Связанные прогоны задачи выкатились: их шаг деплоя deployStep прошел с последней сборкой. */
  | ({ kind: 'linked'; deployStep: string } & Timed);

/** Начало и срок ожидания: since плюс ms, с ошибкой, которую получит шаг, если событие к сроку не случится. */
export function timed(since: string, ms: number, error: string): Timed {
  return { since, deadline: { at: new Date(Date.parse(since) + ms).toISOString(), error } };
}

/**
 * Шаг ждет внешнего события, например сборки или мержа PR, которые могут занять часы и дни. Движок ставит шагу и
 * прогону статус waiting с сообщением как заметкой, а наблюдатель Task Pilot сам проверяет событие и продолжает
 * прогон, когда оно случится, или роняет шаг после срока. Если до ожидания шаг уже что-то сделал (опубликовал
 * ответы, создал релиз), outputs - его выходы: движок кладет их в контекст перед ожиданием.
 */
export class StepWaiting extends Error {
  readonly event: WaitEvent;
  readonly outputs: Record<string, unknown> | undefined;

  constructor(message: string, event: WaitEvent, outputs?: Record<string, unknown>) {
    super(message);
    this.name = 'StepWaiting';
    this.event = event;
    this.outputs = outputs;
  }
}

/** Ошибка шага означает ожидание события, а не сбой. Сверка по имени: модуль шага мог загрузиться отдельно. */
export function isStepWaiting(e: unknown): e is StepWaiting {
  return e instanceof Error && e.name === 'StepWaiting' && typeof (e as { event?: unknown }).event === 'object';
}
