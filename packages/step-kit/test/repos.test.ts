import { describe, expect, it } from 'vitest';
import type { Contour, RepoProfile } from '../src/profiles.ts';
import { pickRepo, sideOf, whyNoRepo } from '../src/repos.ts';

function repo(id: string, contour: string, components: string[], extra: Partial<RepoProfile> = {}): RepoProfile {
  return {
    id,
    title: id,
    contour,
    default: false,
    match: { components, labels: [] },
    path: `/repos/${id}`,
    remote: 'origin',
    baseBranch: 'master',
    branchPattern: 'feature/{KEY}',
    worktreesDir: '/wt',
    commitPaths: [],
    docsDir: '.claude/{KEY}',
    artifactsDir: '.claude/artifacts/{KEY}',
    ...extra,
  };
}

const contours: Contour[] = [
  { id: 'cloud', title: 's', git: 'https://git.example.org', bamboo: 'https://bamboo.example.org', mcp: {}, connected: true, forbiddenBambooEnvIds: [] },
  { id: 'core', title: 'b', git: 'https://git2.example.org', bamboo: 'https://bamboo2.example.org', mcp: {}, connected: false, forbiddenBambooEnvIds: [] },
];

const repos = [
  repo('gate', 'cloud', ['keycloak'], { bitbucket: { project: 'CLOUD', repo: 'gate', reviewers: [] } }),
  repo('api', 'core', ['api']),
  repo('web-front', 'core', [], { match: { components: [], labels: ['repo:WEB/web-front'] } }),
];

describe('pickRepo', () => {
  it('picks the repository by component', () => {
    expect(pickRepo({ labels: ['backend'], components: ['keycloak'] }, repos, contours)).toEqual({
      repoId: 'gate',
      reason: 'по компоненту keycloak',
      candidates: ['gate'],
    });
  });

  it('prefers the repo label over components', () => {
    const choice = pickRepo({ labels: ['repo:WEB/web-front'], components: ['keycloak'] }, repos, contours);
    expect(choice).toMatchObject({ repoId: 'web-front', reason: 'по метке repo:WEB/web-front' });
  });

  it('matches a repo label by the Bitbucket repository name', () => {
    expect(pickRepo({ labels: ['repo:CLOUD/gate'], components: [] }, repos, contours)?.repoId).toBe('gate');
  });

  it('prefers the repository that lists the label in its profile over one matched only by its Bitbucket name', () => {
    const deployRepos = [
      repo('k8s-ansible-core', 'core', [], { bitbucket: { project: 'DEVOPS', repo: 'k8s-ansible', reviewers: [] } }),
      repo('k8s-ansible-cloud', 'cloud', [], { match: { components: [], labels: ['repo:DEVOPS/k8s-ansible'] }, bitbucket: { project: 'DEVOPS', repo: 'k8s-ansible', reviewers: [] } }),
    ];
    const both = contours.map((c) => ({ ...c, connected: true }));
    expect(pickRepo({ labels: ['repo:DEVOPS/k8s-ansible'], components: [] }, deployRepos, both)).toEqual({
      repoId: 'k8s-ansible-cloud',
      reason: 'по метке repo:DEVOPS/k8s-ansible',
      candidates: ['k8s-ansible-cloud', 'k8s-ansible-core'],
    });
  });

  it('prefers a repository of a connected contour when several components match', () => {
    const choice = pickRepo({ labels: [], components: ['api', 'keycloak'] }, repos, contours);
    expect(choice).toEqual({ repoId: 'gate', reason: 'по компоненту keycloak', candidates: ['api', 'gate'] });
  });

  it('still picks the right repository when its contour is not connected yet', () => {
    expect(pickRepo({ labels: [], components: ['api'] }, repos, contours)?.repoId).toBe('api');
  });

  it('returns null when the issue gives no hint', () => {
    expect(pickRepo({ labels: ['backend'], components: ['Личный кабинет'] }, repos, contours)).toBeNull();
  });
});

describe('side of the issue', () => {
  it('comes from the frontend or backend label, and without one or with both from the [Front] or [Back] prefix of the summary', () => {
    expect(sideOf({ labels: ['ai_created', 'frontend'], components: [] })).toEqual({ side: 'frontend', why: 'метке frontend' });
    expect(sideOf({ labels: ['Backend'], components: [], summary: '[Front] x' })).toEqual({ side: 'backend', why: 'метке Backend' });
    expect(sideOf({ labels: [], components: [], summary: '[Back] [Java] Keycloak: выдача SSO-токена' })).toEqual({ side: 'backend', why: 'префиксу [Back] в названии' });
    expect(sideOf({ labels: ['frontend', 'backend'], components: [], summary: ' [Frontend] Попап' })).toEqual({ side: 'frontend', why: 'префиксу [Frontend] в названии' });
    expect(sideOf({ labels: ['ai_created'], components: [], summary: 'Перенос стилей на vanilla extract' })).toBeNull();
  });
});

describe('pickRepo by the side of the issue', () => {
  const keycloak = [
    repo('gate', 'cloud', ['keycloak'], { default: true, match: { components: ['keycloak'], labels: [], side: 'backend' } }),
    repo('gate-theme', 'cloud', ['keycloak'], { match: { components: ['keycloak'], labels: [], side: 'frontend' } }),
    repo('adapter', 'cloud', ['adapter']),
  ];

  it('sends a frontend task of a component to the frontend repository and a backend one to the backend repository', () => {
    expect(pickRepo({ labels: ['ai_created', 'frontend'], components: ['keycloak'] }, keycloak, contours)).toEqual({
      repoId: 'gate-theme',
      reason: 'по компоненту keycloak и метке frontend',
      candidates: ['gate-theme'],
    });
    expect(pickRepo({ labels: ['backend'], components: ['keycloak'] }, keycloak, contours)).toEqual({
      repoId: 'gate',
      reason: 'по компоненту keycloak и метке backend',
      candidates: ['gate'],
    });
  });

  it('uses the [Front] or [Back] prefix when the issue has no side label', () => {
    expect(pickRepo({ labels: [], components: ['keycloak'], summary: '[Front] Форма QR отправляет завершение дважды' }, keycloak, contours)).toMatchObject({
      repoId: 'gate-theme',
      reason: 'по компоненту keycloak и префиксу [Front] в названии',
    });
  });

  it('takes the default repository of the component without a side and names the other one', () => {
    expect(pickRepo({ labels: ['ai_created'], components: ['keycloak'], summary: 'Партнер ID: stateId теряется' }, keycloak, contours)).toEqual({
      repoId: 'gate',
      reason: 'по компоненту keycloak',
      candidates: ['gate', 'gate-theme'],
    });
  });

  it('keeps a repository without a side for a task of any side and does not give a task the repository of the other side', () => {
    expect(pickRepo({ labels: ['frontend'], components: ['adapter'] }, keycloak, contours)?.repoId).toBe('adapter');
    const backendOnly = keycloak.filter((r) => r.id !== 'gate-theme');
    expect(pickRepo({ labels: ['frontend'], components: ['keycloak'] }, backendOnly, contours)).toBeNull();
  });

  it('explains why no repository fits', () => {
    const backendOnly = keycloak.filter((r) => r.id !== 'gate-theme');
    expect(whyNoRepo({ labels: [], components: [] }, keycloak)).toBe('у задачи нет компонентов и метки repo:');
    expect(whyNoRepo({ labels: ['frontend'], components: ['web-front', 'ui-core'] }, keycloak)).toBe('у компонента web-front, ui-core нет профиля репозитория');
    expect(whyNoRepo({ labels: ['frontend'], components: ['keycloak'] }, backendOnly)).toBe('у компонента keycloak нет репозитория стороны frontend (по метке frontend)');
  });
});
