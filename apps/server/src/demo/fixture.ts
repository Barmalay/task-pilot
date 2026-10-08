/**
 * Заготовка демо-режима: учебный Java-проект с локальным remote, задачи DEMO-1 и DEMO-2 в подмененной Jira,
 * подмененный Bitbucket и конфигурация, в которой учебный репозиторий единственный, а стенды - учебные
 * (подменные Bamboo и Kibana лежат в ./ci.ts). Модуль ничего не запускает сам: запуск - src/demo.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitPort, Issue, JiraConfig, JiraPort, PrComment, PullRequestRef, RepoProfile, ScmPort } from '@task-pilot/step-kit';
import { normalizeName } from '@task-pilot/step-kit';
import type { AppConfig } from '../config.ts';
import { copyPilotTree } from '../pilot.ts';
import { DEMO_LOGS, DEMO_STANDS } from './ci.ts';
import { memoryJiraFiles } from './jira-files.ts';

/** Ключ основной задачи демо-режима: полный цикл без вопросов к владельцу. */
export const DEMO_KEY = 'DEMO-1';

/** Задача, по которой агент анализа спрашивает владельца: решение о делении на ноль за ним. */
export const DEMO_ASK_KEY = 'DEMO-2';

/** Учебный проект: сумма уже есть, задача просит добавить разность. */
const FILES: Record<string, string> = {
  'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>demo</groupId>
  <artifactId>calculator</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.11.4</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin>
      <plugin><artifactId>maven-compiler-plugin</artifactId><version>3.12.1</version></plugin>
      <plugin><artifactId>maven-surefire-plugin</artifactId><version>3.5.2</version></plugin>
    </plugins>
  </build>
</project>
`,
  'CLAUDE.md': `# Учебный калькулятор

Демо-репозиторий конвейера Task Pilot: небольшой калькулятор на Java 21 с тестами JUnit 5.
Сборка и тесты: \`mvn -o -q test\`. Javadoc на публичных методах, тест на каждый метод.
`,
  '.gitignore': 'target/\n.claude/\n.DS_Store\n',
  'src/main/java/demo/Calculator.java': `package demo;

/** Калькулятор целых чисел. */
public class Calculator {

    /** Сумма двух чисел. */
    public int add(int a, int b) {
        return a + b;
    }
}
`,
  'src/test/java/demo/CalculatorTest.java': `package demo;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {

    @Test
    void addsTwoNumbers() {
        assertEquals(5, new Calculator().add(2, 3));
    }
}
`,
};

const DESCRIPTION = `Демо-задача конвейера Task Pilot: полный цикл на учебном репозитории, от плана до PR.

Добавить в Calculator метод subtract(a, b), который возвращает разность a - b, с Javadoc и юнит-тестом.

## Критерии приемки
- subtract(5, 3) возвращает 2
- subtract(3, 5) возвращает -2
- Сборка mvn -o -q test зеленая, новый тест выполняется
`;

const ASK_DESCRIPTION = `Демо-задача конвейера Task Pilot: вопрос агента владельцу во время анализа.

Добавить в Calculator метод divide(a, b), который возвращает целую часть частного, с Javadoc и юнит-тестом.
Поведение при делении на ноль не определено, и выбрать его должен владелец задачи: бросать ArithmeticException
или возвращать 0. Без этого решения план не составить, поэтому спроси владельца до того, как писать план.

## Критерии приемки
- divide(7, 2) возвращает 3
- Деление на ноль ведет себя так, как решил владелец
- Сборка mvn -o -q test зеленая, новый тест выполняется
`;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Task Pilot demo', GIT_AUTHOR_EMAIL: 'demo@task-pilot.invalid', GIT_COMMITTER_NAME: 'Task Pilot demo', GIT_COMMITTER_EMAIL: 'demo@task-pilot.invalid' },
  });
}

/** Создает заново учебный репозиторий: bare-remote с master и основную папку, как у настоящего проекта. */
export function seed(root: string): { origin: string; repo: string } {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/master');
  for (const [file, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Учебный калькулятор');
  git(repo, 'push', '-q', '-u', 'origin', 'master');
  return { origin, repo };
}

/**
 * Task Pilot для демо: копия шагов, пресетов, кода и учебной команды рядом с учебным репозиторием, в плагине учебной
 * команды - учебные скиллы. Копия - свой git-репозиторий, как настоящий Task Pilot: мастер шагов добавляет в нее новый
 * шаг. Разбор прогона, редактор пресетов и мастер шагов в демо правят копию, настоящие файлы остаются как были.
 */
export function demoPilot(root: string, source: string): string {
  const pilot = copyPilotTree(source, join(root, 'pilot'));
  git(pilot, 'init', '-q', '-b', 'master');
  git(pilot, 'add', '-A');
  git(pilot, 'commit', '-q', '-m', 'Task Pilot для демо');
  return pilot;
}

/** Jira в памяти с задачами демо: переходы берутся из пути доски профиля и сдвигают время обновления задачи, как в Jira. */
export function demoJira(board: Pick<JiraConfig, 'path' | 'me' | 'baseUrl'>): JiraPort {
  // Переход без id в профиле доски получает id по статусу, в который ведет: как в Jira, id есть у каждого перехода.
  const idOf = (p: JiraConfig['path'][number]) => p.id ?? `to-${p.to}`;
  const make = (key: string, summary: string, description: string): Issue => ({
    key,
    summary,
    status: 'In Progress',
    type: 'Задача',
    url: `https://demo.invalid/browse/${key}`,
    labels: ['demo'],
    components: ['calculator'],
    sprint: null,
    assignee: { name: board.me },
    description,
    updated: new Date().toISOString(),
    comments: [],
  });
  const issues = new Map([
    [DEMO_KEY, make(DEMO_KEY, 'Калькулятор: вычитание', DESCRIPTION)],
    [DEMO_ASK_KEY, make(DEMO_ASK_KEY, 'Калькулятор: деление', ASK_DESCRIPTION)],
  ]);
  const find = (key: string): Issue => {
    const issue = issues.get(key);
    if (!issue) throw new Error(`В демо-режиме есть только задачи ${[...issues.keys()].join(', ')}`);
    return issue;
  };
  return {
    async search() {
      return [...issues.values()].map((i) => ({ ...i }));
    },
    async getIssue(key) {
      return { ...find(key) };
    },
    async getTransitions(key) {
      const issue = find(key);
      return board.path.filter((p) => normalizeName(p.from) === normalizeName(issue.status)).map((p) => ({ id: idOf(p), name: p.name ?? p.to, to: p.to }));
    },
    async transition(key, id) {
      const issue = find(key);
      const step = board.path.find((p) => idOf(p) === id && normalizeName(p.from) === normalizeName(issue.status));
      if (!step) throw new Error(`Переход ${id} недоступен из статуса ${issue.status}`);
      issue.status = step.to;
      issue.updated = new Date().toISOString();
    },
    async assign(key, username) {
      find(key).assignee = { name: username };
    },
    async sprints() {
      return [];
    },
    ...memoryJiraFiles().port,
  };
}

/** Bitbucket в памяти: ветка видна, если она есть в bare-remote, PR хранятся до перезапуска. */
/** Автор PR и ревьюер в подменном Bitbucket демо: ответы Task Pilot публикует от имени автора. */
export const DEMO_PR_AUTHOR = 'Автор демо';
export const DEMO_REVIEWER = 'Ревьюер демо';
/** Замечание ревьюера демо: сценарный агент исправляет по нему тест. */
export const DEMO_REVIEW_COMMENT = 'Добавь в тест вычитание нуля: subtract(5, 0)';

interface DemoPr extends PullRequestRef {
  from: string;
  state: string;
  createdAt: number;
  comments: PrComment[];
  answeredAt: number | null;
}

/** Подменный Bitbucket демо с управлением из тестов: замечание ревьюера и мерж вручную. */
export interface DemoScm extends ScmPort {
  comment(prId: number, text: string): void;
  merge(prId: number): void;
}

/**
 * Подменный Bitbucket: PR хранятся в памяти, ветку он знает, если она есть в локальном remote. Через reviewMs после
 * создания PR ревьюер демо оставляет замечание, а через mergeMs после того, как автор ответил на все замечания,
 * PR мержится; отрицательное время выключает это поведение (так делают тесты, управляя PR сами). Состояние
 * считается по времени при каждом запросе.
 */
export function demoScm(origin: string, git: GitPort, timing = { reviewMs: 20_000, mergeMs: 10_000 }): DemoScm {
  const prs: DemoPr[] = [];
  let nextComment = 5001;
  const answered = (pr: DemoPr) => pr.comments.every((c) => c.replies.some((r) => r.author === DEMO_PR_AUTHOR));
  const addComment = (pr: DemoPr, text: string) =>
    pr.comments.push({ id: nextComment++, author: DEMO_REVIEWER, text, createdAt: new Date().toISOString(), state: 'OPEN', file: null, line: null, replies: [] });
  const settle = (pr: DemoPr) => {
    if (pr.state !== 'OPEN') return;
    if (timing.reviewMs >= 0 && !pr.comments.length && Date.now() - pr.createdAt >= timing.reviewMs) addComment(pr, DEMO_REVIEW_COMMENT);
    if (timing.mergeMs >= 0 && pr.comments.length && pr.answeredAt !== null && Date.now() - pr.answeredAt >= timing.mergeMs) pr.state = 'MERGED';
  };
  const find = (id: number) => {
    const pr = prs.find((p) => p.id === id);
    if (!pr) throw new Error(`PR ${id} нет`);
    settle(pr);
    return pr;
  };
  const refOf = ({ from: _from, state: _state, createdAt: _createdAt, comments: _comments, answeredAt: _answeredAt, ...ref }: DemoPr): PullRequestRef => ref;
  return {
    async openPullRequests(_ref, branch) {
      if ((await git.tryRun(origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0) return null;
      return prs.filter((p) => p.from === branch && find(p.id).state === 'OPEN').map(refOf);
    },
    async createPullRequest(_ref, input) {
      const id = 1001 + prs.length;
      const pr: DemoPr = { id, title: input.title, url: `https://demo.invalid/pull-requests/${id}`, to: input.to, from: input.from, state: 'OPEN', createdAt: Date.now(), comments: [], answeredAt: null };
      prs.push(pr);
      return refOf(pr);
    },
    async findPullRequest(_ref, branch) {
      const found = prs.filter((p) => p.from === branch).at(-1);
      return found ? refOf(found) : null;
    },
    async pullRequest(_ref, id) {
      const pr = find(id);
      const approved = pr.comments.length > 0 && answered(pr);
      return {
        ...refOf(pr),
        state: pr.state,
        author: DEMO_PR_AUTHOR,
        reviewers: [{ name: DEMO_REVIEWER, status: pr.state === 'MERGED' || approved ? 'APPROVED' : 'UNAPPROVED' }],
        comments: pr.comments.map((c) => ({ ...c, replies: [...c.replies] })),
      };
    },
    async reply(_ref, prId, commentId, text) {
      const pr = find(prId);
      const c = pr.comments.find((x) => x.id === commentId);
      if (!c) throw new Error(`Комментария ${commentId} в PR ${prId} нет`);
      c.replies.push({ id: nextComment++, author: DEMO_PR_AUTHOR, text, createdAt: new Date().toISOString() });
      if (answered(pr)) pr.answeredAt = Date.now();
    },
    comment(prId, text) {
      addComment(find(prId), text);
    },
    merge(prId) {
      find(prId).state = 'MERGED';
    },
  };
}

/** Логин владельца в демо, когда в личных настройках его нет. */
export const DEMO_ME = 'demo.owner';

/** Репозиторий учебной команды: демо направляет его профиль в учебный репозиторий во временной папке. */
export const DEMO_REPO = 'demo-calculator';

/**
 * Конфигурация демо поверх учебной команды (examples/demo): профиль калькулятора смотрит в учебный репозиторий во
 * временной папке, стенды и их логи подменные (./ci.ts), данные и входы в Claude живут в папке демо. JDK 21 берется
 * из личных настроек: его кладет в профиль калькулятора загрузка конфигурации.
 */
export function demoConfig(base: AppConfig, root: string, repo: string, port: number): AppConfig {
  const calc = base.profiles.repos.find((r) => r.id === DEMO_REPO);
  if (!calc) throw new Error(`В учебной команде нет репозитория ${DEMO_REPO}`);
  if (!calc.build?.javaHome) throw new Error('Для демо нужен JDK 21: укажите javaHome в личных настройках ~/.task-pilot/profile.yaml');
  const profile: RepoProfile = { ...calc, path: repo, worktreesDir: join(root, 'worktrees') };
  const jira = { ...base.profiles.jira, me: base.profiles.jira.me || DEMO_ME };
  return {
    ...base,
    dataDir: join(root, 'data'),
    // База демо живет до следующего запуска демо, копии ей не нужны.
    backupsDir: null,
    // Входы в Claude через браузер демо живут во временной папке демо, а не рядом с аккаунтами рабочего экземпляра.
    claudeAccountsDir: join(root, 'claude-accounts'),
    port,
    // В демо PR мержится, а подменный Bamboo собирает и деплоит за секунды: наблюдатель смотрит чаще, чтобы это было видно сразу.
    watchMs: 5_000,
    watchFastMs: 2_000,
    profiles: { ...base.profiles, repos: [profile], stands: DEMO_STANDS, logs: DEMO_LOGS, jira },
  };
}
