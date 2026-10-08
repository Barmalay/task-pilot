import { describe, expect, it } from 'vitest';
import type { ProfilesDto } from '@task-pilot/api-types';
import { standsFor } from './stands.ts';

const stand = (id: string, contour: string, repos: string[] | null = null) => ({ id, title: id, contour, url: null, deployable: true, notes: [], repos });

const PROFILES: ProfilesDto = {
  repos: [
    { id: 'gate', title: 'gate', contour: 'cloud', connected: true, default: true },
    { id: 'mobile', title: 'mobile', contour: 'core', connected: true, default: false },
    { id: 'proxy', title: 'proxy', contour: 'core', connected: true, default: false },
  ],
  stands: [stand('stable', 'cloud'), stand('core-stable', 'core', ['mobile', 'proxy']), stand('core-testing-media-0', 'core', ['proxy'])],
  contours: [],
};

describe('stands of a run', () => {
  it('offers only the stands of the contour of the repository', () => {
    expect(standsFor(PROFILES, 'gate').map((s) => s.id)).toEqual(['stable']);
  });

  it('offers a stand of core only to the services that have an environment there', () => {
    expect(standsFor(PROFILES, 'mobile').map((s) => s.id)).toEqual(['core-stable']);
    expect(standsFor(PROFILES, 'proxy').map((s) => s.id)).toEqual(['core-stable', 'core-testing-media-0']);
  });

  it('shows every stand for a repository without a profile', () => {
    expect(standsFor(PROFILES, 'unknown')).toHaveLength(3);
  });
});
