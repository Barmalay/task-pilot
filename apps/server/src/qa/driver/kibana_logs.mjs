// Текстовая выгрузка логов контейнера через console proxy Kibana (нужна открытая вкладка Kibana в CDP Chrome).
// Использование: node kibana_logs.mjs <minutes> [phrase ...]   либо RANGE_GTE=<ISO> RANGE_LTE=<ISO> node kibana_logs.mjs 0 [phrase ...]
// Env: KIBANA_INDEX и KIBANA_CONTAINER обязательны, KIBANA_MESSAGE (message), KIBANA_LOGGER (loggerName), KIBANA_NAMESPACE
// (без него в выгрузку попадут записи того же контейнера со всех стендов), поля Kubernetes KIBANA_CONTAINER_FIELD,
// KIBANA_NAMESPACE_FIELD и KIBANA_TIME_FIELD (без них - поля filebeat), CDP_PORT. Без фраз печатает все записи окна.
// Отбрасывает TRACE, DEBUG, Logbook, ACCESS_LOG и REFRESH_TOKEN: это шум для проверки бизнес-сценариев.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [minutes = '10', ...phrases] = process.argv.slice(2);
const index = process.env.KIBANA_INDEX;
const container = process.env.KIBANA_CONTAINER;
if (!index || !container) { console.error('нужны KIBANA_INDEX и KIBANA_CONTAINER'); process.exit(2); }
const msg = process.env.KIBANA_MESSAGE || 'message';
const lg = process.env.KIBANA_LOGGER || 'loggerName';
const ns = process.env.KIBANA_NAMESPACE || '';
const containerField = process.env.KIBANA_CONTAINER_FIELD || 'kubernetes.container.name';
const namespaceField = process.env.KIBANA_NAMESPACE_FIELD || 'kubernetes.namespace.keyword';
const time = process.env.KIBANA_TIME_FIELD || '@timestamp';
const should = phrases.map(p => ({ match_phrase: { [msg]: p } }));
const range = process.env.RANGE_GTE ? { gte: process.env.RANGE_GTE, lte: process.env.RANGE_LTE } : { gte: `now-${minutes}m` };
const body = { size: 300, sort: [{ [time]: 'desc' }], _source: [time, msg, 'level', lg],
  query: { bool: { filter: [{ match_phrase: { [containerField]: container } }, ...(ns ? [{ match_phrase: { [namespaceField]: ns } }] : []), { range: { [time]: range } }],
    must_not: [{ match_phrase: { [lg]: 'Logbook' } }, { match_phrase: { [msg]: 'ACCESS_LOG' } }, { match_phrase: { level: 'TRACE' } }, { match_phrase: { level: 'DEBUG' } }, { match_phrase: { [msg]: 'REFRESH_TOKEN' } }],
    ...(should.length ? { should, minimum_should_match: 1 } : {}) } } };
const expr = `(async () => { const r = await fetch("/api/console/proxy?path=" + encodeURIComponent(${JSON.stringify(index + '/_search')}) + "&method=POST", {method:"POST", headers:{"kbn-xsrf":"true","Content-Type":"application/json"}, body: ${JSON.stringify(JSON.stringify(body))}}); const j = await r.json(); return j.hits.hits.map(h => { const s = h._source; return String(s[${JSON.stringify(time)}]).slice(11,23) + " " + s.level + " " + ((s[${JSON.stringify(lg)}]||"").split(".").pop()) + " | " + String(s[${JSON.stringify(msg)}]).replace(/\\s+/g," ").slice(0,300); }); })()`;
const out = execFileSync('node', [join(here, 'cdp.mjs'), JSON.stringify([{ useTabUrl: 'kibana' }, { eval: expr }])], { encoding: 'utf8', env: { ...process.env, SHOT_DIR: '/tmp' } });
const line = out.split('\n').find(l => l.startsWith('eval => '));
for (const l of JSON.parse(line.slice(8)).reverse()) console.log(l);
