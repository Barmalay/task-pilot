import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEMO_TEAM, loadConfig, pluginSkills, stepTeamOf } from '../src/config.ts';
import { requiredSkills } from '../src/doctor.ts';
import { DRIVER_DIR, qaBrowserOptions } from '../src/qa/browser.ts';

const PLUGIN = join(DEMO_TEAM, 'plugin');
const ENV = { TASK_PILOT_CLAUDE_JSON: '/nonexistent/claude.json', TASK_PILOT_PERSONAL: '/nonexistent/profile.yaml', TASK_PILOT_TEAM: DEMO_TEAM };

/** Все файлы папки, со вложенными. */
function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe('agent plugin of a team pack', () => {
  it('is a Claude Code plugin of the demo team', () => {
    expect(JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'task-pilot-demo', description: expect.any(String) });
  });

  it('holds every skill the team.yaml of the pack names, each with a name and a description', () => {
    const config = loadConfig(ENV);
    expect(requiredSkills(config)).toEqual(['demo-calculator', 'demo-wiki']);
    for (const name of requiredSkills(config)) {
      const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(pluginSkills(PLUGIN), name, 'SKILL.md'), 'utf8'))?.[1];
      expect(parse(front ?? '')).toMatchObject({ name, description: expect.any(String) });
    }
    // Шаги теста на стенде и вики получают папки этих скиллов в плагине команды.
    expect(stepTeamOf(config)).toEqual({
      id: 'demo',
      title: 'Учебная команда',
      qaSkill: join(pluginSkills(PLUGIN), 'demo-calculator'),
      wikiSkill: join(pluginSkills(PLUGIN), 'demo-wiki'),
      wikiSpace: 'DEMO',
    });
  });

  it('carries no paths of a particular machine', () => {
    expect(filesOf(PLUGIN).filter((f) => /\/Users\/|\/home\/|~\/\.claude\//.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('is the plugin of the team pack by default, and TASK_PILOT_PLUGIN names another one', () => {
    expect(loadConfig(ENV).pluginDir).toBe(PLUGIN);
    expect(loadConfig({ ...ENV, TASK_PILOT_PLUGIN: '/shared/plugin' }).pluginDir).toBe('/shared/plugin');
  });
});

describe('QA browser driver', () => {
  it('lives in Task Pilot itself, and TASK_PILOT_QA_SCRIPTS names another one', () => {
    expect(qaBrowserOptions('/data', {}).scriptsDir).toBe(DRIVER_DIR);
    expect(['cdp.mjs', 'kibana_logs.mjs', 'listen.mjs', 'chrome_start.sh'].filter((f) => !existsSync(join(DRIVER_DIR, f)))).toEqual([]);
    expect(qaBrowserOptions('/data', { TASK_PILOT_QA_SCRIPTS: '/other/scripts' }).scriptsDir).toBe('/other/scripts');
  });

  it('knows nothing of a particular team: no services, stands or Kibana of its own', () => {
    const team = /keycloak|Киклок|example\.com|kibana-cloud|kibana-core/i;
    expect(filesOf(DRIVER_DIR).filter((f) => team.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
