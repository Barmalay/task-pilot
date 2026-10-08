import { describe, expect, it } from 'vitest';
import type { EventDto, StepDto } from '@task-pilot/api-types';
import { nowLines, STALE_MS, staleQuestion } from './now.ts';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const step = (stepId: string, status: StepDto['status'], over: Partial<StepDto> = {}) => ({ stepId, title: `Шаг ${stepId}`, status, background: false, startedAt: ago(60_000), ...over }) as StepDto;
const ev = (id: number, stepId: string | null, ms: number, message: string | null = `событие ${id}`): EventDto => ({ id, runId: 'r', stepId, ts: ago(ms), type: 'agent.tool', message, data: null });

describe('now line of a run', () => {
  it('shows the last event of every running step, chain steps first, and marks a step silent for too long', () => {
    const steps = [step('wiki.update', 'running', { background: true }), step('qa.stand', 'running'), step('git.prepare', 'succeeded')];
    const events = [ev(1, 'qa.stand', STALE_MS + 120_000, 'Bash: mvn test'), ev(2, 'wiki.update', 30_000, 'Write: wiki.md'), ev(3, null, 1000)];
    const lines = nowLines(steps, events, undefined, NOW);
    expect(lines.map((l) => [l.stepId, l.kind, l.text, l.eventId, l.stale])).toEqual([
      ['qa.stand', 'running', 'Bash: mvn test', 1, true],
      ['wiki.update', 'running', 'Write: wiki.md', 2, false],
    ]);
  });

  it('falls back to the start of a running step without events and tells what a waiting step waits for, never as silent', () => {
    const waiting = { stepId: 'ci.wait', since: ago(STALE_MS * 3), event: { kind: 'build', plan: 'CLOUD', revision: 'abcdef123456' } as never };
    const lines = nowLines([step('code.implement', 'running', { startedAt: ago(5000) }), step('ci.wait', 'waiting')], [], waiting, NOW);
    expect(lines).toEqual([
      { stepId: 'code.implement', title: 'Шаг code.implement', kind: 'running', text: 'шаг начался', at: ago(5000), eventId: null, stale: false },
      { stepId: 'ci.wait', title: 'Шаг ci.wait', kind: 'waiting', text: 'ждет сборки коммита abcdef12', at: ago(STALE_MS * 3), eventId: null, stale: false },
    ]);
    expect(nowLines([step('a', 'pending'), step('b', 'waiting_owner')], [], undefined, NOW)).toEqual([]);
  });

  it('asks the agent about a silent step by its title and silence', () => {
    expect(staleQuestion({ title: 'Тест на стенде', at: ago(25 * 60_000) }, NOW)).toBe('Шаг "Тест на стенде" молчит 25 мин. Что он сейчас делает, не завис ли он и что мне сделать?');
  });
});
