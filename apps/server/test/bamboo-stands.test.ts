import type { BambooPort, EnvironmentStatus } from '@task-pilot/step-kit';
import { describe, expect, it } from 'vitest';
import { BambooStands } from '../src/bamboo-stands.ts';
import type { Profiles } from '../src/config.ts';
import { EventBus } from '../src/engine/events.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { Store } from '../src/store/db.ts';
import { PROFILES } from './helpers.ts';

const status = (envId: number, envName: string): EnvironmentStatus => ({ envId, envName, version: null, state: null, lifeCycle: null, resultId: null, startedAt: null, finishedAt: null });

/**
 * Профили тестов с контуром core по правилу и двумя сервисами с проектами деплоя; Bamboo отдает окружения из envs
 * по проекту или падает с ошибкой fail.
 */
function setup(store = new Store(':memory:')) {
  const core = { ...PROFILES.contours[0]!, id: 'core', title: 'core', connected: true, forbiddenBambooEnvIds: [666], stands: { include: '^(Stable|Testing-.+)$', idPrefix: 'core-', logs: 'kibana-k8s', notes: {} } };
  const service = (id: string, project: number) => ({ ...PROFILES.repos[0]!, id, contour: 'core', default: false, bamboo: { plan: `PLAN-${id}`, deploymentProject: project } });
  const own = { ...PROFILES.stands[0]!, id: 'core-stable', contour: 'core', title: 'Stable из файла' };
  const profiles: Profiles = { ...PROFILES, contours: [...PROFILES.contours, core], repos: [...PROFILES.repos, service('mobile', 10), service('api', 20)], stands: [...PROFILES.stands, own] };
  const envs: Record<number, EnvironmentStatus[]> = {
    10: [status(101, 'Stable'), status(102, 'Testing-A-0'), status(666, 'Testing-B-1'), status(103, 'Production')],
    20: [status(201, 'Stable'), status(202, 'Testing-A-0')],
  };
  const state = { fail: null as string | null, calls: 0 };
  const port = {
    async environments(project: number) {
      state.calls++;
      if (state.fail) throw new Error(state.fail);
      return envs[project] ?? [];
    },
  } as unknown as BambooPort;
  const bus = new EventBus(store, createRedactor([]));
  const stands = new BambooStands({ profiles, store, bus, bamboo: () => port, now: () => new Date('2026-09-24T10:00:00Z') });
  const events = () => store.db.prepare("SELECT type, message FROM events WHERE type LIKE 'stands.%' ORDER BY id").all().map((r) => `${r.type}: ${r.message}`);
  return { store, profiles, stands, envs, state, events };
}

const coreIds = (p: Profiles) => p.stands.filter((s) => s.contour === 'core').map((s) => s.id);

describe('stands read from Bamboo', () => {
  it('add the stands of a contour with a rule to the profiles, a stand from a file wins over one with the same id', async () => {
    const t = setup();
    await t.stands.refresh();
    expect(coreIds(t.profiles)).toEqual(['core-stable', 'core-testing-a-0']);
    expect(t.profiles.stands.find((s) => s.id === 'core-stable')?.title).toBe('Stable из файла');
    expect(t.profiles.stands.find((s) => s.id === 'core-testing-a-0')?.bambooEnvIds).toEqual({ mobile: 102, 'api': 202 });
    expect(t.profiles.stands.filter((s) => s.contour === 'cloud')).toEqual(PROFILES.stands);
    expect(t.events()).toEqual(['stands.updated: Стенды core из Bamboo: 2']);
  });

  it('keep the last snapshot in the database, so the stands are there at start when Bamboo does not answer', async () => {
    const t = setup();
    await t.stands.refresh();
    const again = setup(t.store);
    again.state.fail = 'bamboo.example.com не отвечает';
    again.stands.loadSnapshots();
    expect(coreIds(again.profiles)).toEqual(['core-stable', 'core-testing-a-0']);
    await again.stands.refresh();
    await again.stands.refresh();
    expect(coreIds(again.profiles)).toEqual(['core-stable', 'core-testing-a-0']);
    // Одна и та же ошибка пишется в ленту один раз.
    expect(again.events().filter((e) => e.startsWith('stands.failed'))).toEqual([
      'stands.failed: Стенды core не прочитаны из Bamboo: bamboo.example.com не отвечает; остались снятые 2026-09-24T10:00:00.000Z',
    ]);
  });

  it('say what changed when Bamboo gets a new environment and stay quiet when nothing changed', async () => {
    const t = setup();
    await t.stands.refresh();
    await t.stands.refresh();
    t.envs[10]!.push(status(104, 'Testing-C-2'));
    await t.stands.refresh();
    expect(coreIds(t.profiles)).toEqual(['core-stable', 'core-testing-a-0', 'core-testing-c-2']);
    expect(t.events()).toEqual(['stands.updated: Стенды core из Bamboo: 2', 'stands.updated: Стенды core из Bamboo: 3, новых 1, убрано 0']);
  });

  it('keep the previous stands when Bamboo gives no environment that the rule allows', async () => {
    const t = setup();
    await t.stands.refresh();
    t.envs[10] = [status(103, 'Production')];
    t.envs[20] = [];
    await t.stands.refresh();
    expect(coreIds(t.profiles)).toEqual(['core-stable', 'core-testing-a-0']);
    expect(t.events().at(-1)).toContain('ни одно окружение проектов деплоя не подошло под правило');
  });

  it('do not ask Bamboo for a contour without a rule or that is not connected', async () => {
    const t = setup();
    t.profiles.contours = t.profiles.contours.map((c) => (c.id === 'core' ? { ...c, connected: false } : c));
    await t.stands.refresh();
    expect(t.state.calls).toBe(0);
    expect(coreIds(t.profiles)).toEqual(['core-stable']);
  });
});
