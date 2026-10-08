import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isJavaBuild } from '@task-pilot/step-kit';
import { BACKUP_EVERY_MS, listBackups, type Backup } from './backup.ts';
import { pluginSkills, type AppConfig } from './config.ts';
import type { DoctorCheckDto, DoctorLevel } from '@task-pilot/api-types';
import { createClaudeCli, type ClaudeAuthStatus } from './integrations/claude-cli.ts';
import { integrationDefs, unpinnedMcp } from './integrations/registry.ts';
import { seatbeltSandbox, type Sandbox } from './integrations/sandbox.ts';
import { qaBrowserOptions } from './qa/browser.ts';
import { activeIntegrationsIn } from './store/db.ts';

/** Скиллы плагина агентов, без которых шаги теста на стенде и вики не работают: их называет team.yaml пакета команды. */
export function requiredSkills(config: Pick<AppConfig, 'team'>): string[] {
  const m = config.team.manifest;
  return [...new Set([m.qa?.skill, m.wiki?.skill].filter((s): s is string => !!s))];
}
/** Размер профиля QA-браузера, после которого стоит почистить его кэш. */
const QA_PROFILE_LIMIT = 1024 ** 3;

/** Итог запуска программы: код выхода (null - программы нет или она не запустилась) и вывод, stdout и stderr вместе. */
export interface ExecResult {
  code: number | null;
  output: string;
}

/** Что проверка узнала о машине: версии программ, файлы и размеры. Оценка по ним - чистая функция doctorChecks. */
export interface Facts {
  platform: NodeJS.Platform;
  node: string;
  /** Нужная версия Node из engines package.json: наименьшая основная. */
  nodeWanted: number;
  pnpm: string | null;
  /** Нужная версия pnpm из packageManager package.json. */
  pnpmWanted: string | null;
  git: string | null;
  /** git config credential.helper; null - не задан. */
  gitCredentialHelper: string | null;
  /** core.hooksPath репозитория Task Pilot. */
  hooksPath: string | null;
  /** Первая строка mvn -v; null - Maven не запускается. */
  mvn: string | null;
  /** Основная версия java по каждому JDK профилей: null - java из этой папки не запускается. */
  jdks: Record<string, number | null>;
  claude: { exists: boolean; version: string | null; auth: ClaudeAuthStatus | null; authError: string | null };
  /** Песочница команд сборки на этой машине: есть ли она и чего не хватает. */
  sandbox: { available: boolean; missing: string };
  chrome: { path: string; exists: boolean };
  /** Есть ли git-клон по пути каждого профиля репозитория. */
  clones: Record<string, boolean>;
  /** Интеграции, доступ к которым идет аккаунтом с экрана "Интеграции", а не из ~/.claude.json. */
  tokenIntegrations: string[];
  personalExists: boolean;
  plugin: { manifest: boolean; skills: string[] };
  /** Размеры в байтах; null - не посчитать. */
  sizes: { db: number | null; agents: number | null; qaProfile: number | null };
  backups: Backup[];
  now: Date;
}

const mb = (bytes: number | null) => (bytes === null ? '?' : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} МБ`);
const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';

/** Основная версия Java из вывода java -version: `version "21.0.12"` - 21, `version "1.8.0_392"` - 8. */
export function javaMajor(output: string): number | null {
  const v = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!v) return null;
  return v[1] === '1' && v[2] ? Number(v[2]) : Number(v[1]);
}

/** Размер в байтах из вывода du -sk. */
export function parseDu(output: string): number | null {
  const kb = /^(\d+)\s/.exec(output.trim());
  return kb ? Number(kb[1]) * 1024 : null;
}

const check = (id: string, title: string, level: DoctorLevel, detail: string, fix: string | null = null): DoctorCheckDto => ({ id, title, level, detail, fix });

/**
 * Итоги проверок по фактам о машине. fail - Task Pilot или важная часть цикла не заработает, warn - работает не все,
 * ok - в порядке. Доступ к внешним системам здесь не проверяется: это делает экран "Интеграции".
 */
export function doctorChecks(config: AppConfig, f: Facts): DoctorCheckDto[] {
  const { profiles } = config;
  const connected = new Set(profiles.contours.filter((c) => c.connected).map((c) => c.id));
  const repos = profiles.repos.filter((r) => connected.has(r.contour));
  const javaRepos = repos.filter((r) => r.build && isJavaBuild(r.build.command));
  const out: DoctorCheckDto[] = [];

  const nodeMajor = Number(f.node.split('.')[0]);
  out.push(
    nodeMajor >= f.nodeWanted
      ? check('node', 'Node', 'ok', f.node)
      : check('node', 'Node', 'fail', `${f.node}, нужен ${f.nodeWanted} или новее`, `Поставьте Node ${f.nodeWanted}: brew install node`),
  );

  const pnpmMajor = f.pnpmWanted?.split('.')[0];
  if (!f.pnpm) out.push(check('pnpm', 'pnpm', 'fail', 'не найден', `Включите pnpm: corepack enable, нужна версия ${f.pnpmWanted ?? '10'}`));
  else if (pnpmMajor && f.pnpm.split('.')[0] !== pnpmMajor) out.push(check('pnpm', 'pnpm', 'warn', `${f.pnpm}, проект собран на ${f.pnpmWanted}`, 'corepack enable: corepack возьмет версию из packageManager'));
  else out.push(check('pnpm', 'pnpm', 'ok', f.pnpm));

  out.push(f.git ? check('git', 'git', 'ok', f.git) : check('git', 'git', 'fail', 'не найден', 'Поставьте git: xcode-select --install'));

  out.push(
    f.platform === 'darwin' && f.sandbox.available
      ? check('sandbox', 'Песочница команд', 'ok', 'macOS, sandbox-exec: сборки и команды агентов идут без сети и пишут только в свои папки')
      : check(
          'sandbox',
          'Песочница команд',
          'fail',
          f.platform === 'darwin' ? f.sandbox.missing : `${f.platform}: песочница сборок и команд агентов сейчас есть только в macOS`,
          'Запускайте Task Pilot на macOS; Linux и WSL2 - пункты 7 и 8 этапа 7',
        ),
  );

  if (!f.claude.exists) {
    out.push(check('claude', 'CLI claude', 'fail', `нет ${tilde(config.claudeCli)}`, 'Поставьте Claude Code или задайте путь к CLI в TASK_PILOT_CLAUDE'));
  } else if (f.claude.auth?.loggedIn) {
    out.push(check('claude', 'CLI claude', 'ok', `${f.claude.version ?? 'версия неизвестна'}, вход ${f.claude.auth.email ?? f.claude.auth.method ?? 'есть'}`));
  } else {
    const why = f.claude.authError ?? 'CLI не вошел в аккаунт';
    out.push(check('claude', 'CLI claude', 'warn', `${f.claude.version ?? 'версия неизвестна'}, ${why}`, 'claude auth login в терминале или аккаунт Claude на экране "Интеграции"'));
  }

  const personal = tilde(config.personalFile);
  const { team } = config;
  out.push(
    check(
      'team',
      'Пакет команды',
      'ok',
      `${team.title} (${tilde(team.dir)})${team.company ? `, слой компании ${team.company.id} (${tilde(team.company.dir)})` : ', без слоя компании'}`,
    ),
  );
  out.push(
    f.personalExists
      ? check('personal', 'Личные настройки', 'ok', personal)
      : check('personal', 'Личные настройки', 'warn', `нет ${personal}`, 'Создайте файл с логином Jira (me) и JDK 21 (javaHome), пример в docs/setup.md'),
  );
  out.push(
    profiles.jira.me
      ? check('jira-login', 'Логин Jira', 'ok', `задачи назначаются на ${profiles.jira.me}`)
      : check('jira-login', 'Логин Jira', 'warn', 'не задан: шаг "Взять в работу" откажется назначать задачу', `Укажите me в ${personal} или заведите токен Jira на экране "Интеграции"`),
  );

  if (!javaRepos.length) {
    out.push(check('jdk', 'JDK 21', 'ok', 'сборок Java нет'));
  } else {
    const problems = javaRepos.flatMap((r) => {
      const home = r.build?.javaHome;
      if (!home) return [`${r.id}: JDK не задан`];
      if (!(home in f.jdks)) return [];
      const major = f.jdks[home];
      if (major === null || major === undefined) return [`${r.id}: java не запускается из ${tilde(home)}`];
      return major === 21 ? [] : [`${r.id}: JDK ${major} вместо 21`];
    });
    const homes = [...new Set(javaRepos.map((r) => r.build?.javaHome).filter((h): h is string => !!h))];
    out.push(
      problems.length
        ? check('jdk', 'JDK 21', 'fail', problems.join('; '), `Укажите javaHome с JDK 21 в ${personal}`)
        : check('jdk', 'JDK 21', 'ok', `${homes.map(tilde).join(', ')} для ${javaRepos.map((r) => r.id).join(', ')}`),
    );
  }
  if (javaRepos.some((r) => /^(mvn|mvnw|\.\/mvnw)\b/.test(r.build?.command.trim() ?? ''))) {
    out.push(f.mvn ? check('maven', 'Maven', 'ok', f.mvn) : check('maven', 'Maven', 'fail', 'mvn не запускается', 'Поставьте Maven: brew install maven'));
  }

  const missing = repos.filter((r) => !f.clones[r.path]);
  const main = repos.find((r) => r.default);
  out.push(
    !missing.length
      ? check('repos', 'Репозитории', 'ok', `на месте все ${repos.length}`)
      : check(
          'repos',
          'Репозитории',
          main && missing.includes(main) ? 'fail' : 'warn',
          `нет клона: ${missing.map((r) => `${r.id} (${tilde(r.path)})`).join(', ')}`,
          `Склонируйте их или укажите пути в repos личных настроек ${personal}`,
        ),
  );

  const defs = integrationDefs(profiles, config.mcpServers).flatMap((d) => (d.mcp && !d.note ? [{ id: d.id, mcp: d.mcp }] : []));
  const servers = [...new Set(defs.map((d) => d.mcp))];
  const inFile = servers.filter((s) => config.mcpServers[s]);
  const byToken = [...new Set(defs.filter((d) => f.tokenIntegrations.includes(d.id)).map((d) => d.mcp))];
  const absent = servers.filter((s) => !inFile.includes(s) && !byToken.includes(s));
  const sources = [
    ...(inFile.length ? [`из ~/.claude.json: ${inFile.join(', ')}`] : []),
    ...(byToken.length ? [`токеном с экрана "Интеграции": ${byToken.join(', ')}`] : []),
  ];
  out.push(
    absent.length
      ? check('mcp', 'MCP-серверы', 'warn', [`без доступа: ${absent.join(', ')}`, ...sources].join('; '), 'Добавьте их в ~/.claude.json или заведите токены на экране "Интеграции"')
      : check('mcp', 'MCP-серверы', 'ok', sources.join('; ') || 'не нужны'),
  );
  const unpinned = unpinnedMcp(config.mcpServers);
  out.push(
    unpinned.length
      ? check('mcp-versions', 'Версии MCP-серверов', 'warn', unpinned.map((u) => `${u.server}: ${u.spec} -> ${u.pinned}`).join('; '), 'Закрепите версии в args этих серверов в ~/.claude.json')
      : check('mcp-versions', 'Версии MCP-серверов', 'ok', 'у всех известных пакетов версия закреплена'),
  );

  const lost = requiredSkills(config).filter((s) => !f.plugin.skills.includes(s));
  out.push(
    f.plugin.manifest && !lost.length
      ? check('plugin', 'Плагин агентов', 'ok', `${tilde(config.pluginDir)}: ${f.plugin.skills.join(', ') || 'скиллов шагам не нужно'}`)
      : check(
          'plugin',
          'Плагин агентов',
          'fail',
          f.plugin.manifest ? `нет скиллов из team.yaml: ${lost.join(', ')}` : `нет ${tilde(join(config.pluginDir, '.claude-plugin', 'plugin.json'))}`,
          'Верните папку plugin в пакет команды или задайте другой плагин в TASK_PILOT_PLUGIN',
        ),
  );

  out.push(
    f.chrome.exists
      ? check('chrome', 'Chrome для QA-браузера', 'ok', f.chrome.path)
      : check('chrome', 'Chrome для QA-браузера', 'warn', `нет ${f.chrome.path}: тест на стенде не запустит QA-браузер`, 'Поставьте Google Chrome или задайте путь в TASK_PILOT_CHROME'),
  );

  out.push(
    f.hooksPath === '.githooks'
      ? check('git-hooks', 'Проверка перед коммитом', 'ok', 'хук .githooks/pre-commit запускает pnpm check')
      : check('git-hooks', 'Проверка перед коммитом', 'warn', 'хуки Task Pilot выключены', 'pnpm install включит их'),
  );
  out.push(
    f.gitCredentialHelper
      ? check('git-credentials', 'Учетные данные git', 'ok', `credential.helper ${f.gitCredentialHelper}`)
      : check('git-credentials', 'Учетные данные git', 'warn', 'credential.helper не задан: fetch и push будут спрашивать пароль', 'Заведите токен Bitbucket на экране "Интеграции" или git config --global credential.helper osxkeychain'),
  );

  const last = f.backups[0];
  const stale = !last || f.now.getTime() - last.at.getTime() > 2 * BACKUP_EVERY_MS;
  const bigProfile = (f.sizes.qaProfile ?? 0) > QA_PROFILE_LIMIT;
  const detail = [
    `база ${mb(f.sizes.db)}`,
    `журналы агентов ${mb(f.sizes.agents)}`,
    `профиль QA-браузера ${mb(f.sizes.qaProfile)}`,
    last ? `копий базы ${f.backups.length}, последняя ${last.at.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'копий базы нет',
  ].join(', ');
  const fixes = [
    ...(config.backupsDir && stale ? [`Копию делает запущенный сервер раз в сутки, папка ${tilde(config.backupsDir)}`] : []),
    ...(bigProfile ? ['Закройте QA-браузер и очистите его кэш в карточке "Место на диске" на вкладке "Конвейер / История": входы на стенды останутся'] : []),
  ];
  out.push(check('data', 'Служебные данные', (config.backupsDir && stale) || bigProfile ? 'warn' : 'ok', detail, fixes.join('. ') || null));
  return out;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

const ok = (r: ExecResult) => (r.code === 0 ? firstLine(r.output) || null : null);

/** Собирает факты о машине: программы запускаются параллельно, каждая не дольше 20 секунд; песочницу спрашивает порт. */
export async function gatherFacts(config: AppConfig, now = new Date(), sandbox: Sandbox = seatbeltSandbox({ home: homedir(), dataDir: config.dataDir })): Promise<Facts> {
  const pkg = JSON.parse(readFileSync(join(config.root, 'package.json'), 'utf8')) as { engines?: { node?: string }; packageManager?: string };
  const javaHomes = [...new Set(config.profiles.repos.flatMap((r) => (r.build?.javaHome && isJavaBuild(r.build.command) ? [r.build.javaHome] : [])))];
  const javaHome = javaHomes.find((h) => existsSync(h));
  const du = async (path: string) => (existsSync(path) ? parseDu((await run('du', ['-sk', path])).output) : null);
  const chrome = qaBrowserOptions(config.dataDir, process.env).chrome;
  const claudeExists = existsSync(config.claudeCli);
  const [pnpm, git, helper, hooks, mvn, claudeVersion, auth, db, agents, qaProfile, ...jdks] = await Promise.all([
    run('pnpm', ['--version']),
    run('git', ['--version']),
    run('git', ['config', '--get', 'credential.helper']),
    run('git', ['-C', config.root, 'config', '--get', 'core.hooksPath']),
    run('mvn', ['-v'], javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env),
    claudeExists ? run(config.claudeCli, ['--version']) : Promise.resolve({ code: null, output: '' }),
    claudeExists
      ? createClaudeCli(config.claudeCli)
          .status({})
          .then((s) => ({ s, error: null }), (e: unknown) => ({ s: null, error: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve({ s: null, error: null }),
    du(join(config.dataDir, 'task-pilot.db')),
    du(join(config.dataDir, 'agent')),
    du(join(config.dataDir, 'qa-chrome')),
    ...javaHomes.map((h) => (existsSync(join(h, 'bin', 'java')) ? run(join(h, 'bin', 'java'), ['-version']) : Promise.resolve({ code: null, output: '' }))),
  ]);
  const skillsDir = pluginSkills(config.pluginDir);
  return {
    platform: process.platform,
    node: process.versions.node,
    nodeWanted: Number(/(\d+)/.exec(pkg.engines?.node ?? '')?.[1] ?? 0),
    pnpm: ok(pnpm),
    pnpmWanted: pkg.packageManager?.split('@')[1] ?? null,
    git: ok(git),
    gitCredentialHelper: ok(helper),
    hooksPath: ok(hooks),
    mvn: ok(mvn),
    jdks: Object.fromEntries(javaHomes.map((h, i) => [h, jdks[i]?.code === 0 ? javaMajor(jdks[i].output) : null])),
    claude: { exists: claudeExists, version: ok(claudeVersion), auth: auth.s, authError: auth.error },
    sandbox: { available: sandbox.available(), missing: sandbox.missing },
    chrome: { path: chrome, exists: existsSync(chrome) },
    clones: Object.fromEntries(config.profiles.repos.map((r) => [r.path, existsSync(join(r.path, '.git'))])),
    tokenIntegrations: activeIntegrationsIn(join(config.dataDir, 'task-pilot.db')),
    personalExists: existsSync(config.personalFile),
    plugin: {
      manifest: existsSync(join(config.pluginDir, '.claude-plugin', 'plugin.json')),
      skills: requiredSkills(config).filter((s) => existsSync(join(skillsDir, s, 'SKILL.md'))),
    },
    sizes: { db, agents, qaProfile },
    backups: config.backupsDir ? listBackups(config.backupsDir) : [],
    now,
  };
}

/** Проверка окружения целиком. */
export async function runDoctor(config: AppConfig): Promise<DoctorCheckDto[]> {
  return doctorChecks(config, await gatherFacts(config));
}

const MARK: Record<DoctorLevel, string> = { ok: '✓', warn: '!', fail: '✗' };

/** Итог проверок для терминала: строка на проверку, под ней как исправить, в конце сводка. */
export function formatDoctor(checks: DoctorCheckDto[]): string {
  const lines = checks.flatMap((c) => [`  ${MARK[c.level]} ${c.title}: ${c.detail}`, ...(c.fix && c.level !== 'ok' ? [`      Как исправить: ${c.fix}`] : [])]);
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const summary = fails || warns ? `Проблем: ${fails}, предупреждений: ${warns}` : 'Все в порядке';
  return ['Task Pilot: проверка окружения', '', ...lines, '', summary].join('\n');
}
