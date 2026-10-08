import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGit } from '../../apps/server/src/integrations/git.ts';
import type { AgentRequest, Contour, Issue, PullRequestRef, RepoProfile, ScmPort, ScmRepoRef } from '../../packages/step-kit/src/index.ts';
import { pickBranch } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, TEST_CONTOUR, testContext, testRepo } from '../_test/context.ts';
import { commit, git, gitIdentity, write } from '../_test/git.ts';
import step, { diffKeys, statusPaths } from './index.ts';

const KEY = 'TEAM-7';
const BRANCH = `feature/${KEY}`;
const VARS = 'group_vars/app/app_vars';
const SECRETS = 'templates/app/secrets.yml.j2';
const VALUE = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkey';
const CONFIG_LABEL = 'конфиг деплоя';
const NOTES = ['Настройки сервиса лежат в group_vars/<сервис>/'];

const roots: string[] = [];

beforeAll(gitIdentity);
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ISSUE: Issue = {
  key: KEY,
  summary: 'Обмен паспортного токена',
  status: 'In Progress',
  type: 'Задача',
  labels: [],
  components: [],
  sprint: null,
  assignee: null,
  url: `https://jira.example.org/browse/${KEY}`,
  description: 'Keycloak принимает паспортный JWT',
};

/** Bitbucket поверх bare-remote: ветку он знает, если она есть в remote; созданные PR запоминаются. */
function fakeScm(origin: string, open: PullRequestRef[] = []) {
  const created: { ref: ScmRepoRef; input: Parameters<ScmPort['createPullRequest']>[1] }[] = [];
  const prs = new Map<string, PullRequestRef[]>(open.map((p) => [BRANCH, [p]]));
  const scm: ScmPort = {
    async openPullRequests(_ref, branch) {
      const known = git(origin, 'branch', '--list', branch).trim() !== '';
      return known ? (prs.get(branch) ?? []) : null;
    },
    async createPullRequest(ref, input) {
      created.push({ ref, input });
      const pr = { id: 1500 + created.length, title: input.title, url: `https://git.example.org/pr/${1500 + created.length}`, to: input.to };
      prs.set(input.from, [...(prs.get(input.from) ?? []), pr]);
      return pr;
    },
    findPullRequest: async () => null,
    pullRequest: async () => {
      throw new Error('состояние PR в тесте не нужно');
    },
    reply: async () => {
      throw new Error('ответы в PR в тесте не нужны');
    },
  };
  return { scm, created };
}

/** Правка конфига, какую внес бы агент: переменная с ключом и ее связь с переменной окружения сервиса. */
function writeKeys(cwd: string, value = VALUE): void {
  write(cwd, VARS, `app_port: 8081\napp_log_level: INFO\napp_passport_keys: "${value}"\n`);
  write(cwd, SECRETS, 'data:\n  DB_PASSWORD: {{ app_db_password }}\n  PASSPORT_JWT_PUBLIC_KEYS: {{ app_passport_keys }}\n');
}

const CONFIG_OUTPUT = {
  summary: 'Переменная app_passport_keys для всех окружений и ее связь с PASSPORT_JWT_PUBLIC_KEYS',
  files: [VARS, SECRETS],
  secrets: ['app_passport_private_key для stable и production'],
  remarks: ['Значение для production взято у stable: проверьте'],
};

/**
 * Репозиторий деплоя: bare-remote с master, основная папка владельца (клон) и папка "Bitbucket", из которой ветку
 * задачи заводят так, как ее завела бы кнопка Create branch. Сервис - репозиторий с веткой задачи, которая добавила в
 * конфигурацию переменную окружения; патч, если он нужен тесту, лежит в доках задачи сервиса. Агент конфига по
 * умолчанию вносит правку writeKeys.
 */
function setup(opts: { branch?: string; patch?: boolean; open?: PullRequestRef[]; code?: boolean; config?: (req: AgentRequest) => Record<string, unknown>; contour?: Contour } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-pilot-ansible-')));
  roots.push(root);
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  const bitbucket = join(root, 'bitbucket');
  git(root, 'clone', '-q', origin, bitbucket);
  write(bitbucket, VARS, 'app_port: 8081\napp_log_level: INFO\n');
  write(bitbucket, SECRETS, 'data:\n  DB_PASSWORD: {{ app_db_password }}\n');
  git(bitbucket, 'add', '-A');
  git(bitbucket, 'commit', '-q', '-m', 'init');
  git(bitbucket, 'push', '-q', 'origin', 'master');
  // Патч в формате diff -ruN с метками времени, как его готовят для задачи: две копии файлов, до и после.
  write(join(root, 'a'), VARS, 'app_port: 8081\napp_log_level: INFO\n');
  write(join(root, 'a'), SECRETS, 'data:\n  DB_PASSWORD: {{ app_db_password }}\n');
  writeKeys(join(root, 'b'));
  const service = serviceRepo(root);
  if (opts.patch) write(join(service, '.claude', KEY), 'k8s-ansible-passport-keys.patch', diffRuN(root));
  const ansible = join(root, 'ansible');
  git(root, 'clone', '-q', origin, ansible);
  if (opts.branch) createBranch(bitbucket, opts.branch);
  const deploy: RepoProfile = { ...testRepo(ansible, join(root, 'wt')), id: 'k8s-ansible-cloud', title: 'k8s-ansible', default: false, bitbucket: { project: 'DEVOPS', repo: 'k8s-ansible', reviewers: [] }, notes: NOTES };
  const scm = fakeScm(origin, opts.open);
  const agent = fakeAgent((req) => {
    if (req.label === CONFIG_LABEL) {
      if (opts.config) return { output: opts.config(req) };
      writeKeys(req.cwd);
      return { output: CONFIG_OUTPUT };
    }
    return {
      output: req.resume
        ? { subject: 'Ключи паспорта для стендов и прода', body: '', prTitle: `${KEY} Ключи паспорта для стендов и прода`, prDescription: '- Переменная PASSPORT_JWT_PUBLIC_KEYS' }
        : { subject: 'Публичные ключи паспорта', body: '', prTitle: '', prDescription: '- Переменная PASSPORT_JWT_PUBLIC_KEYS для Keycloak' },
    };
  });
  const repo = { ...testRepo(service, join(root, 'wt')), bitbucket: { project: 'CLOUD', repo: 'gate', reviewers: [] } };
  const context = (over: { draft?: unknown; feedback?: string | null; deployRepo?: RepoProfile | null } = {}) =>
    testContext({
      issueKey: KEY,
      repo,
      deployRepo: over.deployRepo === null ? undefined : (over.deployRepo ?? deploy),
      ...(opts.contour ? { contour: opts.contour } : {}),
      ports: { git: createGit(), scm: scm.scm, jira: { getIssue: async () => ISSUE } as never },
      // Шаг "Ветка" кладет в контекст ветку и рабочую папку задачи; без кода задачи агент работает по задаче и плану.
      values: { issue: ISSUE, branch: BRANCH, ...(opts.code ? { worktree: service } : {}) },
      agent: agent.agent,
      draft: over.draft,
      feedback: over.feedback ?? null,
    });
  const configRequests = () => agent.requests.filter((r) => r.label === CONFIG_LABEL);
  const textRequests = () => agent.requests.filter((r) => r.label !== CONFIG_LABEL);
  return { root, origin, bitbucket, ansible, service, deploy, scm, agent, context, configRequests, textRequests, worktree: join(root, 'wt', `k8s-ansible-cloud-${KEY}`) };
}

/** Сервис с веткой задачи: задача добавила в application.yml переменную окружения и поменяла код. */
function serviceRepo(root: string): string {
  const origin = join(root, 'service.git');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  const service = join(root, 'service');
  git(root, 'clone', '-q', origin, service);
  commit(service, 'src/main/resources/application.yml', 'server:\n  port: 8081\n', 'init');
  git(service, 'push', '-q', 'origin', 'master');
  git(service, 'switch', '-q', '-c', BRANCH);
  commit(service, 'src/main/resources/application.yml', 'server:\n  port: 8081\npassport:\n  keys: ${PASSPORT_JWT_PUBLIC_KEYS:}\n', `${KEY} ключи`);
  commit(service, 'src/main/java/App.java', 'class App {}\n', `${KEY} код`);
  return service;
}

/** diff -ruN a b: код выхода 1 значит, что разница есть. */
function diffRuN(root: string): string {
  try {
    execFileSync('diff', ['-ruN', 'a', 'b'], { cwd: root });
    return '';
  } catch (e) {
    return String((e as { stdout: Buffer }).stdout);
  }
}

/** Кнопка Create branch в Jira: Bitbucket заводит ветку задачи от master прямо на remote. */
function createBranch(bitbucket: string, name = BRANCH): void {
  git(bitbucket, 'push', '-q', 'origin', `master:refs/heads/${name}`);
}

/** Проход шага так, как его ведет движок: done, prepare, preview и после подтверждения run. */
async function publish(t: ReturnType<typeof setup>) {
  const first = t.context();
  expect(await step.done!(first)).toBeNull();
  const draft = await step.prepare!(t.context());
  const gate = t.context({ draft });
  const preview = await step.preview!(gate);
  const outputs = await step.run(gate);
  return { first, draft, preview, outputs, gate };
}

describe('pickBranch', () => {
  it('takes the branch named by the profile pattern first', () => {
    expect(pickBranch(['TEAM-7', 'feature/TEAM-7', 'feature/TEAM-7-keys'], KEY, 'feature/{KEY}')).toEqual({ branch: 'feature/TEAM-7', candidates: ['feature/TEAM-7'] });
  });

  it('takes the only branch Create branch could have made, with a type prefix or a description', () => {
    expect(pickBranch(['master', 'bugfix/TEAM-7-passport-keys'], KEY, 'feature/{KEY}').branch).toBe('bugfix/TEAM-7-passport-keys');
    expect(pickBranch(['master', 'TEAM-7'], KEY, 'feature/{KEY}').branch).toBe('TEAM-7');
  });

  it('ignores service branches and other tasks that only look alike', () => {
    expect(pickBranch(['deploy/TEAM-7-testing-3-1789', 'feature/TEAM-70', 'feature-TEAM-7-venom-1', 'feature/TEAM-777'], KEY, 'feature/{KEY}')).toEqual({ branch: null, candidates: [] });
  });

  it('does not guess between several branches of the task', () => {
    expect(pickBranch(['TEAM-7', 'hotfix/TEAM-7-urgent'], KEY, 'feature/{KEY}')).toEqual({ branch: null, candidates: ['TEAM-7', 'hotfix/TEAM-7-urgent'] });
  });
});

describe('diffKeys', () => {
  it('names the variables a diff adds, changes and removes without their values', () => {
    const diff = [
      '--- a/group_vars/app/app_vars',
      '+++ b/group_vars/app/app_vars',
      '-app_log_level: INFO',
      '+app_log_level: DEBUG',
      '+app_passport_keys: "secret-value"',
      '-app_old_flag: true',
      '+  PASSPORT_JWT_PUBLIC_KEYS: {{ app_passport_keys }}',
      '+JAVA_OPTS=-Xmx1g',
      '+# комментарий без переменной',
      ' app_port: 8081',
    ].join('\n');
    expect(diffKeys(diff)).toEqual({ added: ['app_passport_keys', 'PASSPORT_JWT_PUBLIC_KEYS', 'JAVA_OPTS'], changed: ['app_log_level'], removed: ['app_old_flag'] });
  });
});

describe('statusPaths', () => {
  it('keeps both paths of a rename so the commit also takes the removal', () => {
    expect(statusPaths('R  new.yml\0old.yml\0 M vars\0?? added.j2\0')).toEqual(['new.yml', 'old.yml', 'vars', 'added.j2']);
  });
});

describe('ansible.config: the agent writes the config', () => {
  it('starts the branch named like the task branch from master, lets the agent write the config and creates the branch on the remote only with the push after the approval', async () => {
    const t = setup();
    const first = t.context();
    expect(await step.done!(first)).toBeNull();
    const draft = await step.prepare!(t.context());
    // До подтверждения ветка есть только в папке шага: на remote ничего не ушло.
    expect(git(t.origin, 'branch', '--list', BRANCH).trim()).toBe('');
    expect(git(t.worktree, 'branch', '--show-current').trim()).toBe(BRANCH);
    expect(draft).toMatchObject({ branch: BRANCH, config: { sessionId: 's-1', summary: CONFIG_OUTPUT.summary, secrets: CONFIG_OUTPUT.secrets, remarks: CONFIG_OUTPUT.remarks }, subject: `${KEY} Публичные ключи паспорта` });

    const gate = t.context({ draft });
    const preview = await step.preview!(gate);
    expect(preview.summary).toBe(CONFIG_OUTPUT.summary);
    expect(preview.actions).toEqual([
      `Завести ветку ${BRANCH} в DEVOPS/k8s-ansible от master: ее создаст пуш`,
      `Коммит в ${BRANCH} репозитория DEVOPS/k8s-ansible, файлов: 2 (${VARS}, ${SECRETS})`,
      `Пуш ${BRANCH} в origin, новая ветка, коммитов: 1`,
      `Создать PR ${BRANCH} → master в DEVOPS/k8s-ansible`,
    ]);
    expect(preview.warnings).toEqual([
      'Секрет нужно завести до деплоя: app_passport_private_key для stable и production',
      'Значение для production взято у stable: проверьте',
      `После публикации деплой задачи возьмет конфиг из ветки k8s-ansible ${BRANCH} сам: она названа как ветка задачи`,
    ]);
    expect(preview.texts!.find((x) => x.id === 'diff')!.text).toContain(`+app_passport_keys: "${VALUE}"`);
    expect(preview.payload).toMatchObject({ branch: BRANCH, fresh: true });

    const outputs = await step.run(gate);
    expect(outputs).toEqual({ ansibleBranch: BRANCH, ansiblePr: expect.objectContaining({ id: 1501, to: 'master' }) });
    expect(git(t.origin, 'log', '-1', '--format=%s', BRANCH).trim()).toBe(`${KEY} Публичные ключи паспорта`);
    expect(git(t.origin, 'show', `${BRANCH}:${SECRETS}`)).toContain('PASSPORT_JWT_PUBLIC_KEYS');
    // Ветка задачи отслеживает remote с первого пуша, а основная папка владельца не тронута.
    expect(git(t.worktree, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe(`origin/${BRANCH}`);
    expect(git(t.ansible, 'branch', '--show-current').trim()).toBe('master');
    expect(await step.done!(t.context())).toEqual({ note: `Конфиг деплоя опубликован: ветка ${BRANCH}, PR #1501`, outputs: { ansibleBranch: BRANCH, ansiblePr: expect.objectContaining({ id: 1501 }) } });
  });

  it('gives the config agent the task, the plan, the changes of the service and the notes of the repository, with writes only in the branch folder', async () => {
    const t = setup({ code: true });
    await step.prepare!(t.context());
    const [config] = t.configRequests();
    expect(config).toMatchObject({ cwd: t.worktree, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] });
    expect(config!.writeCwd).toBeUndefined();
    expect(config!.allow).toEqual(expect.arrayContaining(['Bash(git log *)', `Bash(git -C ${t.service} diff *)`, `Bash(git -C ${t.service} log *)`, `Bash(git -C ${t.service} show *)`]));
    expect(config!.prompt).toContain(`Рабочая папка - ветка ${BRANCH} репозитория деплоя DEVOPS/k8s-ansible от origin/master`);
    expect(config!.prompt).toContain('Сервис задачи - gate.');
    expect(config!.prompt).toContain('<файлы сервиса>\nA src/main/java/App.java\nM src/main/resources/application.yml\n</файлы сервиса>');
    expect(config!.prompt).toContain('+  keys: ${PASSPORT_JWT_PUBLIC_KEYS:}');
    expect(config!.prompt).toContain(`- ${NOTES[0]}`);
    expect(config!.prompt).toContain('Keycloak принимает паспортный JWT');
    // Тексты пишет второй агент: без инструментов и без значений переменных.
    const [texts] = t.textRequests();
    expect(texts).toMatchObject({ tools: [], writeCwd: false });
    expect(texts!.prompt).toContain('Секреты, которые нужно завести до деплоя: app_passport_private_key для stable и production.');
    expect(texts!.prompt).not.toContain(VALUE);
  });

  it('works by the task and the plan when the run has no folder with the code of the task', async () => {
    const t = setup();
    await step.prepare!(t.context());
    expect(t.configRequests()[0]!.prompt).toContain('Рабочей папки с кодом задачи в этом прогоне нет');
  });

  it('reworks the config in the session of the config agent and writes the texts anew for the new change', async () => {
    const t = setup({
      config: (req) => {
        writeKeys(req.cwd, req.resume ? 'other-key' : VALUE);
        return CONFIG_OUTPUT;
      },
    });
    const draft = await step.prepare!(t.context());
    const again = await step.prepare!(t.context({ draft, feedback: 'ключ для прода другой' }));
    const [, rework] = t.configRequests();
    expect(rework).toMatchObject({ resume: 's-1' });
    expect(rework!.prompt).toContain('<замечание>\nключ для прода другой\n</замечание>');
    // Тексты пишутся заново по новой правке, с замечанием, а не в прежней сессии.
    const [, texts] = t.textRequests();
    expect(texts!.resume).toBeUndefined();
    expect(texts!.prompt).toContain('Замечание владельца к прошлой версии правки и текстов: ключ для прода другой');
    expect(again).toMatchObject({ branch: BRANCH, config: { sessionId: 's-1' } });
    expect(readFileSync(join(t.worktree, VARS), 'utf8')).toContain('other-key');
  });

  it('fails with the explanation of the agent when the config needs no change', async () => {
    const t = setup({ config: () => ({ summary: 'Новых настроек сервису не нужно', files: [], secrets: [], remarks: [] }) });
    await expect(step.prepare!(t.context())).rejects.toThrow('Агент не нашел, что менять в конфиге деплоя: Новых настроек сервису не нужно. Если конфиг задаче не нужен, пропустите шаг');
  });

  it('refuses a branch that differs from the task branch only by case', async () => {
    const t = setup({ branch: 'feature/team-7' });
    await expect(step.prepare!(t.context())).rejects.toThrow(`В DEVOPS/k8s-ansible есть ветка feature/team-7, а нужна ${BRANCH}: они отличаются только регистром`);
  });

  it('creates the branch again with the push when it disappeared from the remote after the texts were ready', async () => {
    const t = setup({ branch: BRANCH });
    const draft = await step.prepare!(t.context());
    git(t.bitbucket, 'push', '-q', 'origin', '--delete', BRANCH);
    const gate = t.context({ draft });
    expect((await step.preview!(gate)).actions[0]).toBe(`Завести ветку ${BRANCH} в DEVOPS/k8s-ansible от master: ее создаст пуш`);
    await step.run(gate);
    expect(git(t.origin, 'log', '-1', '--format=%s', BRANCH).trim()).toBe(`${KEY} Публичные ключи паспорта`);
  });
});

describe('ansible.config: the patch from the task docs', () => {
  it('applies the patch instead of the agent to the branch named like the task branch and publishes commit, push and PR after one approval', async () => {
    const t = setup({ patch: true, branch: BRANCH });
    const { draft, preview, outputs } = await publish(t);

    expect(t.configRequests()).toEqual([]);
    expect(draft).toMatchObject({ branch: BRANCH, config: null, subject: `${KEY} Публичные ключи паспорта`, prTitle: `${KEY} Публичные ключи паспорта` });
    expect(preview.title).toBe(`Конфиг деплоя ${KEY}: DEVOPS/k8s-ansible`);
    expect(preview.actions).toEqual([
      `Коммит в ${BRANCH} репозитория DEVOPS/k8s-ansible, файлов: 2 (${VARS}, ${SECRETS})`,
      `Пуш ${BRANCH} в origin, коммитов: 1`,
      `Создать PR ${BRANCH} → master в DEVOPS/k8s-ansible`,
    ]);
    expect(preview.texts!.map((x) => [x.id, x.publish])).toEqual([
      ['commit', true],
      ['prTitle', true],
      ['prDescription', true],
      ['diff', false],
    ]);
    // Владелец видит ровно дифф коммита, со значениями; в публикуемые тексты значения не попадают.
    expect(preview.texts!.find((x) => x.id === 'diff')!.text).toContain(`+app_passport_keys: "${VALUE}"`);
    expect(preview.warnings!.at(-1)).toBe(`После публикации деплой задачи возьмет конфиг из ветки k8s-ansible ${BRANCH} сам: она названа как ветка задачи`);

    expect(outputs).toEqual({ ansibleBranch: BRANCH, ansiblePr: expect.objectContaining({ id: 1501, to: 'master' }) });
    expect(git(t.origin, 'show', `${BRANCH}:${VARS}`)).toContain('app_passport_keys');
    expect(t.scm.created).toEqual([
      { ref: { contour: 'cloud', project: 'DEVOPS', repo: 'k8s-ansible' }, input: expect.objectContaining({ from: BRANCH, to: 'master', title: `${KEY} Публичные ключи паспорта` }) },
    ]);
    expect(await step.done!(t.context())).toEqual({ note: `Конфиг деплоя опубликован: ветка ${BRANCH}, PR #1501`, outputs: { ansibleBranch: BRANCH, ansiblePr: expect.objectContaining({ id: 1501 }) } });
  });

  it('applies the patch to a new branch too', async () => {
    const t = setup({ patch: true });
    const { preview } = await publish(t);
    expect(t.configRequests()).toEqual([]);
    expect(preview.actions[0]).toBe(`Завести ветку ${BRANCH} в DEVOPS/k8s-ansible от master: ее создаст пуш`);
    expect(git(t.origin, 'show', `${BRANCH}:${VARS}`)).toContain('app_passport_keys');
  });

  it('takes the only branch made earlier by Create branch under another name and warns that it needs Customize Deploy', async () => {
    const t = setup({ patch: true, branch: `bugfix/${KEY}-passport-keys` });
    const draft = await step.prepare!(t.context());
    const preview = await step.preview!(t.context({ draft }));
    expect(preview.warnings!.at(-1)).toBe(
      `После публикации деплой задачи пойдет через Customize Deploy с веткой k8s-ansible bugfix/${KEY}-passport-keys: она названа не как ветка задачи ${BRANCH}, и кнопку Deploy в Bamboo нажимаете вы`,
    );
  });

  it('warns that the deploy goes through Customize Deploy in a contour whose deploy does not take the task branch itself', async () => {
    const t = setup({ patch: true, contour: { ...TEST_CONTOUR, id: 'core', title: 'core', deploy: { ansibleBranch: 'customize' } } });
    const draft = await step.prepare!(t.context());
    const preview = await step.preview!(t.context({ draft }));
    expect(preview.warnings!.at(-1)).toBe(`После публикации деплой задачи пойдет через Customize Deploy с веткой k8s-ansible ${BRANCH}: деплой контура core ветку задачи сам не берет, и кнопку Deploy в Bamboo нажимаете вы`);
  });

  it('gives the texts agent file and variable names but never the values', async () => {
    const t = setup({ patch: true });
    await publish(t);
    const prompt = t.textRequests()[0]!.prompt;
    expect(prompt).toContain(`${VARS} (+1, -0)`);
    expect(prompt).toContain('app_passport_keys, PASSPORT_JWT_PUBLIC_KEYS');
    expect(prompt).not.toContain(VALUE);
    expect(t.textRequests()[0]).toMatchObject({ tools: [], writeCwd: false });
  });

  it('counts a branch with its own version of the config and an open PR as done and says the patch differs', async () => {
    const t = setup({ patch: true, branch: BRANCH, open: [{ id: 1513, title: `${KEY} Ключи`, url: 'https://git.example.org/pr/1513', to: 'master' }] });
    // Владелец применил патч руками и поменял значение: патч не ложится ни прямо, ни обратно.
    git(t.bitbucket, 'fetch', '-q', 'origin');
    git(t.bitbucket, 'switch', '-q', BRANCH);
    commit(t.bitbucket, VARS, 'app_port: 8081\napp_log_level: INFO\napp_passport_keys: "other"\n', `${KEY} Ключи`);
    commit(t.bitbucket, SECRETS, 'data:\n  DB_PASSWORD: {{ app_db_password }}\n  PASSPORT_JWT_PUBLIC_KEYS: {{ app_passport_keys | b64encode }}\n');
    git(t.bitbucket, 'push', '-q', 'origin', BRANCH);
    const done = await step.done!(t.context());
    expect(done!.note).toBe(`Конфиг деплоя опубликован: ветка ${BRANCH}, PR #1513; Патч k8s-ansible-passport-keys.patch не совпадает с веткой ${BRANCH}: похоже, конфиг в ветке уже правили руками, публикуется то, что в ветке`);
    expect(done!.outputs).toEqual({ ansibleBranch: BRANCH, ansiblePr: expect.objectContaining({ id: 1513 }) });
  });

  it('refuses a patch that does not fit the branch', async () => {
    const t = setup({ patch: true, branch: BRANCH });
    git(t.bitbucket, 'switch', '-q', 'master');
    commit(t.bitbucket, VARS, 'app_port: 9090\n');
    git(t.bitbucket, 'push', '-q', 'origin', 'master');
    git(t.bitbucket, 'push', '-q', '-f', 'origin', `master:refs/heads/${BRANCH}`);
    await expect(step.prepare!(t.context())).rejects.toThrow(`Патч k8s-ansible-passport-keys.patch не ложится на ветку ${BRANCH}`);
  });

  it('does not take foreign changes of the branch folder into the commit', async () => {
    const t = setup({ patch: true, branch: BRANCH });
    const draft = await step.prepare!(t.context());
    write(t.worktree, 'inventory/hosts', 'extra\n');
    await expect(step.preview!(t.context({ draft }))).rejects.toThrow(`В ${t.worktree} есть изменения вне патчей задачи: inventory/hosts`);
  });

  it('does not commit when the files changed after the approval', async () => {
    const t = setup({ patch: true, branch: BRANCH });
    const draft = await step.prepare!(t.context());
    const gate = t.context({ draft });
    await step.preview!(gate);
    writeFileSync(join(t.worktree, VARS), `${readFileSync(join(t.worktree, VARS), 'utf8')}app_extra: 1\n`);
    await expect(step.run(gate)).rejects.toThrow('изменились после подтверждения');
    expect(git(t.origin, 'log', '-1', '--format=%s', BRANCH).trim()).toBe('init');
  });

  it('reworks only the texts in the same agent session with the owner remark', async () => {
    const t = setup({ patch: true, branch: BRANCH });
    const draft = await step.prepare!(t.context());
    const again = await step.prepare!(t.context({ draft, feedback: 'укажи, что ключи для стендов и прода' }));
    expect(t.configRequests()).toEqual([]);
    expect(t.textRequests()[1]).toMatchObject({ resume: 's-1' });
    expect(t.textRequests()[1]!.prompt).toContain('укажи, что ключи для стендов и прода');
    expect(again).toMatchObject({ branch: BRANCH, subject: `${KEY} Ключи паспорта для стендов и прода` });
  });

  it('asks for the deploy repository in the profile and for its local clone', async () => {
    const t = setup();
    await expect(step.done!(t.context({ deployRepo: null }))).rejects.toThrow('не указан репозиторий конфига деплоя (deployRepo)');
    await expect(step.done!(t.context({ deployRepo: { ...t.deploy, path: join(t.root, 'missing') } }))).rejects.toThrow(`Папки репозитория деплоя ${join(t.root, 'missing')} нет: склонируйте туда DEVOPS/k8s-ansible`);
  });
});
