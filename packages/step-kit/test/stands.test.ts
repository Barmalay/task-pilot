import { describe, expect, it } from 'vitest';
import type { Contour, StandProfile } from '../src/profiles.ts';
import { contourSchema } from '../src/profiles.ts';
import { deployBlockReason, imageTag, prodLike, releaseInfo, serviceAnswers, serviceCheckUrl, standEnvId, standEnvIds, standHealthUrl, standsFromBamboo } from '../src/stands.ts';

/** Схема тегов и релизов Bamboo контуров учебного слоя. */
const BUILDS = { branchTag: '1.0.{build}-{branch}', masterTag: '1.0.{build}-master', masterRelease: '^release-\\d+$' };

const contour: Contour = {
  id: 'cloud',
  title: 'cloud',
  git: 'https://git.example.org',
  bamboo: 'https://bamboo.example.org',
  mcp: { bamboo: 'bamboo-cloud' },
  connected: true,
  forbiddenBambooEnvIds: [24674389],
  prodLike: 'reserve|staging',
};

const stand: StandProfile = {
  id: 'testing-5',
  title: 'testing-5',
  contour: 'cloud',
  namespace: 'testing-cloud-5',
  bambooEnv: 'Testing-Cloud-5',
  bambooEnvId: 30474300,
  logs: 'kibana-cloud',
  deployable: true,
  notes: [],
};

describe('deployBlockReason', () => {
  it('allows a deployable test stand', () => {
    expect(deployBlockReason(stand, contour)).toBeNull();
  });

  it('blocks a stand switched off in its profile', () => {
    expect(deployBlockReason({ ...stand, deployable: false }, contour)).toContain('выключен');
  });

  it('blocks anything that looks like production even when the profile allows it', () => {
    expect(deployBlockReason({ ...stand, namespace: 'production-cloud' }, contour)).toContain('прод');
    expect(deployBlockReason({ ...stand, bambooEnv: 'Production-Cloud' }, contour)).toContain('прод');
  });

  it('blocks an environment forbidden in the contour', () => {
    expect(deployBlockReason({ ...stand, bambooEnvId: 24674389 }, contour)).toContain('запрещено');
  });

  it('blocks a stand without a known contour', () => {
    expect(deployBlockReason(stand, undefined)).toContain('контур');
  });

  it('treats the reserve and staging of production as production by the names of the contour', () => {
    expect(deployBlockReason({ ...stand, bambooEnv: 'Reserve' }, contour)).toContain('прод');
    expect(deployBlockReason({ ...stand, namespace: 'staging' }, contour)).toContain('прод');
    // Без имен контура продом считается только слово prod: оно запрещено всегда, даже без контура.
    const plain = { ...contour, prodLike: undefined };
    expect(deployBlockReason({ ...stand, bambooEnv: 'Reserve' }, plain)).toBeNull();
    expect(deployBlockReason({ ...stand, bambooEnv: 'Prod-Copy' }, undefined)).toContain('прод');
    expect(prodLike(undefined, 'production')).toBe(true);
    expect(prodLike({ prodLike: 'reserve|staging' }, 'Staging-CLOUD')).toBe(true);
  });
});

describe('stand of several deployment projects', () => {
  const core: Contour = { ...contour, id: 'core', forbiddenBambooEnvIds: [531631202] };
  const stable: StandProfile = { ...stand, id: 'core-stable', contour: 'core', namespace: 'stable', bambooEnv: 'Stable', bambooEnvId: undefined, bambooEnvIds: { mobile: 531631205, 'api': 620726237 } };

  it('gives each repository its own environment of the stand and none to a repository without one', () => {
    expect(standEnvId(stable, 'mobile')).toBe(531631205);
    expect(standEnvId(stable, 'api')).toBe(620726237);
    expect(standEnvId(stable, 'adapter')).toBeNull();
    expect(standEnvIds(stable)).toEqual([531631205, 620726237]);
    expect(standEnvId(stand, 'anything')).toBe(30474300);
    expect(standEnvIds(stand)).toEqual([30474300]);
  });

  it('checks the environment of the repository being deployed and refuses a repository without one', () => {
    expect(deployBlockReason(stable, core, 'mobile')).toBeNull();
    expect(deployBlockReason(stable, core, 'adapter')).toBe('У стенда testing-5 нет окружения в проекте деплоя adapter');
  });

  it('blocks the stand for a repository whose environment is forbidden, and the whole stand when any is', () => {
    const risky = { ...stable, bambooEnvIds: { mobile: 531631202, 'api': 620726237 } };
    expect(deployBlockReason(risky, core, 'mobile')).toContain('запрещено');
    expect(deployBlockReason(risky, core, 'api')).toBeNull();
    expect(deployBlockReason(risky, core)).toContain('531631202');
  });
});

describe('image tag of a Bamboo build', () => {
  it('gives a branch build its build number and plan branch number by the scheme of the contour', () => {
    expect(imageTag('BUILDS-SBMKPKEYCLOAKSSO', 'BUILDS-SBMKPKEYCLOAKSSO246-4', BUILDS)).toBe('1.0.4-246');
    expect(imageTag('BUILDS-P', 'BUILDS-P246-4', { branchTag: 'v{build}.b{branch}', masterTag: 'v{build}' })).toBe('v4.b246');
  });

  it('marks a build of the plan itself as master', () => {
    expect(imageTag('BUILDS-SBMKPKEYCLOAKSSO', 'BUILDS-SBMKPKEYCLOAKSSO-273', BUILDS)).toBe('1.0.273-master');
  });

  it('gives null for a build of another plan, a malformed key or a contour without a scheme', () => {
    expect(imageTag('BUILDS-SBMKPKEYCLOAKSSO', 'BUILDS-OTHER12-3', BUILDS)).toBeNull();
    expect(imageTag('BUILDS-SBMKPKEYCLOAKSSO', 'BUILDS-SBMKPKEYCLOAKSSOX-3', BUILDS)).toBeNull();
    expect(imageTag('BUILDS-SBMKPKEYCLOAKSSO', 'no-number', BUILDS)).toBeNull();
    expect(imageTag('BUILDS-SBMKPKEYCLOAKSSO', 'BUILDS-SBMKPKEYCLOAKSSO-273', undefined)).toBeNull();
  });
});

describe('release name', () => {
  it('reads a master release by the name the contour gives it', () => {
    expect(releaseInfo('release-273', BUILDS)).toEqual({ branch: 'master', task: null });
    expect(releaseInfo('release-273')).toEqual({ branch: 'release', task: null });
  });

  it('reads the branch and the task of a branch release, including a branch with a suffix', () => {
    expect(releaseInfo('feature-TEAM-2799-4')).toEqual({ branch: 'feature-TEAM-2799', task: 'TEAM-2799' });
    expect(releaseInfo('feature-TEAM-2827-over-2700-1')).toEqual({ branch: 'feature-TEAM-2827-over-2700', task: 'TEAM-2827' });
  });
});

describe('health check of a stand', () => {
  it('builds the address from the url and the health path of the stand, with its realm put in', () => {
    const base = { id: 's', title: 's', contour: 'c', namespace: 'n', bambooEnv: 'E', bambooEnvId: 1, logs: 'k', deployable: true, notes: [] };
    const wellKnown = '/auth/realms/{realm}/.well-known/openid-configuration';
    expect(standHealthUrl({ ...base, url: 'https://kc-5.example.org/', realm: 'sso-test-realm', health: wellKnown })).toBe('https://kc-5.example.org/auth/realms/sso-test-realm/.well-known/openid-configuration');
    expect(standHealthUrl({ ...base, url: 'https://app.example.org', health: '/health' })).toBe('https://app.example.org/health');
    expect(standHealthUrl({ ...base, url: 'https://kc-5.example.org', realm: 'sso-test-realm' })).toBeNull();
  });
});

describe('stands from Bamboo', () => {
  const core: Contour = {
    id: 'core',
    title: 'core',
    git: 'https://git.example.org',
    bamboo: 'https://bamboo.example.org',
    mcp: { bamboo: 'bamboo' },
    connected: true,
    forbiddenBambooEnvIds: [900],
    prodLike: 'reserve|staging',
    defaultStand: '^stable',
    stands: { include: '^(Stable|Testing-.+)$', idPrefix: 'core-', logs: 'kibana-k8s', notes: { Stable: ['Общий стенд'] } },
  };
  const env = (envId: number, envName: string) => ({ envId, envName });

  it('puts the stands the contour names by default first, and without the rule orders them by name', () => {
    const envs = { mobile: [env(1, 'Testing-A-0'), env(2, 'Stable')] };
    expect(standsFromBamboo(core, envs).map((s) => s.bambooEnv)).toEqual(['Stable', 'Testing-A-0']);
    expect(standsFromBamboo({ ...core, defaultStand: undefined }, envs).map((s) => s.bambooEnv)).toEqual(['Stable', 'Testing-A-0'].sort());
    expect(standsFromBamboo({ ...core, defaultStand: '^testing' }, envs).map((s) => s.bambooEnv)).toEqual(['Testing-A-0', 'Stable']);
  });

  it('makes a stand of every environment the rule allows, with the environment of each repository on it', () => {
    const stands = standsFromBamboo(core, {
      mobile: [env(1, 'Testing-B-1'), env(2, 'Stable'), env(3, 'Testing-A-0')],
      'proxy': [env(11, 'Stable'), env(12, 'Testing-MEDIA-0')],
    });
    expect(stands.map((s) => s.id)).toEqual(['core-stable', 'core-testing-a-0', 'core-testing-b-1', 'core-testing-media-0']);
    expect(stands[0]).toEqual({
      id: 'core-stable',
      title: 'Stable',
      contour: 'core',
      namespace: 'stable',
      bambooEnv: 'Stable',
      bambooEnvIds: { mobile: 2, 'proxy': 11 },
      logs: 'kibana-k8s',
      deployable: true,
      notes: ['Общий стенд'],
    });
    // Сервис без окружения на стенде туда не деплоится.
    expect(standEnvId(stands[3]!, 'mobile')).toBeNull();
    expect(stands.every((s) => deployBlockReason(s, core) === null)).toBe(true);
  });

  it('never makes a stand of a production-like or forbidden environment, even when the rule allows its name', () => {
    const stands = standsFromBamboo(core, {
      mobile: [env(1, 'Production'), env(2, 'Reserve'), env(3, 'Staging'), env(4, 'Testing-Prod-1'), env(900, 'Testing-C-2'), env(5, 'Load'), env(6, 'Testing-D-3')],
    });
    expect(stands.map((s) => s.bambooEnv)).toEqual(['Testing-D-3']);
    expect(standsFromBamboo({ ...core, stands: { ...core.stands!, include: '.*' } }, { mobile: [env(1, 'Production'), env(2, 'pre-staging')] })).toEqual([]);
  });

  it('gives each stand the address of its services by the rule, with the host of the namespace', () => {
    const rule = { ...core.stands!, serviceUrl: 'https://{service}-{host}.test.example.com', host: { from: '^testing-', to: 'team-' } };
    const [stable, testing] = standsFromBamboo({ ...core, stands: rule }, { mobile: [env(1, 'Stable'), env(2, 'Testing-GAMMA-3')] });
    expect(stable?.serviceUrl).toBe('https://{service}-stable.test.example.com');
    expect(testing?.serviceUrl).toBe('https://{service}-team-gamma-3.test.example.com');
    expect(serviceCheckUrl(testing!, { id: 'mobile', health: '/health/readiness' })).toBe('https://mobile-team-gamma-3.test.example.com/health/readiness');
    expect(serviceCheckUrl(testing!, { id: 'proxy' })).toBe('https://proxy-team-gamma-3.test.example.com/');
    expect(standsFromBamboo(core, { mobile: [env(1, 'Stable')] })[0]?.serviceUrl).toBeUndefined();
  });

  it('counts only an answer from the environment of the stand as the answer of its service', () => {
    const [testing] = standsFromBamboo(core, { mobile: [env(2, 'Testing-A-0')] });
    const health = { health: '/health/readiness' };
    expect(serviceAnswers(testing!, health, { status: 200, environment: 'testing-a-0' })).toBe(true);
    expect(serviceAnswers(testing!, health, { status: 200, environment: 'stable' })).toBe(false);
    expect(serviceAnswers(testing!, health, { status: 503, environment: 'testing-a-0' })).toBe(false);
    expect(serviceAnswers(testing!, {}, { status: 404, environment: 'testing-a-0' })).toBe(true);
    expect(serviceAnswers(testing!, {}, { status: 0, environment: null })).toBe(false);
  });

  it('gives no stands without a rule and refuses two environments that would get one id', () => {
    const { stands: _rule, ...plain } = core;
    expect(standsFromBamboo(plain, { mobile: [env(1, 'Stable')] })).toEqual([]);
    expect(() => standsFromBamboo(core, { mobile: [env(1, 'Testing-A 0'), env(2, 'Testing-A-0')] })).toThrow('один и тот же id стенда core-testing-a-0');
  });

  it('accepts a rule in the contour profile only with a valid regular expression', () => {
    const profile = { ...core, stands: { include: '^(Stable', logs: 'kibana-k8s' } };
    expect(contourSchema.safeParse(profile).success).toBe(false);
    expect(contourSchema.parse({ ...profile, stands: { include: '^Stable$', logs: 'kibana-k8s' } }).stands).toEqual({ include: '^Stable$', idPrefix: '', logs: 'kibana-k8s', notes: {} });
  });
});
