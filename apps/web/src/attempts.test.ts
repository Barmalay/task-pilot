import { describe, expect, it } from 'vitest';
import type { AttemptStep } from '@task-pilot/step-kit';
import { clock, formatDuration, idText, idValues, isMainStep, splitIds, visibleSteps } from './attempts.ts';

const step = (over: Partial<AttemptStep>): AttemptStep => ({
  t: 0,
  service: 'keycloak',
  level: 'INFO',
  logger: 'x',
  message: 'строка',
  fields: [],
  event: null,
  error: false,
  ids: [],
  sinceStart: 0,
  sincePrev: 0,
  ...over,
});
const event = (kind: 'step' | 'info' | 'error', label: string) => ({ key: label, kind, label, detail: null, provider: null, outcome: null, milestone: false });

describe('attempt screen', () => {
  it('splits the ids typed in one field by spaces, commas and lines', () => {
    expect(splitIds(' stateA, corr-1;stateA\nacc ')).toEqual(['stateA', 'corr-1', 'acc']);
    expect(splitIds('   ')).toEqual([]);
  });

  it('writes durations for people from milliseconds to hours', () => {
    expect([formatDuration(850), formatDuration(4200), formatDuration(28_400), formatDuration(133_000), formatDuration(3_900_000)]).toEqual(['850 мс', '4,2 с', '28 с', '2 мин 13 с', '1 ч 5 мин']);
  });

  it('shows the main steps by default and every line on request, filtered by service and text', () => {
    const steps = [
      step({ event: event('step', 'Код отправлен') }),
      step({ event: event('info', 'Запрос к сервису'), service: 'mobile' }),
      step({ message: 'NullPointerException', error: true }),
      step({ message: 'служебная строка' }),
    ];
    expect(steps.map(isMainStep)).toEqual([true, false, true, false]);
    expect(visibleSteps(steps, 'main', null, '')).toHaveLength(2);
    expect(visibleSteps(steps, 'all', null, '')).toHaveLength(4);
    expect(visibleSteps(steps, 'all', new Set(['mobile']), '')).toHaveLength(1);
    expect(visibleSteps(steps, 'all', null, 'КОД')).toHaveLength(1);
  });

  it('writes a phone for the screen, takes the values of an id and the time of a line', () => {
    expect([idText('79161234567'), idText('stateAAA111')]).toEqual(['+7 916 123-45-67', 'stateAAA111']);
    expect(idValues({ ids: [{ key: 'phone', label: 'телефон', sensitive: true, scope: 'person', values: ['79161234567'] }] }, 'phone')).toEqual(['79161234567']);
    expect(idValues({ ids: [] }, 'phone')).toEqual([]);
    const t = new Date(2026, 9, 1, 12, 1, 38, 250).getTime();
    expect([clock(t), clock(t, true)]).toEqual(['12:01:38.250', '01.10 12:01:38']);
  });
});
