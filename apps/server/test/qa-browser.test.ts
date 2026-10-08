import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkActions, createQaBrowser, isLocalHost, QA_BROWSER_MARK, qaChromeArgs, qaUserAgent } from '../src/qa/browser.ts';

describe('actions the agent may pass to the QA browser', () => {
  it('lets through the vocabulary of the cdp.mjs driver as is', () => {
    const actions = [
      { viewport: { width: 1500, height: 1000 } },
      { navigate: 'https://gate-5.cloud.example.com/auth/realms/sso-test-realm/account', settle: 6000 },
      { waitFor: '#kc-form-login', timeout: 15000 },
      { type: { selector: '#phone', text: '9991234567' } },
      { click: 'button[type=submit]', settle: 800 },
      { eval: 'window.kcContext.pageId' },
      { shot: '01-login-select' },
      { newTab: 'https://kibana.test.example.com/app/discover' },
      { useTabUrl: 'kibana' },
      { block: ['*.js'] },
      { clearCookies: true },
    ];
    expect(checkActions(actions)).toEqual(actions);
  });

  it('refuses keys the driver does not know, so raw CDP commands cannot get through', () => {
    expect(() => checkActions([{ send: 'Target.createBrowserContext' }])).toThrow('Действие 1: неизвестные ключи send');
    expect(() => checkActions([{ navigate: 'https://a.example.org', method: 'x' }])).toThrow('неизвестные ключи method');
  });

  it('opens only http and https addresses outside this machine', () => {
    expect(() => checkActions([{ navigate: 'file:///Users/owner/.claude.json' }])).toThrow('разрешены только адреса http и https');
    expect(() => checkActions([{ newTab: 'chrome://settings' }])).toThrow('разрешены только адреса http и https');
    expect(() => checkActions([{ navigate: 'http://127.0.0.1:5177/' }])).toThrow('адреса этой машины из QA-браузера не открываются');
    expect(() => checkActions([{ navigate: 'http://localhost:5176/api/health' }])).toThrow('адреса этой машины');
    expect(() => checkActions([{ navigate: 'http://[::1]:5176/' }])).toThrow('адреса этой машины');
    expect(checkActions([{ navigate: 'about:blank' }])).toHaveLength(1);
  });

  it('keeps screenshot names inside the artifacts folder', () => {
    expect(() => checkActions([{ shot: '../../../.ssh/id' }])).toThrow('имя скриншота');
    expect(() => checkActions([{ shot: 'a/b' }])).toThrow('имя скриншота');
    expect(() => checkActions([{ shot: 'x..png' }])).toThrow('имя скриншота');
    expect(checkActions([{ shot: 'kibana-logs-01_captcha' }])).toHaveLength(1);
  });

  it('asks for a non-empty and bounded list of objects', () => {
    expect(() => checkActions([])).toThrow('непустой список');
    expect(() => checkActions([['navigate']])).toThrow('нужен объект');
    expect(() => checkActions(Array.from({ length: 61 }, () => ({ wait: 1 })))).toThrow('Не больше 60');
  });

  it('knows every spelling of this machine', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]', '::1']) expect(isLocalHost(h)).toBe(true);
    for (const h of ['gate-5.cloud.example.com', 'kibana.test.example.com', '10.0.0.1']) expect(isLocalHost(h)).toBe(false);
  });
});

describe('QA browser', () => {
  const profileDir = () => join(mkdtempSync(join(tmpdir(), 'task-pilot-qa-')), 'qa-chrome');

  /** Chrome на порту: null - никто не отвечает; иначе User-Agent, который он сообщает. */
  function fakeChrome(answers: (string | null)[]) {
    let i = 0;
    const fetch = (async () => {
      const ua = answers[Math.min(i++, answers.length - 1)];
      if (ua === null) throw new Error('ECONNREFUSED');
      return Response.json({ Browser: 'Chrome/154.0.8037.58', 'User-Agent': ua });
    }) as typeof globalThis.fetch;
    return fetch;
  }

  it('marks its User-Agent and runs on its own port and profile', () => {
    const ua = qaUserAgent('154');
    expect(ua).toContain('Chrome/154.0.0.0');
    expect(ua.endsWith(QA_BROWSER_MARK)).toBe(true);
    expect(qaChromeArgs({ port: 9343, profileDir: '/data/qa-chrome' }, ua)).toEqual(
      expect.arrayContaining(['--remote-debugging-port=9343', '--user-data-dir=/data/qa-chrome', `--user-agent=${ua}`]),
    );
  });

  it('starts its Chrome when nothing answers on the port and waits for it', async () => {
    const launched: string[][] = [];
    const browser = createQaBrowser({
      chrome: '/Applications/Chrome',
      port: 9343,
      profileDir: profileDir(),
      scriptsDir: '/skill/scripts',
      fetch: fakeChrome([null, null, `Chrome ${QA_BROWSER_MARK}`]),
      launch: (command, args) => launched.push([command, ...args]),
      run: async () => ({ code: 0, stdout: 'Google Chrome 154.0.8037.58\n', stderr: '' }),
    });
    expect(await browser.ensure()).toEqual({ started: true });
    expect(launched).toHaveLength(1);
    expect(launched[0]![0]).toBe('/Applications/Chrome');
    expect(launched[0]!.some((a) => a.startsWith('--user-agent=') && a.endsWith(QA_BROWSER_MARK))).toBe(true);
  });

  it('reuses its running Chrome and refuses a foreign one on the same port', async () => {
    const options = { chrome: '/c', port: 9343, profileDir: profileDir(), scriptsDir: '/s', launch: () => undefined, run: async () => ({ code: 0, stdout: '', stderr: '' }) };
    expect(await createQaBrowser({ ...options, fetch: fakeChrome([`Chrome ${QA_BROWSER_MARK}`]) }).ensure()).toEqual({ started: false });
    await expect(createQaBrowser({ ...options, fetch: fakeChrome(['Mozilla/5.0 Chrome/154']) }).ensure()).rejects.toThrow('На порту 9343 отвечает Chrome, который запустил не Task Pilot');
  });

  it('runs the skill driver with only the port, the screenshot folder and a minimal environment', async () => {
    const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
    process.env.TASK_PILOT_SECRET_FOR_TEST = 'nope';
    try {
      const browser = createQaBrowser({
        chrome: '/c',
        port: 9343,
        profileDir: profileDir(),
        scriptsDir: '/skill/scripts',
        run: async (file, args, env) => {
          calls.push({ file, args, env });
          return { code: 0, stdout: 'shot 01-login\n', stderr: '' };
        },
      });
      const shots = mkdtempSync(join(tmpdir(), 'task-pilot-shots-'));
      expect(await browser.act([{ shot: '01-login' }], shots)).toBe('shot 01-login\n');
      expect(calls[0]!.args).toEqual(['/skill/scripts/cdp.mjs', '[{"shot":"01-login"}]']);
      expect(calls[0]!.env).toMatchObject({ CDP_PORT: '9343', SHOT_DIR: shots });
      expect(Object.keys(calls[0]!.env).sort()).toEqual(['CDP_PORT', 'HOME', 'PATH', 'SHOT_DIR']);
    } finally {
      delete process.env.TASK_PILOT_SECRET_FOR_TEST;
    }
  });

  it('does not start the driver for actions it refuses and reports a failing driver with the end of its output', async () => {
    let runs = 0;
    const browser = createQaBrowser({
      chrome: '/c',
      port: 9343,
      profileDir: profileDir(),
      scriptsDir: '/s',
      run: async () => {
        runs++;
        return { code: 1, stdout: '', stderr: 'Error: waitFor timeout: #kc-form-login' };
      },
    });
    await expect(browser.act([{ navigate: 'file:///etc/passwd' }], tmpdir())).rejects.toThrow('разрешены только адреса http и https');
    expect(runs).toBe(0);
    await expect(browser.act([{ waitFor: '#kc-form-login' }], tmpdir())).rejects.toThrow('cdp.mjs завершился с кодом 1: Error: waitFor timeout: #kc-form-login');
  });

  it('passes a time window or the last minutes and always the target of the export to the log script', async () => {
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    const browser = createQaBrowser({
      chrome: '/c',
      port: 9343,
      profileDir: profileDir(),
      scriptsDir: '/s',
      run: async (_file, args, env) => {
        calls.push({ args, env });
        return { code: 0, stdout: '10:00:01.000 INFO Gate | ok', stderr: '' };
      },
    });
    const target = { index: 'mon-*', container: 'app', namespace: 'testing-1', messageField: 'message', loggerField: 'logger', containerField: 'k8s.container', namespaceField: 'k8s.ns', timeField: 'ts' };
    await browser.kibanaLogs({ minutes: 30, phrases: ['state-1'], target });
    await browser.kibanaLogs({ from: '2026-09-23T10:00:00Z', to: '2026-09-23T10:10:00Z', phrases: [], target: { ...target, namespace: '' } });
    expect(calls[0]!.args).toEqual(['/s/kibana_logs.mjs', '30', 'state-1']);
    expect(calls[1]!.args).toEqual(['/s/kibana_logs.mjs', '0']);
    expect(calls[1]!.env).toMatchObject({ RANGE_GTE: '2026-09-23T10:00:00Z', RANGE_LTE: '2026-09-23T10:10:00Z' });
    // Умолчаний у скрипта нет: индекс, контейнер, namespace и поля записи задает сервер.
    expect(calls[0]!.env).toMatchObject({ KIBANA_INDEX: 'mon-*', KIBANA_CONTAINER: 'app', KIBANA_NAMESPACE: 'testing-1', KIBANA_MESSAGE: 'message', KIBANA_LOGGER: 'logger', KIBANA_CONTAINER_FIELD: 'k8s.container', KIBANA_NAMESPACE_FIELD: 'k8s.ns', KIBANA_TIME_FIELD: 'ts' });
    expect(calls[1]!.env).toMatchObject({ KIBANA_NAMESPACE: '' });
  });

  it('passes the index, the container, the namespace and the fields of a service to the log export', async () => {
    const calls: Record<string, string>[] = [];
    const browser = createQaBrowser({
      chrome: '/c',
      port: 9343,
      profileDir: profileDir(),
      scriptsDir: '/s',
      run: async (_file, _args, env) => {
        calls.push(env);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await browser.kibanaLogs({ minutes: 10, phrases: [], target: { index: 'core-k8s-*', container: 'mobile', namespace: 'stable', messageField: 'messagetext', loggerField: 'logger', containerField: 'kubernetes.container.name', namespaceField: 'kubernetes.namespace.keyword', timeField: '@timestamp' } });
    expect(calls[0]).toMatchObject({ KIBANA_INDEX: 'core-k8s-*', KIBANA_CONTAINER: 'mobile', KIBANA_NAMESPACE: 'stable', KIBANA_MESSAGE: 'messagetext', KIBANA_LOGGER: 'logger' });
  });
});
