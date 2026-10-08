/**
 * Разовый импорт истории скилла feature-stats: pnpm features:import [папка history]. Для каждой фичи пакета команды
 * читает history/<id>.json и записывает в базу Task Pilot дни, которых там еще нет: дни старше срока хранения индекса
 * логов есть только в истории скилла. Сам скилл и его файлы не меняются.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { daysFromSkillHistory } from '@task-pilot/step-kit';
import { loadConfig } from './config.ts';
import { FeatureService } from './monitor/features.ts';
import { createMonitorPort } from './monitor/port.ts';
import { Store } from './store/db.ts';

const dir = process.argv[2] ?? join(homedir(), '.claude', 'skills', 'feature-stats', 'history');
try {
  const config = loadConfig();
  const port = createMonitorPort({
    profile: config.profiles.monitor,
    dir: config.dashboardsDir,
    features: config.featuresDir,
    logs: { unavailable: 'импорт истории логи прода не читает' },
  });
  const { features, errors } = port.features();
  for (const e of errors) console.error(`Профиль фичи ${e.file}: ${e.message}`);
  if (!features.length) throw new Error(`В пакете команды нет профилей фич: ${config.featuresDir}`);
  const store = new Store(join(config.dataDir, 'task-pilot.db'));
  const service = new FeatureService({ port, store, timeZone: config.profiles.monitor?.timeZone ?? 'UTC' });
  for (const f of features) {
    const file = join(dir, `${f.id}.json`);
    if (!existsSync(file)) {
      console.log(`${f.id}: истории нет (${file})`);
      continue;
    }
    const days = daysFromSkillHistory(JSON.parse(readFileSync(file, 'utf8')));
    console.log(`${f.id}: дней в истории ${days.length}, записано новых ${service.importDays(f.id, days)}`);
  }
  store.close();
} catch (e) {
  console.error(`Task Pilot: история скилла не импортирована: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
