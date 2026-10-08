import { describe, expect, it } from 'vitest';
import { timed } from '@task-pilot/step-kit';
import { waitWords } from './waiting.ts';

const t = timed('2026-09-25T10:00:00.000Z', 60_000, 'срок');

describe('what a step waits for in words', () => {
  it('names the pull request, the build and the rollout it waits for, after "Жду" and after "Ждет"', () => {
    expect(waitWords({ kind: 'pr', scm: { contour: 'cloud', project: 'CLOUD', repo: 'demo' }, pr: 262 })).toEqual({ what: 'мерж PR #262', of: 'мержа PR #262' });
    expect(waitWords({ kind: 'build', contour: 'cloud', planKey: 'P-1', revision: 'a'.repeat(40), ...t })).toEqual({ what: 'сборку коммита aaaaaaaa', of: 'сборки коммита aaaaaaaa' });
    expect(waitWords({ kind: 'rollout', standId: 'testing-5', repoId: 'demo', app: 'demo', tag: null, probe: null, resultId: 1, ...t }).what).toBe('выкатку на стенде testing-5');
  });

  it('has words for every event a step can wait for', () => {
    const events = [
      { kind: 'plan-branch', contour: 'cloud', plan: 'P', branch: 'feature/TEAM-1', ...t },
      { kind: 'manual-deploy', contour: 'cloud', envId: 1, versionId: 2, ...t },
      { kind: 'deploy', contour: 'cloud', resultId: 1, ...t },
      { kind: 'linked', deployStep: 'deploy.stand', ...t },
    ] as const;
    for (const e of events) expect(waitWords(e).what, e.kind).toMatch(/\S/);
  });
});
