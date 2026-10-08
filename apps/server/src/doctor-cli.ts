/**
 * Проверка окружения из терминала: pnpm checkup (pnpm doctor занят своей командой pnpm). Печатает итог каждой проверки
 * и как исправить; код выхода 1, если есть проблема (fail) или не читаются профили и личные настройки.
 */
import { loadConfig } from './config.ts';
import { formatDoctor, runDoctor } from './doctor.ts';

try {
  const checks = await runDoctor(loadConfig());
  console.log(formatDoctor(checks));
  process.exit(checks.some((c) => c.level === 'fail') ? 1 : 0);
} catch (e) {
  console.error(`Task Pilot: профили или личные настройки не читаются: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
