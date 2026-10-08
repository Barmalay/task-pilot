import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserPort } from '@task-pilot/step-kit';

/** Драйвер QA-браузера Task Pilot: cdp.mjs, выгрузка логов kibana_logs.mjs и вспомогательные скрипты. */
export const DRIVER_DIR = fileURLToPath(new URL('./driver', import.meta.url));

/**
 * Метка QA-браузера в User-Agent. Chrome ставит ее во все запросы, и код страницы не может ее убрать, поэтому
 * сервер Task Pilot отклоняет запросы с ней: агент, который ведет QA-браузер, не откроет в нем интерфейс
 * Task Pilot и не подтвердит сам свой шаг.
 */
export const QA_BROWSER_MARK = 'TaskPilotQA';

/** Настройки QA-браузера Task Pilot. */
export interface QaBrowserOptions {
  /** Исполняемый файл Chrome. */
  chrome: string;
  /** Порт CDP; на нем не должно быть чужого Chrome. */
  port: number;
  /** Профиль браузера: живет между прогонами и лежит в служебной папке, которую агенту читать нельзя. */
  profileDir: string;
  /** Папка драйвера: cdp.mjs и выгрузка логов kibana_logs.mjs. */
  scriptsDir: string;
  /** Для тестов: запуск Chrome и скриптов, запросы к CDP. */
  launch?: (command: string, args: string[]) => void;
  run?: (file: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetch?: typeof fetch;
}

/** Ключи действий драйвера cdp.mjs. Сырых команд CDP в нем нет, и других ключей агенту не передать. */
const ACTION_KEYS = new Set([
  'navigate',
  'settle',
  'wait',
  'waitFor',
  'timeout',
  'click',
  'type',
  'eval',
  'shot',
  'viewport',
  'clearCookies',
  'cookies',
  'block',
  'unblock',
  'newTab',
  'useTab',
  'useTabUrl',
  'useTabTitle',
  'useTabWhere',
  'mark',
  'listTabs',
  'closeTabUrl',
  'log',
]);

const MAX_OUTPUT = 20_000;

/** Адрес указывает на эту машину: localhost, петлевой IP, 0.0.0.0 или ::1. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0' || h === '::1' || h === '::';
}

function checkUrl(value: unknown, what: string): void {
  if (typeof value !== 'string') throw new Error(`${what}: нужен адрес строкой`);
  if (value === 'about:blank') return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what}: неверный адрес ${value.slice(0, 100)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${what}: разрешены только адреса http и https, а не ${url.protocol}`);
  if (isLocalHost(url.hostname)) throw new Error(`${what}: адреса этой машины из QA-браузера не открываются`);
}

/**
 * Проверяет действия агента для драйвера cdp.mjs: только ключи его словаря, переходы только на http и https не
 * на эту машину, имя скриншота без путей. Возвращает те же действия.
 */
export function checkActions(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Нужен непустой список действий');
  if (raw.length > 60) throw new Error('Не больше 60 действий за один вызов');
  return raw.map((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(`Действие ${i + 1}: нужен объект`);
    const action = a as Record<string, unknown>;
    const unknown = Object.keys(action).filter((k) => !ACTION_KEYS.has(k));
    if (unknown.length) throw new Error(`Действие ${i + 1}: неизвестные ключи ${unknown.join(', ')}`);
    if ('navigate' in action) checkUrl(action.navigate, `Действие ${i + 1}, navigate`);
    if ('newTab' in action) checkUrl(action.newTab, `Действие ${i + 1}, newTab`);
    if ('shot' in action && (typeof action.shot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(action.shot) || action.shot.includes('..'))) {
      throw new Error(`Действие ${i + 1}: имя скриншота только из латиницы, цифр, точки, дефиса и подчеркивания, без расширения`);
    }
    return action;
  });
}

/** User-Agent QA-браузера: обычный Chrome этой версии с меткой Task Pilot в конце. */
export function qaUserAgent(chromeMajor: string): string {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36 ${QA_BROWSER_MARK}`;
}

/** Флаги запуска QA-браузера: свой порт CDP, свой профиль и User-Agent с меткой. */
export function qaChromeArgs(o: Pick<QaBrowserOptions, 'port' | 'profileDir'>, userAgent: string): string[] {
  return [
    `--remote-debugging-port=${o.port}`,
    `--user-data-dir=${o.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-agent=${userAgent}`,
    '--window-size=1280,900',
    'about:blank',
  ];
}

function tail(text: string, size = 1500): string {
  return text.length > size ? `...${text.slice(-size)}` : text;
}

function runFile(file: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Настройки QA-браузера из окружения: TASK_PILOT_QA_PORT (9343), TASK_PILOT_CHROME (Chrome из Applications),
 * TASK_PILOT_QA_SCRIPTS (драйвер, по умолчанию apps/server/src/qa/driver). Профиль лежит в служебной папке Task Pilot.
 */
export function qaBrowserOptions(dataDir: string, env: NodeJS.ProcessEnv, defaultPort = 9343): QaBrowserOptions {
  return {
    chrome: env.TASK_PILOT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    port: Number(env.TASK_PILOT_QA_PORT ?? defaultPort),
    profileDir: join(dataDir, 'qa-chrome'),
    scriptsDir: env.TASK_PILOT_QA_SCRIPTS ?? DRIVER_DIR,
  };
}

/** QA-браузер поверх Chrome и драйвера cdp.mjs. */
export function createQaBrowser(o: QaBrowserOptions): BrowserPort {
  const doFetch = o.fetch ?? fetch;
  const launch = o.launch ?? ((command, args) => spawn(command, args, { detached: true, stdio: 'ignore' }).unref());
  const run = o.run ?? runFile;
  // Скриптам не нужно окружение сервера: только PATH, домашняя папка и порт.
  const env = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', CDP_PORT: String(o.port), ...extra });

  async function version(): Promise<{ 'User-Agent'?: string } | null> {
    try {
      const r = await doFetch(`http://127.0.0.1:${o.port}/json/version`, { signal: AbortSignal.timeout(2000) });
      return r.ok ? ((await r.json()) as { 'User-Agent'?: string }) : null;
    } catch {
      return null;
    }
  }

  async function script(name: string, args: string[], extra: Record<string, string>, timeoutMs: number): Promise<string> {
    const r = await run(process.execPath, [join(o.scriptsDir, name), ...args], env(extra), timeoutMs);
    if (r.code !== 0) throw new Error(`${name} завершился с кодом ${r.code}: ${tail((r.stderr || r.stdout).trim()) || 'без вывода'}`);
    return r.stdout.length > MAX_OUTPUT ? `${r.stdout.slice(0, MAX_OUTPUT)}\n...вывод обрезан` : r.stdout;
  }

  return {
    port: o.port,

    async ensure() {
      const running = await version();
      if (running) {
        if (!running['User-Agent']?.includes(QA_BROWSER_MARK)) {
          throw new Error(`На порту ${o.port} отвечает Chrome, который запустил не Task Pilot: закройте его, QA-браузер Task Pilot запустится сам`);
        }
        return { started: false };
      }
      mkdirSync(o.profileDir, { recursive: true });
      const probe = await run(o.chrome, ['--version'], env({}), 15_000);
      const major = /(\d+)\./.exec(probe.stdout)?.[1];
      if (probe.code !== 0 || !major) throw new Error(`Не удалось узнать версию Chrome ${o.chrome}: ${tail(probe.stderr || probe.stdout) || `код ${probe.code}`}`);
      launch(o.chrome, qaChromeArgs(o, qaUserAgent(major)));
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await version()) return { started: true };
      }
      throw new Error(`QA-браузер не ответил на порту ${o.port} за 15 секунд`);
    },

    async running() {
      return (await version()) !== null;
    },

    async act(actions, shotDir) {
      const list = checkActions(actions);
      mkdirSync(shotDir, { recursive: true });
      return script('cdp.mjs', [JSON.stringify(list)], { SHOT_DIR: shotDir }, 5 * 60_000);
    },

    async kibanaLogs(q) {
      const range: Record<string, string> = q.from && q.to ? { RANGE_GTE: q.from, RANGE_LTE: q.to } : {};
      // Откуда выгрузка: индекс, контейнер, namespace стенда и поля записи всегда задает сервер, у скрипта умолчаний нет.
      const target: Record<string, string> = {
        KIBANA_INDEX: q.target.index,
        KIBANA_CONTAINER: q.target.container,
        KIBANA_NAMESPACE: q.target.namespace,
        KIBANA_MESSAGE: q.target.messageField,
        KIBANA_LOGGER: q.target.loggerField,
        KIBANA_CONTAINER_FIELD: q.target.containerField,
        KIBANA_NAMESPACE_FIELD: q.target.namespaceField,
        KIBANA_TIME_FIELD: q.target.timeField,
      };
      const minutes = q.from && q.to ? '0' : String(Math.max(1, Math.min(q.minutes ?? 15, 24 * 60)));
      return script('kibana_logs.mjs', [minutes, ...q.phrases], { ...range, ...target }, 2 * 60_000);
    },
  };
}
