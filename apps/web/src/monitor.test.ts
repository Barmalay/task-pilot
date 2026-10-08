import { describe, expect, it } from 'vitest';
import { dashboardSchema } from '@task-pilot/step-kit';
import { attemptHref, attemptIdsIn, breakdownOptions, deltaOf, formatCount, formatRatio, formatSpan, formatTick, niceMax, refreshMs, tickStep, timeTicks, valueTicks } from './monitor.ts';

const HOUR = 3_600_000;

describe('monitor screen helpers', () => {
  it('turns refresh options into milliseconds and off into no polling', () => {
    expect([refreshMs('15s'), refreshMs('30s'), refreshMs('1m'), refreshMs('5m'), refreshMs('off')]).toEqual([15_000, 30_000, 60_000, 300_000, false]);
  });

  it('formats counts with digit groups, large counts compactly and small shares precisely', () => {
    expect(formatCount(1234).replace(/\s/g, ' ')).toBe('1 234');
    expect(formatCount(20760).replace(/\s/g, ' ')).toBe('20,8 тыс.');
    expect(formatCount(null)).toBe('-');
    expect([formatRatio(0), formatRatio(0.0004), formatRatio(0.052), formatRatio(0.25), formatRatio(null)]).toEqual(['0%', '0,04%', '5,2%', '25%', '-']);
  });

  it('describes the change to the previous period and never divides by an empty one', () => {
    expect(deltaOf(120, 100)).toEqual({ direction: 'up', text: '+20% к прошлому периоду' });
    expect(deltaOf(95, 100)).toEqual({ direction: 'down', text: '−5,0% к прошлому периоду' });
    expect(deltaOf(100, 100).direction).toBe('flat');
    expect(deltaOf(5, 0)).toEqual({ direction: 'up', text: 'в прошлом периоде строк не было' });
    expect([formatSpan(45 * 60_000), formatSpan(662 * 60_000)]).toEqual(['45 мин', '11 ч']);
  });

  it('places time ticks on round local moments no closer than the minimum gap', () => {
    expect(tickStep(0, HOUR, 400)).toBe(15 * 60_000);
    expect(tickStep(0, 24 * HOUR, 600)).toBe(4 * HOUR);
    const from = Date.UTC(2026, 8, 23, 10, 7);
    const { ticks, step } = timeTicks(from, from + HOUR, 400);
    expect(step).toBe(15 * 60_000);
    expect(ticks.every((t) => new Date(t).getMinutes() % 15 === 0)).toBe(true);
    expect(ticks[0]! >= from && ticks.at(-1)! <= from + HOUR).toBe(true);
    expect(formatTick(Date.UTC(2026, 8, 23), 24 * HOUR)).toMatch(/^\d{2}\.\d{2}$/);
  });

  it('rounds the value axis up to a clean number, a share axis never above 100%', () => {
    expect([niceMax(0), niceMax(7), niceMax(23), niceMax(2376), niceMax(0.052)]).toEqual([1, 10, 25, 2500, 0.1]);
    expect(valueTicks(0.9, 'ratio')).toEqual([0, 0.5, 1]);
    expect(valueTicks(0.052, 'ratio')).toEqual([0, 0.05, 0.1]);
    expect(valueTicks(0, 'ratio')).toEqual([0, 0.005, 0.01]);
    expect([valueTicks(23, 'count'), valueTicks(180, 'count'), valueTicks(0, 'count')]).toEqual([[0, 25], [0, 100, 200], [0, 1]]);
  });

  it('finds attempt ids in a line and offers breakdowns by service fields and by the words the panel extracts', () => {
    expect(attemptIdsIn("Проверка антифрода RBA для state = i27JCOsA3FS93OelYtPJPp7Z7rm0DsvV: status = success, correlation id '4d2d8bcc-ab2c-4890-bad3-dbeedb430adb'")).toEqual([
      'i27JCOsA3FS93OelYtPJPp7Z7rm0DsvV',
      '4d2d8bcc-ab2c-4890-bad3-dbeedb430adb',
    ]);
    expect(attemptIdsIn('state=short')).toEqual([]);
    const d = dashboardSchema.parse({
      id: 'rba',
      title: 'RBA',
      task: 'TEAM-2609',
      service: 'keycloak',
      panels: [
        { id: 'channel', title: 'Каналы', type: 'top', by: { extract: 'channel = ' } },
        { id: 'score', title: 'Score', type: 'numbers', extract: 'score = ' },
      ],
    });
    expect(breakdownOptions(d.panels[0]!).map((o) => o.value)).toEqual(['level', 'logger', 'version', 'pod', 'extract:channel = ']);
    expect(breakdownOptions(d.panels[1]!).at(-1)).toEqual({ value: 'extract:score = ', label: '"score ="' });
    expect(attemptHref('abc def', 5)).toBe('#/monitor/attempt/abc%20def/5');
  });
});
