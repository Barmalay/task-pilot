import { describe, expect, it } from 'vitest';
import type { StandProfile } from '@task-pilot/step-kit';
import type { Profiles } from '../src/config.ts';
import { defaultLogTarget, serviceLogTarget } from '../src/qa/logs.ts';
import { PROFILES } from './helpers.ts';

const STABLE: StandProfile = { id: 'core-stable', title: 'Stable', contour: 'core', namespace: 'stable', bambooEnv: 'Stable', bambooEnvIds: { 'api-auth': 1 }, logs: 'kibana-k8s', deployable: true, notes: [] };
const profiles: Profiles = {
  ...PROFILES,
  stands: [...PROFILES.stands, STABLE],
  logs: { ...PROFILES.logs, 'kibana-k8s': { kind: 'kibana', url: 'https://kibana.example.org', index: 'core-k8s-*', imageField: 'img', messageField: 'messagetext', loggerField: 'logger' } },
};

describe('logs of a service for the stand test', () => {
  it('come from the container of the service in the namespace of the stand of the run, with the fields of its log source', () => {
    expect(serviceLogTarget(profiles, 'core-stable', 'api-auth')).toEqual({ index: 'core-k8s-*', container: 'api-auth', namespace: 'stable', messageField: 'messagetext', loggerField: 'logger', containerField: 'kubernetes.container.name', namespaceField: 'kubernetes.namespace.keyword', timeField: '@timestamp' });
  });

  it('take the fields of Keycloak when the log source does not name them', () => {
    const stand = PROFILES.stands[0]!;
    expect(serviceLogTarget(profiles, stand.id, 'demo')).toMatchObject({ container: 'demo', namespace: stand.namespace, messageField: 'message', loggerField: 'loggerName' });
  });

  it('are refused for an unknown service, a run without a stand and a service of another contour than the stand', () => {
    expect(() => serviceLogTarget(profiles, 'core-stable', 'nowhere')).toThrow('Сервиса nowhere нет в профилях репозиториев');
    expect(() => serviceLogTarget(profiles, null, 'api-auth')).toThrow('У прогона не выбран стенд');
    expect(() => serviceLogTarget(profiles, 'core-stable', 'demo')).toThrow('Сервис demo из контура cloud, а стенд Stable - из core: его логов на этом стенде нет');
  });
});

describe('default logs of the stand test', () => {
  it('come from the container the team names in qa.logs of its team.yaml, in every namespace of the log source', () => {
    expect(defaultLogTarget(profiles, { source: 'kibana-k8s', container: 'gate' })).toEqual({ index: 'core-k8s-*', container: 'gate', namespace: '', messageField: 'messagetext', loggerField: 'logger', containerField: 'kubernetes.container.name', namespaceField: 'kubernetes.namespace.keyword', timeField: '@timestamp' });
    // Поля Kubernetes, которые источник назвал сам, идут в выгрузку вместо полей filebeat.
    const own = { ...profiles, logs: { ...profiles.logs, 'kibana-k8s': { ...profiles.logs['kibana-k8s']!, containerField: 'app', namespaceField: 'ns.keyword', timeField: 'ts' } } };
    expect(defaultLogTarget(own, { source: 'kibana-k8s', container: 'gate' })).toMatchObject({ containerField: 'app', namespaceField: 'ns.keyword', timeField: 'ts' });
  });

  it('are refused when the team names none or names a log source no layer has, so the agent has to name the service', () => {
    expect(() => defaultLogTarget(profiles, null)).toThrow('Назовите service: логи по умолчанию для теста на стенде не заданы (qa.logs в team.yaml пакета команды)');
    expect(() => defaultLogTarget(profiles, { source: 'nowhere', container: 'gate' })).toThrow('Источника логов nowhere из qa.logs team.yaml нет в logs.yaml слоев');
  });
});
