/**
 * Смоук интерфейса: pnpm smoke, его же запускает хук перед коммитом после pnpm check. Демо со сценарным агентом
 * поднимается во временной папке на своих портах, собранный интерфейс отдает vite preview, а headless Chrome
 * открывает главные экраны, страницу прогона, экраны мониторинга с путем одной попытки, панели шапки и панель правки
 * мониторинга и ищет ошибки: исключения страницы, ошибки в консоли,
 * запросы API с ошибкой, плашки ошибок и пустые экраны. Без Chrome смоук пропускается. Код выхода 1 - на каком-то
 * экране ошибка.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './config.ts';
import { api, freePort, launch, startDemo, waitFor, type Child } from './demo/harness.ts';
import { qaBrowserOptions } from './qa/browser.ts';

/** Экраны, которые открывает смоук: подпись и адрес после #. */
export const SMOKE_ROUTES: [string, string][] = [
  ['Задачи', '/'],
  ['Стенды', '/stands'],
  ['Мониторинг', '/monitor'],
  ['Фича входа', '/monitor/features/confirm'],
  ['Дашборд задачи', '/monitor/demo-2-division'],
  ['Каталог шагов', '/catalog'],
  ['Пресеты', '/presets'],
  ['История', '/history'],
  ['Интеграции', '/integrations'],
  ['Окружение', '/environment'],
  ['Служебное', '/service'],
];

/** Панели, которые смоук открывает кликом: подпись, экран и селектор кнопки (шапка - на доске задач). */
export const SMOKE_PANELS: [string, string, string][] = [
  ['Профиль', '/', '[data-profile]'],
  ['Уведомления', '/', '[aria-label^="Уведомления"]'],
  ['Изменить по запросу', '/monitor/demo-2-division', '[data-edit]'],
];

/** Что страница показала и что случилось, пока она открывалась. */
export interface PageFacts {
  exceptions: string[];
  consoleErrors: string[];
  /** Ответы API со статусом 400 и выше: адрес и статус. */
  apiErrors: string[];
  /** Тексты плашек ошибок (role="alert"). */
  alerts: string[];
  /** Сколько текста на экране. */
  textLength: number;
}

/**
 * Ошибки браузера, которые смоук не считает ошибками экрана: обрыв потока событий при уходе со страницы и запрос
 * значка сайта, который браузер делает сам.
 */
const NOISE = /\/api\/events|ERR_ABORTED|\/favicon\.ico/;

/** Проблемы экрана по тому, что о нем известно; пустой список - экран в порядке. */
export function pageProblems(f: PageFacts): string[] {
  return [
    ...f.exceptions.map((e) => `исключение: ${e}`),
    ...f.consoleErrors.filter((e) => !NOISE.test(e)).map((e) => `ошибка в консоли: ${e}`),
    ...f.apiErrors.map((e) => `API: ${e}`),
    ...f.alerts.map((a) => `плашка ошибки: ${a}`),
    ...(f.textLength < 30 ? ['пустой экран'] : []),
  ];
}

/** Короткий клиент протокола отладки Chrome: команды и события одной вкладки. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  private readonly listeners: ((method: string, params: Record<string, unknown>) => void)[] = [];
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      else if (msg.method) for (const l of this.listeners) l(msg.method, msg.params ?? {});
    });
  }

  static async connect(port: number): Promise<Cdp> {
    for (let i = 0; i < 100; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        const page = list.find((t) => t.type === 'page');
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
          });
          return new Cdp(ws);
        }
      } catch {
        // Chrome еще запускается.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Chrome не открыл порт отладки');
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => {
        this.pending.delete(id);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolve(m.result as T);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener: (method: string, params: Record<string, unknown>) => void): void {
    this.listeners.push(listener);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true });
    return r.result.value;
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Открывает экран и ждет, пока загрузки на нем кончатся. */
async function visit(cdp: Cdp, facts: PageFacts, url: string): Promise<void> {
  await cdp.send('Page.navigate', { url });
  await settle(cdp, facts);
}

/** Ждет, пока загрузки на экране кончатся (нет крутилок), не дольше 15 секунд, и записывает плашки ошибок и объем текста. */
async function settle(cdp: Cdp, facts: PageFacts): Promise<void> {
  const deadline = Date.now() + 15_000;
  let quiet = 0;
  while (Date.now() < deadline && quiet < 3) {
    await sleep(250);
    const busy = await cdp.evaluate<boolean>("document.readyState !== 'complete' || !!document.querySelector('.animate-spin')");
    quiet = busy ? 0 : quiet + 1;
  }
  const page = await cdp.evaluate<{ alerts: string[]; text: number }>(
    "({ alerts: [...document.querySelectorAll('[role=alert]')].map((e) => e.innerText.slice(0, 200)), text: document.body.innerText.trim().length })",
  );
  facts.alerts = page.alerts;
  facts.textLength = page.text;
}

async function main(): Promise<number> {
  const chrome = qaBrowserOptions(join(ROOT, '.data'), process.env).chrome;
  if (!existsSync(chrome)) {
    console.log(`Смоук интерфейса пропущен: нет Chrome (${chrome}), путь задает TASK_PILOT_CHROME`);
    return 0;
  }
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
    console.error('Смоук интерфейса: нет собранного интерфейса, сначала pnpm build:web');
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), 'task-pilot-smoke-'));
  const [apiPort, webPort, cdpPort] = [await freePort(), await freePort(), await freePort()];
  const children: Child[] = [];
  let cdp: Cdp | null = null;
  const started = Date.now();
  try {
    children.push(await startDemo({ root, port: apiPort, scripted: true }));
    const web = launch(process.execPath, [join(ROOT, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--port', String(webPort), '--strictPort'], {
      cwd: join(ROOT, 'apps/web'),
      env: { ...process.env, TASK_PILOT_API: `http://127.0.0.1:${apiPort}` },
    });
    children.push(web);
    await waitFor(`http://127.0.0.1:${webPort}/`, 30_000, web);
    const run = await api<{ id: string }>(apiPort, 'POST', '/api/tasks/DEMO-1/open', {});
    // Путь одной операции учебной фичи: попытка находится поиском по стадии, как ее найдет владелец.
    const found = await api<{ attempts: { key: string | null; at: number }[] }>(apiPort, 'POST', '/api/monitor/attempts/search', { ids: [], sign: 'feature:confirm:passed' });
    const attempt = found.attempts.find((a) => a.key);
    const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(root, 'chrome')}`, '--window-size=1400,1000', 'about:blank'], {
      stdio: 'ignore',
    });
    children.push({ process: browser, output: () => '', stop: async () => void browser.kill('SIGKILL') });
    cdp = await Cdp.connect(cdpPort);
    let facts: PageFacts = { exceptions: [], consoleErrors: [], apiErrors: [], alerts: [], textLength: 0 };
    cdp.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails as { text?: string; exception?: { description?: string } };
        facts.exceptions.push((d.exception?.description ?? d.text ?? 'исключение').split('\n')[0]!);
      }
      if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        facts.consoleErrors.push((p.args as { value?: unknown; description?: string }[]).map((a) => String(a.value ?? a.description ?? '')).join(' '));
      }
      if (method === 'Log.entryAdded') {
        const e = p.entry as { level: string; text: string; url?: string };
        if (e.level === 'error') facts.consoleErrors.push(`${e.text}${e.url ? ` (${e.url})` : ''}`);
      }
      if (method === 'Network.responseReceived') {
        const r = p.response as { url: string; status: number };
        if (r.url.includes('/api/') && r.status >= 400) facts.apiErrors.push(`${r.status} ${new URL(r.url).pathname}`);
      }
    });
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable'), cdp.send('Network.enable')]);
    const routes: [string, string][] = [...SMOKE_ROUTES, ['Прогон DEMO-1', `/runs/${run.id}`], ...(attempt ? ([['Путь попытки', `/monitor/attempt/${attempt.key}/${attempt.at}`]] as [string, string][]) : [])];
    if (!attempt) console.log('  ✗ Путь попытки: поиск по стадии учебной фичи не нашел попыток');
    let failed = attempt ? 0 : 1;
    for (const [i, [title, route]] of routes.entries()) {
      facts = { exceptions: [], consoleErrors: [], apiErrors: [], alerts: [], textLength: 0 };
      // Своя строка запроса у каждого экрана: страница загружается заново, и ошибки прошлого экрана в этот не попадают.
      await visit(cdp, facts, `http://127.0.0.1:${webPort}/?smoke=${i}#${route}`);
      const problems = pageProblems(facts);
      if (problems.length) failed++;
      console.log(problems.length ? `  ✗ ${title}: ${problems.join('; ')}` : `  ✓ ${title}`);
    }
    for (const [i, [title, route, selector]] of SMOKE_PANELS.entries()) {
      facts = { exceptions: [], consoleErrors: [], apiErrors: [], alerts: [], textLength: 0 };
      await visit(cdp, facts, `http://127.0.0.1:${webPort}/?smoke=panel${i}#${route}`);
      const clicked = await cdp.evaluate<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); b?.click(); return !!b; })()`);
      if (clicked) await settle(cdp, facts);
      const opened = clicked && (await cdp.evaluate<boolean>("!!document.querySelector('[role=dialog]')"));
      const problems = [...(clicked ? [] : ['нет кнопки']), ...(clicked && !opened ? ['панель не открылась'] : []), ...pageProblems(facts)];
      if (problems.length) failed++;
      console.log(problems.length ? `  ✗ Панель "${title}": ${problems.join('; ')}` : `  ✓ Панель "${title}"`);
    }
    console.log(`Смоук интерфейса: экранов ${routes.length}, панелей ${SMOKE_PANELS.length}, с ошибками ${failed}, ${Math.round((Date.now() - started) / 1000)} с`);
    return failed ? 1 : 0;
  } finally {
    cdp?.close();
    for (const c of children.reverse()) await c.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error('Смоук интерфейса не прошел:', e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
