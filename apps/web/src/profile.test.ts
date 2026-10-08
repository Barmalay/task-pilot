import { describe, expect, it } from 'vitest';
import type { DoctorCheckDto, RunDto } from '@task-pilot/api-types';
import { doctorSummary, doctorText, exampleKey, initials, recentRuns, styleText, worstLook } from './profile.ts';

const run = (issueKey: string, updatedAt: string): RunDto => ({ id: `${issueKey}-${updatedAt}`, issueKey, repoId: 'r', standId: null, presetId: 'full', dryRun: false, status: 'completed', createdAt: updatedAt, updatedAt });
const check = (id: string, level: DoctorCheckDto['level']): DoctorCheckDto => ({ id, title: id, level, detail: '', fix: null });

describe('profile panel', () => {
  it('tells the personal style of texts in words, or that there is none', () => {
    expect(styleText({ yo: true, dash: true, quotes: true })).toBe('е без точек, дефис вместо длинного тире, прямые кавычки');
    expect(styleText({ yo: false, dash: true, quotes: false })).toBe('дефис вместо длинного тире');
    expect(styleText({ yo: false, dash: false, quotes: false })).toBe('без личного стиля');
  });

  it('shows on the profile button the worst state of the accounts', () => {
    expect(worstLook(['ok', 'warn', 'ok'])).toBe('warn');
    expect(worstLook(['wait', 'fail'])).toBe('fail');
    expect(worstLook(['ok', 'ok'])).toBe('ok');
    expect(worstLook([])).toBe('ok');
  });

  it('takes two letters for the avatar from the login and falls back to the team', () => {
    expect(initials('i.petrov', 'TEAM')).toBe('IP');
    expect(initials('owner', 'TEAM')).toBe('OW');
    expect(initials('', 'Учебная команда')).toBe('УК');
    expect(initials('', '')).toBe('?');
  });

  it('shows the runs changed last, newest first', () => {
    const runs = [run('TEAM-1', '2026-09-30T08:00:00Z'), run('TEAM-2', '2026-09-30T10:00:00Z'), run('TEAM-3', '2026-09-30T09:00:00Z')];
    expect(recentRuns(runs, 2).map((r) => r.issueKey)).toEqual(['TEAM-2', 'TEAM-3']);
  });

  it('suggests a key from the project of the last task run, skipping runs of the step wizard', () => {
    expect(exampleKey([run('PILOT-3', 'x'), run('TEAM-2860', 'y')])).toBe('TEAM-1234');
    expect(exampleKey([])).toBe('KEY-1234');
    expect(exampleKey(undefined)).toBe('KEY-1234');
  });

  it('sums up the environment check with failures first', () => {
    const s = doctorSummary([check('node', 'ok'), check('mcp-versions', 'warn'), check('claude', 'fail')]);
    expect(s).toMatchObject({ fail: 1, warn: 1 });
    expect(s.issues.map((c) => c.id)).toEqual(['claude', 'mcp-versions']);
    expect(doctorText(s)).toBe('Проблем: 1, предупреждений: 1');
    expect(doctorText({ fail: 0, warn: 3 })).toBe('Предупреждений: 3');
    expect(doctorText({ fail: 0, warn: 0 })).toBe('');
  });
});
