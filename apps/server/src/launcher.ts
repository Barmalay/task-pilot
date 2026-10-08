/**
 * Запуск Task Pilot для приложения в Dock (launcher/install.sh) и для терминала:
 * node apps/server/src/launcher.ts start | stop | restart | status | busy | log
 *
 * start запускает сервер без перезапуска при правках кода и интерфейс Vite, каждый в своей группе процессов,
 * и ждет, пока оба ответят. Печатает started, running:ours (уже запущен этой командой) или running:external
 * (запущен иначе, например pnpm dev). stop останавливает только запущенное через start, restart перезапускает
 * его после обновления кода сервера (приложение в Dock при этом продолжает работать, а при выполняющемся прогоне
 * перезапуск отказывается), status печатает running:ours, running:external или stopped, busy - сколько прогонов
 * выполняется сейчас, log открывает журнал запуска. Ошибка печатается в stderr, код выхода 1. Команда pnpm restart
 * вызывает подряд скрипты stop, restart и start; stop и start внутри нее ничего не делают (`skipsCommand`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT } from './config.ts';
import type { LaunchOptions } from './launcher/control.ts';
import { busy, launchPath, logFile, restart, skipsCommand, start, status, stop } from './launcher/control.ts';

const env = process.env;
const options: LaunchOptions = {
  data: env.TASK_PILOT_DATA ?? join(ROOT, '.data'),
  env: { ...env, PATH: launchPath(execFileSync('/usr/libexec/path_helper', ['-s'], { encoding: 'utf8' }), homedir(), dirname(process.execPath)) },
  server: { command: [process.execPath, 'src/main.ts'], cwd: join(ROOT, 'apps/server') },
  web: { command: [process.execPath, 'node_modules/vite/bin/vite.js'], cwd: join(ROOT, 'apps/web') },
  api: `http://127.0.0.1:${env.TASK_PILOT_PORT ?? 5176}/api`,
  ui: `http://127.0.0.1:${env.TASK_PILOT_WEB_PORT ?? 5177}/`,
};

const commands: Record<string, () => Promise<unknown>> = {
  start: () => start(options),
  stop: () => stop(options),
  restart: () => restart(options),
  status: () => status(options),
  busy: () => busy(options),
  log: async () => {
    const file = logFile(options);
    if (!existsSync(file)) throw new Error('Журнала запуска еще нет');
    execFileSync('open', [file]);
  },
};

const name = process.argv[2] ?? '';
if (skipsCommand(name, env.npm_command)) process.exit(0);
const command = commands[name];
if (!command) {
  console.error(`Команды: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
try {
  const result = await command();
  if (result !== undefined) console.log(String(result));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
