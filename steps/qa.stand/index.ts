import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AcCheck, AcResult, DeployedBuild, Issue, QaReport, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { AC_RESULTS, linkedText, pendingDeploys, renderTemplate, StepWaiting, timed } from '../../packages/step-kit/src/index.ts';
import { agentRules, jiraTools, readText, stageDocs } from '../_shared/agent.ts';
import { acOf, acText } from '../_shared/ac.ts';
import { DEPLOY_STEP } from '../_shared/linked.ts';
import { minutes, sinceOf, WAIT_MS } from '../_shared/wait.ts';
import { failedOf } from '../_shared/qa.ts';
import { teamSkill } from '../_shared/team.ts';

const LABEL = 'тест на стенде';

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Итог прогона в 2-4 предложениях' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ac: { type: 'string', description: 'Номер критерия приемки' },
          scenario: { type: 'string', description: 'Что проверяет сценарий' },
          action: { type: 'string', description: 'Что сделано на стенде' },
          expected: { type: 'string', description: 'Ожидаемый результат' },
          result: { type: 'string', enum: [...AC_RESULTS] },
          note: { type: 'string', description: 'Факт или причина итога' },
          files: { type: 'array', items: { type: 'string' }, description: 'Имена файлов доказательств из папки артефактов, по порядку' },
        },
        required: ['ac', 'scenario', 'action', 'expected', 'result', 'note', 'files'],
        additionalProperties: false,
      },
    },
    remarks: { type: 'array', items: { type: 'string' }, description: 'Замечания не по задаче' },
  },
  required: ['summary', 'results', 'remarks'],
  additionalProperties: false,
};

/** Итоги нового круга поверх прошлого: перепроверенные AC заменяются, остальные остаются, новые добавляются в конец. */
export function mergeResults(previous: AcCheck[], fresh: AcCheck[]): AcCheck[] {
  const byAc = new Map(fresh.map((r) => [r.ac, r]));
  return [...previous.map((r) => byAc.get(r.ac) ?? r), ...fresh.filter((r) => !previous.some((p) => p.ac === r.ac))];
}

/** Счет итогов для ленты: "пройдено 5 из 7, не проверено 2". */
export function tally(results: AcCheck[]): string {
  const count = (r: AcResult) => results.filter((x) => x.result === r).length;
  const parts = [`пройдено ${count('пройден')} из ${results.length}`];
  for (const [r, word] of [
    ['не пройден', 'не пройдено'],
    ['частично', 'частично'],
    ['не проверен', 'не проверено'],
  ] as const) {
    if (count(r)) parts.push(`${word} ${count(r)}`);
  }
  return parts.join(', ');
}

function output(value: unknown): { summary: string; results: AcCheck[]; remarks: string[] } {
  const o = value as { summary?: unknown; results?: unknown; remarks?: unknown } | null;
  if (!o || typeof o.summary !== 'string' || !Array.isArray(o.results)) throw new Error('Агент не вернул итоги прогона');
  const results = o.results.map((r, i): AcCheck => {
    const x = r as Record<string, unknown>;
    const str = (k: string) => (typeof x[k] === 'string' ? (x[k] as string) : '');
    if (!AC_RESULTS.includes(x.result as AcResult)) throw new Error(`Итог AC ${str('ac') || i + 1} не из списка: ${String(x.result)}`);
    return {
      ac: str('ac'),
      scenario: str('scenario'),
      action: str('action'),
      expected: str('expected'),
      result: x.result as AcResult,
      note: str('note'),
      files: Array.isArray(x.files) ? x.files.filter((f): f is string => typeof f === 'string') : [],
    };
  });
  const remarks = Array.isArray(o.remarks) ? o.remarks.filter((r): r is string => typeof r === 'string') : [];
  return { summary: o.summary, results, remarks };
}

/** Адрес сервиса репозитория на стенде без пути; null - у стенда адресов сервисов нет, тест идет через Keycloak. */
export function serviceBase(c: StepContext): string | null {
  return c.stand?.serviceUrl ? c.stand.serviceUrl.replaceAll('{service}', c.repo.id).replace(/\/+$/, '') : null;
}

/**
 * Проверяет ли сборку на стенде прогона вход через Keycloak: по профилю сервиса Keycloak на своем стенде ходит в этот сервис
 * на serviceStand. Строка промпта объясняет, где входить или почему через Keycloak не проверить.
 */
function keycloakRoute(c: StepContext): string {
  const stand = c.stand!;
  const kk = c.repo.qa?.keycloak;
  if (!kk) return `Входа через Keycloak в эту сборку нет: проверяй запросами к API сервиса.`;
  const kkStand = c.standById(kk.stand);
  if (kk.serviceStand !== stand.id || !kkStand?.url) {
    return `Через вход Keycloak эту сборку не проверить: Keycloak ходит в ${c.repo.id} на ${c.standById(kk.serviceStand)?.title ?? kk.serviceStand}, а сборка стоит на ${stand.title}. Проверяй запросами к API сервиса.`;
  }
  return `Вход через Keycloak проверяет и эту сборку: Keycloak на стенде ${kkStand.title} (${kkStand.url}, realm ${kkStand.realm ?? 'не указан'}) ходит в ${c.repo.id} на ${stand.title}. Сценарии входа веди там по скиллу, логи Keycloak - mcp__pipeline__qa_kibana_logs без service.`;
}

/** Промпт теста сервиса на стенде с адресами сервисов: запросы к API и, где Keycloak ходит в эту сборку, вход через Keycloak. */
function servicePrompt(c: StepContext, files: { guide: string; report: string; artifacts: string }): string {
  const issue = c.get<Issue>('issue');
  if (!issue) throw new Error('Задача не загружена из Jira');
  const stand = c.stand!;
  return `${renderTemplate(readText(import.meta.url, './prompt-service.md'), {
    ...common(c, issue),
    service: c.repo.id,
    serviceUrl: serviceBase(c)!,
    health: c.repo.health ?? '/',
    keycloak: keycloakRoute(c),
    dataView: c.ports.logs(stand.logs).dataView ?? '',
    skill: teamSkill(c, 'qa'),
    ...files,
  })}\n\n${agentRules(c)}`;
}

/** Строка промпта о связанных прогонах: что задача меняет в других репозиториях и что из этого выкачено. */
function linkedPrompt(c: StepContext): string {
  const linked = c.linked();
  return linked.length ? `Задачу меняют и связанные прогоны в других репозиториях, проверяй AC с учетом их изменений: ${linked.map((l) => linkedText(l, DEPLOY_STEP)).join('; ')}.` : '';
}

/**
 * Тест на стенде идет один раз, когда связанные прогоны задачи выкатили свои сборки: пока нет, шаг ждет их деплоя,
 * а наблюдатель продолжит его, когда выкачены все. Кого ждет, шаг пишет в ленту.
 */
function checkLinked(c: StepContext): void {
  const pending = pendingDeploys(c.linked(), DEPLOY_STEP);
  if (!pending.length) return;
  const text = pending.map((l) => linkedText(l, DEPLOY_STEP)).join('; ');
  c.log(`Тест на стенде ждет деплоя связанных прогонов: ${text}`);
  throw new StepWaiting(`Жду деплоя связанных прогонов: ${text}`, {
    kind: 'linked',
    deployStep: DEPLOY_STEP,
    ...timed(sinceOf(c, 'linked'), WAIT_MS.linked, `За ${minutes(WAIT_MS.linked)} минут связанные прогоны не выкатились: ${text}`),
  });
}

/** Что проверять: после круга с непройденными AC на этом стенде - только их, иначе все. */
function scopeOf(c: StepContext): { previous: QaReport | undefined; only: string[] } {
  const previous = c.get<QaReport>('qaReport');
  return { previous, only: previous && previous.stand === c.stand?.id ? failedOf(previous) : [] };
}

/** Общее для промптов теста на стенде: задача, AC, стенд, что на нем выкачено, связанные прогоны и что проверить. */
function common(c: StepContext, issue: Issue): Record<string, string> {
  const stand = c.stand!;
  const deployed = c.get<DeployedBuild>('deployedBuild');
  const { previous, only } = scopeOf(c);
  const scope = only.length
    ? `только AC ${only.join(', ')}: на прошлом круге они не прошли, после исправления их нужно перепроверить. Прошлые итоги по ним:\n${previous!.results
        .filter((r) => only.includes(r.ac))
        .map((r) => `- AC ${r.ac}: ${r.result}, ${r.note}`)
        .join('\n')}`
    : 'все критерии приемки.';
  return {
    key: issue.key,
    summary: issue.summary,
    url: issue.url,
    status: issue.status,
    description: issue.description.trim() || 'описания нет',
    ac: acText(acOf(c)),
    stand: stand.title,
    namespace: stand.namespace,
    bambooEnv: stand.bambooEnv,
    deployed:
      deployed && deployed.stand === stand.id
        ? `Этот прогон выкатил на стенд сборку ${deployed.build}${deployed.tag ? ` с образом ${deployed.tag}` : ''}.`
        : 'Этот прогон на стенд не деплоил: что там выкачено, сверь по логам стенда (образ пода) и напиши в отчете.',
    standNotes: stand.notes.length ? `Особенности стенда: ${stand.notes.join('; ')}.` : '',
    linked: linkedPrompt(c),
    scope,
  };
}

/** Промпт теста на стенде Keycloak: входы в QA-браузере по скиллу. */
function prompt(c: StepContext, files: { guide: string; report: string; artifacts: string }): string {
  const issue = c.get<Issue>('issue');
  if (!issue) throw new Error('Задача не загружена из Jira');
  const stand = c.stand!;
  return `${renderTemplate(readText(import.meta.url, './prompt.md'), {
    ...common(c, issue),
    standUrl: stand.url ?? '',
    realm: stand.realm ?? 'не указан',
    skill: teamSkill(c, 'qa'),
    ...files,
  })}\n\n${agentRules(c)}`;
}

/**
 * Прогон AC на стенде агентом по скиллу keycloak-stand-qa. Браузер - QA-браузер Task Pilot: песочница агента
 * без сети, поэтому действия в браузере агент выполняет инструментами pipeline, а скриншоты сервер кладет
 * прямо в папку артефактов задачи. Капчу, коды и подтверждения агент просит у владельца вопросом.
 * После круга с непройденными AC следующий запуск на том же стенде проверяет только их.
 */
const step: StepModule = {
  async done(c) {
    const report = c.get<QaReport>('qaReport');
    if (!report || report.stand !== c.stand?.id) return null;
    // Новая сборка на стенде (например, после исправления в петле) требует нового прогона.
    if ((c.get<DeployedBuild>('deployedBuild')?.tag ?? null) !== report.build) return null;
    if (failedOf(report).length) return null;
    return { note: `AC уже проверены на ${report.stand}${report.build ? ` со сборкой ${report.build}` : ''}: ${tally(report.results)}` };
  },

  async simulate(c) {
    return {
      qaReport: {
        at: new Date().toISOString(),
        stand: c.stand?.id ?? '',
        build: c.get<DeployedBuild>('deployedBuild')?.tag ?? null,
        summary: 'Пробный прогон: AC не проверялись',
        results: [],
        remarks: [],
        guide: join(c.paths.docs, 'qa-guide.md'),
        report: join(c.paths.docs, 'qa-report.md'),
        artifacts: join(c.paths.artifacts, 'qa'),
        missing: [],
      } satisfies QaReport,
      failedAc: [],
    };
  },

  async run(c) {
    const stand = c.stand;
    if (!stand) throw new Error('Выберите стенд в шапке прогона');
    // Стенд Keycloak - вход по скиллу, стенд с адресами сервисов - запросы к API сервиса и, где Keycloak ходит в
    // эту сборку, вход через Keycloak; без адреса проверять нечего.
    const service = serviceBase(c);
    if (!stand.url && !service) throw new Error(`У стенда ${stand.title} нет адреса в профиле`);
    checkLinked(c);
    const { started } = await c.ports.browser.ensure();
    c.log(
      started
        ? `QA-браузер Task Pilot запущен (порт ${c.ports.browser.port}): прогон идет в нем, капчу и коды агент попросит вопросом`
        : `Прогон идет в открытом QA-браузере Task Pilot (порт ${c.ports.browser.port})`,
    );
    const artifacts = join(c.paths.artifacts, 'qa');
    mkdirSync(artifacts, { recursive: true });
    const docs = stageDocs(c);
    const guide = join(docs.dir, 'qa-guide.md');
    const report = join(docs.dir, 'qa-report.md');
    const { previous, only } = scopeOf(c);
    const r = await c.agent.run({
      label: LABEL,
      prompt: service ? servicePrompt(c, { guide, report, artifacts }) : prompt(c, { guide, report, artifacts }),
      cwd: c.get<string>('worktree') ?? c.repo.path,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      // Код на этом шаге не меняется: писать можно только QA-гайд и отчет в копии доков.
      writeCwd: false,
      writeDirs: [docs.dir],
      allow: ['mcp__pipeline__qa_browser', 'mcp__pipeline__qa_kibana_logs', `Bash(python3 ${teamSkill(c, 'qa')}/scripts/kibana_url.py *)`, ...jiraTools(c, ['jira_get_issue'])],
      mcp: [c.jira.mcp],
      schema: SCHEMA,
    });
    if (!existsSync(report)) throw new Error(`Агент не записал отчет ${report}`);
    docs.back();
    const out = output(r.output);
    const results = only.length && previous ? mergeResults(previous.results, out.results) : out.results;
    const missing = [...new Set(results.flatMap((x) => x.files))].filter((f) => !existsSync(join(artifacts, f)));
    if (missing.length) c.log(`В папке артефактов нет файлов, на которые ссылается отчет: ${missing.join(', ')}`);
    const qaReport: QaReport = {
      at: new Date().toISOString(),
      stand: stand.id,
      build: c.get<DeployedBuild>('deployedBuild')?.tag ?? null,
      summary: out.summary,
      results,
      remarks: out.remarks,
      guide: join(c.paths.docs, 'qa-guide.md'),
      report: join(c.paths.docs, 'qa-report.md'),
      artifacts,
      missing,
    };
    const failedAc = failedOf(qaReport);
    c.log(`Итог на ${stand.title}: ${tally(results)}${failedAc.length ? `; не прошли AC ${failedAc.join(', ')}` : ''}`);
    return { qaReport, failedAc };
  },
};

export default step;
