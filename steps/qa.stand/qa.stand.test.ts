import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest, BrowserPort, Issue, LinkedRun, RepoProfile, StandLogsPort, StandProfile, WaitEvent } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testLinked, testRepo } from '../_test/context.ts';
import { waitOf } from '../_test/wait.ts';
import type { AcCheck, DeployedBuild, QaReport } from '../../packages/step-kit/src/index.ts';
import { failedOf } from '../_shared/qa.ts';
import step, { mergeResults, tally } from './index.ts';

const KEY = 'TEAM-9';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const STAND: StandProfile = {
  id: 'testing-5',
  title: 'testing-5',
  contour: 'cloud',
  url: 'https://kc-5.example.org',
  realm: 'sso-test-realm',
  namespace: 'testing-cloud-5',
  bambooEnv: 'Testing-Cloud-5',
  bambooEnvId: 30474300,
  logs: 'kibana',
  deployable: true,
  notes: ['партнерские входы только на stable'],
};

const ISSUE: Issue = {
  key: KEY,
  summary: 'Капча перед SMS',
  status: 'To Testing',
  url: `https://jira.example.org/browse/${KEY}`,
  labels: [],
  components: [],
  sprint: null,
  assignee: null,
  description: 'Показывать капчу, если есть признаки фрода',
};

const DEPLOYED: DeployedBuild = { stand: 'testing-5', build: 'BUILDS-P246-4', tag: '1.0.4-246', resultId: 42, pod: 'kc-new' };

const check = (ac: string, result: AcCheck['result'], files: string[] = []): AcCheck => ({ ac, scenario: `сценарий ${ac}`, action: 'действие', expected: 'ожидаемое', result, note: `факт ${ac}`, files });

function browser() {
  const calls: string[] = [];
  const port: BrowserPort = {
    port: 9343,
    async ensure() {
      calls.push('ensure');
      return { started: true };
    },
    async act() {
      throw new Error('шаг сам браузером не управляет');
    },
    async kibanaLogs() {
      throw new Error('шаг сам логи не выгружает');
    },
  };
  return { port, calls };
}

/**
 * Агент по сценарию: пишет гайд и отчет в копию доков, кладет скриншоты в папку артефактов (там их оставил бы
 * инструмент qa_browser) и возвращает итог.
 */
function setup(opts: {
  results: AcCheck[];
  values?: Record<string, unknown>;
  shots?: string[];
  writeReport?: boolean;
  stand?: StandProfile | undefined;
  linked?: () => LinkedRun[];
  repo?: Partial<RepoProfile>;
  stands?: StandProfile[];
  logs?: StandLogsPort;
  waited?: WaitEvent | null;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-pilot-qa-')));
  roots.push(root);
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  const b = browser();
  const artifacts = join(repoPath, '.claude', 'artifacts', KEY, 'qa');
  const agent = fakeAgent((req: AgentRequest) => {
    if (opts.writeReport !== false) {
      writeFileSync(join(req.writeDirs![0]!, 'qa-guide.md'), '# Гайд\n');
      writeFileSync(join(req.writeDirs![0]!, 'qa-report.md'), '# Отчет\n\n| AC | Итог |\n');
    }
    for (const f of opts.shots ?? []) writeFileSync(join(artifacts, f), 'png');
    return { output: { summary: 'Прогон закончен', results: opts.results, remarks: ['опечатка на странице входа'] } };
  });
  const c = testContext({
    issueKey: KEY,
    repo: { ...testRepo(repoPath, join(root, 'wt')), ...opts.repo },
    ports: { browser: b.port, ...(opts.logs ? { logs: () => opts.logs! } : {}) },
    stands: opts.stands,
    stand: 'stand' in opts ? opts.stand : STAND,
    values: { issue: ISSUE, ac: ['Капча вместо SMS при фроде', 'SMS не уходит до капчи', 'Сервис капчи недоступен'], deployedBuild: DEPLOYED, ...opts.values },
    agent: agent.agent,
    linked: opts.linked,
    waited: opts.waited ?? null,
  });
  return { c, root, repoPath, artifacts, agent, browser: b };
}

describe('qa.stand with linked runs', () => {
  const deployed = testLinked({ steps: [{ id: 'deploy.stand', selected: true, status: 'succeeded' }], context: { build: { key: 'BUILDS-OA-12' }, deployedBuild: { stand: 'core-stable', build: 'BUILDS-OA-12', tag: '1.0.12-3' } } });

  it('waits for the linked runs of the task to deploy their builds without opening the browser', async () => {
    const t = setup({ results: [], linked: () => [testLinked()] });
    const e = await waitOf(step.run(t.c));
    expect(e).toMatchObject({ kind: 'linked', deployStep: 'deploy.stand' });
    // Два часа без деплоя связанных прогонов - и наблюдатель уронит шаг с тем, кого он ждал.
    expect(Date.parse(e.deadline.at) - Date.parse(e.since)).toBe(2 * 60 * 60_000);
    expect(e.deadline.error).toBe('За 120 минут связанные прогоны не выкатились: adapter: деплой еще не прошел');
    expect(t.c.logs).toContain('Тест на стенде ждет деплоя связанных прогонов: adapter: деплой еще не прошел');
    expect(t.browser.calls).toEqual([]);
    expect(t.agent.requests).toHaveLength(0);
    // Проверка до деплоя не сдвигает срок ожидания.
    const again = await waitOf(step.run(setup({ results: [], linked: () => [testLinked()], waited: e }).c));
    expect(again).toMatchObject({ since: e.since, deadline: e.deadline });
  });

  it('starts the test once the linked runs have deployed their builds and tells the agent about them', async () => {
    const e = await waitOf(step.run(setup({ results: [], linked: () => [testLinked()] }).c));
    const t = setup({ results: [check('1', 'пройден')], linked: () => [deployed], waited: e });
    await step.run(t.c);
    expect(t.agent.requests[0]!.prompt).toContain(
      'Задачу меняют и связанные прогоны в других репозиториях, проверяй AC с учетом их изменений: adapter: сборка BUILDS-OA-12 с образом 1.0.12-3 выкачена на core-stable.',
    );
    expect(t.browser.calls).toEqual(['ensure']);
  });
});

describe('qa.stand for a core service', () => {
  const core = (id: string, title: string, host: string): StandProfile => ({
    id,
    title,
    contour: 'core',
    serviceUrl: `https://{service}-${host}.test.example.com`,
    namespace: title.toLowerCase(),
    bambooEnv: title,
    bambooEnvIds: { 'adapter': 1, mobile: 2 },
    logs: 'kibana-k8s',
    deployable: true,
    notes: [],
  });
  const STABLE = core('core-stable', 'Stable', 'stable');
  const TESTING = core('core-testing-a-0', 'Testing-A-0', 'team-a-0');
  const KEYCLOAK: StandProfile = { ...STAND, id: 'stable', title: 'stable', url: 'https://kc-stable.example.org', realm: 'sso-test-realm' };
  const LOGS: StandLogsPort = { dataView: 'dv-k8s', pods: async () => ({}), probe: async () => ({ status: 200, environment: null }) };
  const openid = { id: 'adapter', health: '/health/readiness', qa: { keycloak: { stand: 'stable', serviceStand: 'core-stable' } } };
  const run = async (stand: StandProfile, repo: Partial<RepoProfile>) => {
    const t = setup({ results: [check('1', 'пройден')], stand, repo, stands: [STABLE, KEYCLOAK], logs: LOGS, values: { deployedBuild: { ...DEPLOYED, stand: stand.id } } });
    await step.run(t.c);
    return { t, prompt: t.agent.requests[0]!.prompt };
  };

  it('checks the service on its stand by requests to its API that must come from that stand, and by its logs there', async () => {
    const { t, prompt } = await run(STABLE, openid);
    expect(prompt).toContain('Сервис adapter на стенде Stable (namespace stable, окружение Bamboo Stable): https://adapter-stable.test.example.com.');
    expect(prompt).toContain('действие navigate на https://adapter-stable.test.example.com/health/readiness');
    expect(prompt).toContain('X-Environment должен быть stable');
    expect(prompt).toContain('mcp__pipeline__qa_kibana_logs с service "adapter": выгрузка идет по namespace stable');
    expect(prompt).toContain("kibana_url.py '<from>' '<to>' '<KQL>' adapter 'dv-k8s' level,messagetext stable");
    expect(prompt).toContain('/skills/keycloak-stand-qa/references/services.md');
    expect(prompt).toContain('Этот прогон выкатил на стенд сборку BUILDS-P246-4 с образом 1.0.4-246.');
    expect(t.browser.calls).toEqual(['ensure']);
    expect(t.agent.requests[0]!.allow).toEqual(['mcp__pipeline__qa_browser', 'mcp__pipeline__qa_kibana_logs', 'Bash(python3 /skills/keycloak-stand-qa/scripts/kibana_url.py *)', 'mcp__atlassian__jira_get_issue']);
  });

  it('adds the login through Keycloak where Keycloak reaches the build of the task', async () => {
    const { prompt } = await run(STABLE, openid);
    expect(prompt).toContain(
      'Вход через Keycloak проверяет и эту сборку: Keycloak на стенде stable (https://kc-stable.example.org, realm sso-test-realm) ходит в adapter на Stable.',
    );
  });

  it('checks a build on a testing stand by the API only: Keycloak goes to the service on Stable', async () => {
    const { prompt } = await run(TESTING, openid);
    expect(prompt).toContain('https://adapter-team-a-0.test.example.com');
    expect(prompt).toContain('X-Environment должен быть testing-a-0');
    expect(prompt).toContain('Через вход Keycloak эту сборку не проверить: Keycloak ходит в adapter на Stable, а сборка стоит на Testing-A-0.');
  });

  it('checks mobile by requests only, with no health path and no login through Keycloak', async () => {
    const { prompt } = await run(STABLE, { id: 'mobile' });
    expect(prompt).toContain('Входа через Keycloak в эту сборку нет: проверяй запросами к API сервиса.');
    expect(prompt).toContain('действие navigate на https://mobile-stable.test.example.com/,');
  });
});

describe('qa.stand', () => {
  it('gives the agent the criteria approved with the plan when the task description has none', async () => {
    const plan = { file: '/repo/.claude/TEAM-3/plan.md', hash: 'h', summary: 's', questions: [], ac: ['Бан на 20-й попытке', 'Остаток в ответе'] };
    const t = setup({ results: [check('1', 'пройден')], values: { ac: null, plan } });
    await step.run(t.c);
    expect(t.agent.requests[0]!.prompt).toContain(
      `Критерии приемки:\nв описании задачи их нет, список утвержден с планом (раздел "Критерии приемки" в ${plan.file}):\n1. Бан на 20-й попытке\n2. Остаток в ответе`,
    );
  });

  it('runs the AC in the QA browser, moves the guide and the report into the task docs and names what failed', async () => {
    const t = setup({
      results: [check('1', 'пройден', ['01-captcha.png']), check('2', 'не пройден', ['kibana-logs-01.png']), check('3', 'не проверен')],
      shots: ['01-captcha.png', 'kibana-logs-01.png'],
    });
    const out = (await step.run(t.c)) as { qaReport: QaReport; failedAc: string[] };

    expect(t.browser.calls).toEqual(['ensure']);
    const req = t.agent.requests[0]!;
    expect(req).toMatchObject({ label: 'тест на стенде', writeCwd: false, mcp: ['atlassian'], tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] });
    expect(req.writeDirs).toEqual([t.c.paths.agentDocs]);
    expect(req.allow).toEqual(['mcp__pipeline__qa_browser', 'mcp__pipeline__qa_kibana_logs', 'Bash(python3 /skills/keycloak-stand-qa/scripts/kibana_url.py *)', 'mcp__atlassian__jira_get_issue']);
    expect(req.prompt).toContain('1. Капча вместо SMS при фроде');
    expect(req.prompt).toContain('Стенд testing-5: https://kc-5.example.org, realm sso-test-realm');
    expect(req.prompt).toContain('Этот прогон выкатил на стенд сборку BUILDS-P246-4 с образом 1.0.4-246');
    expect(req.prompt).toContain('Что проверить: все критерии приемки.');
    expect(req.prompt).toContain('/skills/keycloak-stand-qa/SKILL.md');
    expect(req.prompt).toContain(t.artifacts);
    expect(req.prompt).toContain('Стенд общий. Настройки realm и клиентов в админке Keycloak');

    expect(out.failedAc).toEqual(['2']);
    expect(out.qaReport).toMatchObject({ stand: 'testing-5', build: '1.0.4-246', summary: 'Прогон закончен', remarks: ['опечатка на странице входа'], missing: [], artifacts: t.artifacts });
    expect(out.qaReport.results.map((r) => [r.ac, r.result])).toEqual([
      ['1', 'пройден'],
      ['2', 'не пройден'],
      ['3', 'не проверен'],
    ]);
    expect(readFileSync(join(t.repoPath, '.claude', KEY, 'qa-report.md'), 'utf8')).toContain('# Отчет');
    expect(existsSync(join(t.repoPath, '.claude', KEY, 'qa-guide.md'))).toBe(true);
    expect(t.c.logs.at(-1)).toBe('Итог на testing-5: пройдено 1 из 3, не пройдено 1, не проверено 1; не прошли AC 2');
  });

  it('rechecks only the AC that failed on this stand and keeps the other results', async () => {
    const previous: QaReport = {
      at: 'x',
      stand: 'testing-5',
      build: '1.0.3-246',
      summary: 'первый круг',
      results: [check('1', 'пройден', ['01.png']), check('2', 'не пройден'), check('3', 'не проверен')],
      remarks: [],
      guide: 'g',
      report: 'r',
      artifacts: 'a',
      missing: [],
    };
    const t = setup({ results: [check('2', 'пройден', ['02-fixed.png'])], shots: ['01.png', '02-fixed.png'], values: { qaReport: previous } });
    const out = (await step.run(t.c)) as { qaReport: QaReport; failedAc: string[] };
    expect(t.agent.requests[0]!.prompt).toContain('Что проверить: только AC 2: на прошлом круге они не прошли');
    expect(t.agent.requests[0]!.prompt).toContain('- AC 2: не пройден, факт 2');
    expect(t.agent.requests[0]!.prompt).toContain('Если отчет уже есть с прошлого круга, обнови в нем итоги перепроверенных AC');
    expect(out.qaReport.results.map((r) => [r.ac, r.result])).toEqual([
      ['1', 'пройден'],
      ['2', 'пройден'],
      ['3', 'не проверен'],
    ]);
    expect(out.failedAc).toEqual([]);
  });

  it('notes the evidence files the report names but the artifacts folder does not have', async () => {
    const t = setup({ results: [check('1', 'пройден', ['01-captcha.png', '09-lost.png'])], shots: ['01-captcha.png'] });
    const out = (await step.run(t.c)) as { qaReport: QaReport };
    expect(out.qaReport.missing).toEqual(['09-lost.png']);
    expect(t.c.logs).toContain('В папке артефактов нет файлов, на которые ссылается отчет: 09-lost.png');
  });

  it('is done when every AC passed or could not be checked on the same stand and build', async () => {
    const report = (results: AcCheck[], over: Partial<QaReport> = {}): QaReport => ({ at: 'x', stand: 'testing-5', build: '1.0.4-246', summary: '', results, remarks: [], guide: '', report: '', artifacts: '', missing: [], ...over });
    const passed = report([check('1', 'пройден'), check('2', 'не проверен')]);
    expect(await step.done!(setup({ results: [], values: { qaReport: passed } }).c)).toEqual({ note: 'AC уже проверены на testing-5 со сборкой 1.0.4-246: пройдено 1 из 2, не проверено 1' });
    expect(await step.done!(setup({ results: [], values: { qaReport: report([check('1', 'частично')]) } }).c)).toBeNull();
    expect(await step.done!(setup({ results: [], values: { qaReport: { ...passed, build: '1.0.3-246' } } }).c)).toBeNull();
    expect(await step.done!(setup({ results: [], values: { qaReport: { ...passed, stand: 'stable' } } }).c)).toBeNull();
    expect(await step.done!(setup({ results: [] }).c)).toBeNull();
  });

  it('refuses without a stand or its address and when the agent wrote no report', async () => {
    await expect(step.run(setup({ results: [], stand: undefined }).c)).rejects.toThrow('Выберите стенд в шапке прогона');
    await expect(step.run(setup({ results: [], stand: { ...STAND, url: undefined } }).c)).rejects.toThrow('нет адреса в профиле');
    await expect(step.run(setup({ results: [check('1', 'пройден')], writeReport: false }).c)).rejects.toThrow('Агент не записал отчет');
  });

  it('refuses a result outside the list', async () => {
    const t = setup({ results: [{ ...check('1', 'пройден'), result: 'ок' as AcCheck['result'] }] });
    await expect(step.run(t.c)).rejects.toThrow('Итог AC 1 не из списка: ок');
  });

  it('counts as failed only what code can fix and merges rechecks in place', () => {
    const results = [check('1', 'пройден'), check('2', 'не пройден'), check('3', 'частично'), check('4', 'не проверен')];
    expect(failedOf({ results })).toEqual(['2', '3']);
    expect(tally(results)).toBe('пройдено 1 из 4, не пройдено 1, частично 1, не проверено 1');
    expect(mergeResults(results, [check('3', 'пройден'), check('5', 'пройден')]).map((r) => `${r.ac}:${r.result}`)).toEqual(['1:пройден', '2:не пройден', '3:пройден', '4:не проверен', '5:пройден']);
  });
});
