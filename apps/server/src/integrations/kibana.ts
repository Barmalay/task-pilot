import type { LogSource, PodImage, StandLogsPort } from '@task-pilot/step-kit';
import { k8sFieldsOf } from '@task-pilot/step-kit';

interface PodBucket {
  key: string;
  first?: { value_as_string?: string };
  last?: { value_as_string?: string };
  img?: { buckets?: { key: string }[] };
}

/**
 * Логи стендов через console proxy Kibana: запрос уходит в Elasticsearch за Kibana без отдельной
 * авторизации (так отвечает тестовая Kibana). Поля namespace, пода и образа
 * агрегируются по .keyword: без него агрегации по текстовым полям пустые. Поле образа у источника свое:
 * у Keycloak `container.image.name`, у других сервисов бывает `kubernetes.container.image`. Поля Kubernetes - источника,
 * без них поля filebeat.
 */
export function createKibanaLogs(source: LogSource, doFetch: typeof fetch = fetch): StandLogsPort {
  const url = source.url.replace(/\/$/, '');
  const k8s = k8sFieldsOf(source);
  return {
    ...(source.dataView ? { dataView: source.dataView } : {}),
    async pods(app, namespaces, sinceMinutes) {
      const path = encodeURIComponent(`${source.index}/_search`);
      const r = await doFetch(`${url}/api/console/proxy?path=${path}&method=POST`, {
        method: 'POST',
        headers: { 'kbn-xsrf': 'true', 'content-type': 'application/json' },
        body: JSON.stringify({
          size: 0,
          query: {
            bool: {
              filter: [
                { match_phrase: { [k8s.container]: app } },
                { terms: { [k8s.namespace]: namespaces } },
                { range: { [k8s.time]: { gte: `now-${sinceMinutes}m` } } },
              ],
            },
          },
          aggs: {
            ns: {
              terms: { field: k8s.namespace, size: namespaces.length || 1 },
              aggs: {
                pods: {
                  terms: { field: k8s.pod, size: 5, order: { first: 'desc' } },
                  aggs: {
                    first: { min: { field: k8s.time } },
                    last: { max: { field: k8s.time } },
                    img: { terms: { field: source.imageField, size: 1 } },
                  },
                },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`Kibana ${url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const json = (await r.json()) as { aggregations?: { ns?: { buckets?: { key: string; pods?: { buckets?: PodBucket[] } }[] } } };
      const result: Record<string, PodImage[]> = {};
      for (const ns of json.aggregations?.ns?.buckets ?? []) {
        result[ns.key] = (ns.pods?.buckets ?? []).flatMap((p): PodImage[] => {
          const image = p.img?.buckets?.[0]?.key;
          return image ? [{ pod: p.key, tag: image.split(':').pop() ?? image, firstSeen: p.first?.value_as_string ?? '', lastSeen: p.last?.value_as_string ?? '' }] : [];
        });
      }
      return result;
    },

    async probe(target, header) {
      try {
        const r = await doFetch(target, { signal: AbortSignal.timeout(10_000) });
        return { status: r.status, environment: header ? r.headers.get(header) : null };
      } catch {
        return { status: 0, environment: null };
      }
    },
  };
}
