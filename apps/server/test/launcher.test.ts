import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchOptions } from '../src/launcher/control.ts';
import { busy, launchPath, restart, skipsCommand, start, status, stop } from '../src/launcher/control.ts';

/** Поддельный сервер или интерфейс: отвечает на /api/health, /api/runs и /; mode crash падает сразу, stubborn не выходит по SIGTERM. */
const FAKE = `
const http = require('node:http');
const [port, mode, runs] = process.argv.slice(1);
if (mode === 'crash') { console.error('падение при старте'); process.exit(1); }
if (mode === 'stubborn') process.on('SIGTERM', () => {});
http.createServer((req, res) => {
  if (req.url === '/api/runs') { res.setHeader('content-type', 'application/json'); res.end(runs || '[]'); return; }
  res.end(req.url === '/api/health' ? '{"ok":true}' : 'ok');
}).listen(Number(port), '127.0.0.1', () => console.log('listening ' + port));
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(modes: { server?: string; web?: string; runs?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-'));
  const [serverPort, webPort] = [await freePort(), await freePort()];
  const fake = (port: number, mode = 'ok', runs = '') => ({ command: [process.execPath, '-e', FAKE, String(port), mode, runs], cwd: dir });
  const o: LaunchOptions = {
    data: join(dir, 'data'),
    env: process.env,
    server: fake(serverPort, modes.server, modes.runs),
    web: fake(webPort, modes.web),
    api: `http://127.0.0.1:${serverPort}/api`,
    ui: `http://127.0.0.1:${webPort}/`,
    readyTimeoutMs: 10_000,
    stopTimeoutMs: 1000,
  };
  cleanups.push(() => stop(o));
  const state = () => JSON.parse(readFileSync(join(o.data, 'launcher.json'), 'utf8')) as Record<'server' | 'web', { pgid: number; started: string }>;
  return { o, dir, serverPort, webPort, state };
}

/** Процесс, запущенный не через start: его нельзя трогать. */
function foreign(args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  cleanups.push(() => child.pid && alive(child.pid) && process.kill(child.pid, 'SIGKILL'));
  return child;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('не дождались');
}

const responds = (url: string) => fetch(url).then((r) => r.ok, () => false);

describe('launcher of the Dock app', () => {
  it('starts the server and the interface as leaders of their own process groups, reports them as its own and stops them', async () => {
    const { o, state } = await setup();
    expect(await start(o)).toBe('started');
    const { server, web } = state();
    for (const pgid of [server.pgid, web.pgid]) {
      expect(execFileSync('ps', ['-o', 'pgid=', '-p', String(pgid)], { encoding: 'utf8' }).trim()).toBe(String(pgid));
    }
    expect(await status(o)).toBe('running:ours');
    expect(await start(o)).toBe('running:ours');
    expect(state().server.pgid).toBe(server.pgid);

    expect(await stop(o)).toBe('stopped');
    expect([alive(server.pgid), alive(web.pgid)]).toEqual([false, false]);
    expect(await status(o)).toBe('stopped');
    expect(existsSync(join(o.data, 'launcher.json'))).toBe(false);
    expect(readFileSync(join(o.data, 'launcher.log'), 'utf8')).toContain('listening');
  });

  it('reports an instance started another way as external and never stops it', async () => {
    const { o, serverPort, webPort } = await setup();
    const running = [foreign(['-e', FAKE, String(serverPort)]), foreign(['-e', FAKE, String(webPort)])];
    await until(async () => (await responds(`${o.api}/health`)) && (await responds(o.ui)));

    expect(await start(o)).toBe('running:external');
    expect(await status(o)).toBe('running:external');
    expect(await stop(o)).toBe('not-running');
    expect(running.map((c) => alive(c.pid!))).toEqual([true, true]);
  });

  it('does not treat a process that got the saved pid at another time as its own and leaves it alive', async () => {
    const { o } = await setup();
    const other = foreign(['-e', 'setInterval(() => {}, 1000)']);
    await until(async () => alive(other.pid!));
    const stale = { pgid: other.pid, started: 'Mon Jan  1 00:00:00 2024' };
    mkdirSync(o.data, { recursive: true });
    writeFileSync(join(o.data, 'launcher.json'), JSON.stringify({ server: stale, web: stale }));

    expect(await status(o)).toBe('stopped');
    expect(await stop(o)).toBe('not-running');
    expect(alive(other.pid!)).toBe(true);
    expect(existsSync(join(o.data, 'launcher.json'))).toBe(false);
  });

  it('fails with the end of the log and stops the interface when the server exits during start', async () => {
    const { o } = await setup({ server: 'crash' });
    await expect(start(o)).rejects.toThrow(/Сервер завершился при запуске\. Журнал: .*launcher\.log[\s\S]*падение при старте/);
    expect(await responds(o.ui)).toBe(false);
    expect(existsSync(join(o.data, 'launcher.json'))).toBe(false);
    expect(await status(o)).toBe('stopped');
  });

  it('keeps the previous log when it starts again', async () => {
    const { o } = await setup();
    await start(o);
    await stop(o);
    await start(o);
    expect(readFileSync(join(o.data, 'launcher.prev.log'), 'utf8')).toContain('listening');
  });

  it('kills a process that ignores SIGTERM once the stop timeout is over', async () => {
    const { o, state } = await setup({ server: 'stubborn' });
    expect(await start(o)).toBe('started');
    const { server } = state();
    expect(await stop(o)).toBe('stopped');
    expect(alive(server.pgid)).toBe(false);
  });

  it('restarts its own processes and keeps reporting Task Pilot as its own all the way through', async () => {
    // Сервер не выходит по SIGTERM: перезапуск длится несколько секунд, и status успевает опроситься много раз.
    const { o, state } = await setup({ server: 'stubborn' });
    await start(o);
    const before = state();
    const seen = new Set<string>();
    let restarting = true;
    const watch = (async () => {
      while (restarting) {
        seen.add(await status(o));
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    expect(await restart(o)).toBe('started');
    restarting = false;
    await watch;
    expect([...seen]).toEqual(['running:ours']);
    const after = state();
    expect(after).not.toHaveProperty('restarting');
    expect(after.server.pgid).not.toBe(before.server.pgid);
    expect([alive(before.server.pgid), alive(before.web.pgid)]).toEqual([false, false]);
    expect(await status(o)).toBe('running:ours');
  });

  it('refuses to restart while a run is executing and leaves Task Pilot running', async () => {
    const { o, state } = await setup({ runs: JSON.stringify([{ status: 'running' }]) });
    await start(o);
    const before = state();
    await expect(restart(o)).rejects.toThrow('Выполняется прогонов: 1. Перезапуск прервал бы их шаги');
    expect(state()).toEqual(before);
    expect(await status(o)).toBe('running:ours');
  });

  it('does not restart an instance started another way', async () => {
    const { o, serverPort, webPort } = await setup();
    const running = [foreign(['-e', FAKE, String(serverPort)]), foreign(['-e', FAKE, String(webPort)])];
    await until(async () => (await responds(`${o.api}/health`)) && (await responds(o.ui)));
    expect(await restart(o)).toBe('running:external');
    expect(running.map((c) => alive(c.pid!))).toEqual([true, true]);
  });

  it('ignores the restart mark of a restart that is no longer running', async () => {
    const { o } = await setup();
    mkdirSync(o.data, { recursive: true });
    writeFileSync(join(o.data, 'launcher.json'), JSON.stringify({ restarting: { pid: process.pid, started: 'Mon Jan  1 00:00:00 2024' } }));
    expect(await status(o)).toBe('stopped');
  });

  it('counts only the runs that are executing right now and gives 0 when Task Pilot is down', async () => {
    const { o } = await setup({ runs: JSON.stringify([{ status: 'running' }, { status: 'paused' }, { status: 'running' }, { status: 'waiting_owner' }]) });
    await start(o);
    expect(await busy(o)).toBe(2);
    await stop(o);
    expect(await busy(o)).toBe(0);
  });

  it('puts the node of the launcher and ~/.local/bin in front of the system PATH of a login shell', () => {
    expect(launchPath('PATH="/usr/bin:/bin:/opt/homebrew/bin"; export PATH;', '/Users/me', '/opt/homebrew/Cellar/node/26/bin')).toBe(
      '/opt/homebrew/Cellar/node/26/bin:/Users/me/.local/bin:/usr/bin:/bin:/opt/homebrew/bin',
    );
    expect(launchPath('', '/Users/me', '/usr/bin')).toBe('/usr/bin:/Users/me/.local/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('pnpm restart', () => {
  it('leaves stopping and starting to the restart script, which checks runs and marks the restart for the Dock app', () => {
    expect(skipsCommand('stop', 'restart')).toBe(true);
    expect(skipsCommand('start', 'restart')).toBe(true);
    expect(skipsCommand('restart', 'restart')).toBe(false);
  });

  it('runs stop and start as usual outside pnpm restart', () => {
    expect(skipsCommand('stop', undefined)).toBe(false);
    expect(skipsCommand('start', 'run-script')).toBe(false);
    expect(skipsCommand('status', 'restart')).toBe(false);
  });
});
