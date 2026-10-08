import type { KibanaTarget, LogSource } from '@task-pilot/step-kit';
import { k8sFieldsOf } from '@task-pilot/step-kit';
import type { Profiles } from '../config.ts';

/**
 * Откуда выгружать логи сервиса для теста на стенде: контейнер сервиса в namespace стенда прогона, индекс и поля из
 * источника логов этого стенда. Сервис должен быть репозиторием контура стенда: логи чужого контура на этом стенде не
 * ищутся. Ошибка объясняет, почему логов не выгрузить.
 */
export function serviceLogTarget(profiles: Profiles, standId: string | null, service: string): KibanaTarget {
  const repo = profiles.repos.find((r) => r.id === service);
  if (!repo) throw new Error(`Сервиса ${service} нет в профилях репозиториев`);
  const stand = standId ? profiles.stands.find((s) => s.id === standId) : undefined;
  if (!stand) throw new Error('У прогона не выбран стенд: логи сервиса ищутся на стенде прогона');
  if (stand.contour !== repo.contour) throw new Error(`Сервис ${service} из контура ${repo.contour}, а стенд ${stand.title} - из ${stand.contour}: его логов на этом стенде нет`);
  const source = profiles.logs[stand.logs];
  if (!source) throw new Error(`Источника логов ${stand.logs} стенда ${stand.title} нет в logs.yaml слоев`);
  return targetOf(source, repo.id, stand.namespace);
}

/** Выгрузка контейнера из источника: индекс и поля записи источника, поля без имени - как у Keycloak и filebeat. */
function targetOf(source: LogSource, container: string, namespace: string): KibanaTarget {
  const k8s = k8sFieldsOf(source);
  return {
    index: source.index,
    container,
    namespace,
    messageField: source.messageField ?? 'message',
    loggerField: source.loggerField ?? 'loggerName',
    containerField: k8s.container,
    namespaceField: k8s.namespace,
    timeField: k8s.time,
  };
}

/** Логи теста на стенде по умолчанию из team.yaml: источник логов стендов и контейнер. */
export interface QaLogs {
  source: string;
  container: string;
}

/**
 * Логи для теста на стенде, когда агент не называет сервис: контейнер из qa.logs team.yaml во всех namespace его
 * источника. Без этой настройки таких логов у команды нет, и агенту нужно назвать сервис.
 */
export function defaultLogTarget(profiles: Profiles, qaLogs: QaLogs | null | undefined): KibanaTarget {
  if (!qaLogs) throw new Error('Назовите service: логи по умолчанию для теста на стенде не заданы (qa.logs в team.yaml пакета команды)');
  const source = profiles.logs[qaLogs.source];
  if (!source) throw new Error(`Источника логов ${qaLogs.source} из qa.logs team.yaml нет в logs.yaml слоев`);
  return targetOf(source, qaLogs.container, '');
}
