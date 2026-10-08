import type { StepContext, StepModule, Timed, WaitEvent } from '../../packages/step-kit/src/index.ts';
import { isStepWaiting } from '../../packages/step-kit/src/index.ts';

/** Событие ожидания со сроком: такие бросают шаги сборки, деплоя и теста на стенде. */
export type TimedEvent = Exclude<WaitEvent, { kind: 'pr' }> & Timed;

/** Событие, которого ждет шаг: ошибка, если шаг не ждал, а закончил или упал. */
export async function waitOf(p: Promise<unknown>): Promise<TimedEvent> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  if (!isStepWaiting(e)) throw new Error(`шаг не ждал: ${e instanceof Error ? e.message : 'закончил'}`);
  return e.event as TimedEvent;
}

/**
 * Проводит run шага через ожидания так, как их ведет движок с наблюдателем: каждое брошенное ожидание сразу
 * считается случившимся, и шаг продолжается через resume, а событие лежит в c.waited. Возвращает выходы шага, его
 * ожидания по порядку и логи всех входов.
 */
export async function throughWaits(
  step: StepModule,
  context: (waited: WaitEvent | null) => StepContext & { logs: string[] },
  max = 20,
): Promise<{ outputs: Record<string, unknown>; events: TimedEvent[]; logs: string[] }> {
  const events: TimedEvent[] = [];
  const logs: string[] = [];
  let waited: WaitEvent | null = null;
  for (let i = 0; i < max; i++) {
    const c = context(waited);
    try {
      const outputs = waited ? await step.resume!(c, waited) : await step.run(c);
      logs.push(...c.logs);
      return { outputs, events, logs };
    } catch (e) {
      logs.push(...c.logs);
      if (!isStepWaiting(e)) throw e;
      events.push(e.event as TimedEvent);
      waited = e.event;
    }
  }
  throw new Error(`Шаг ждал больше ${max} раз`);
}
