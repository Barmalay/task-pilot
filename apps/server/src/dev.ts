/**
 * Сервер для pnpm dev: node --watch перезапускает его при правке кода сервера, step-kit, слоев компании и профилей
 * пакета команды. Пакет команды берется так же, как при обычном запуске: TASK_PILOT_TEAM или team личных настроек.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandHome, loadPersonal, ROOT } from './config.ts';

const personal = loadPersonal(expandHome(process.env.TASK_PILOT_PERSONAL ?? '~/.task-pilot/profile.yaml'));
const team = process.env.TASK_PILOT_TEAM ?? personal.team;
const teamDir = team ? resolve(expandHome(team)) : null;
const paths = [
  join(ROOT, 'apps/server/src'),
  join(ROOT, 'packages/step-kit/src'),
  join(ROOT, 'company'),
  ...(teamDir ? [join(teamDir, 'team.yaml'), join(teamDir, 'profiles')] : []),
].filter((p) => existsSync(p));
const child = spawn(process.execPath, [...paths.map((p) => `--watch-path=${p}`), '--watch-preserve-output', join(ROOT, 'apps/server/src/main.ts')], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
