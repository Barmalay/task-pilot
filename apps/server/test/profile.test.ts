import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_TEAM, loadConfig, ROOT } from '../src/config.ts';
import { profileOf } from '../src/profile.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Пакет команды для тестов: сервисы в контурах учебного слоя компании example. */
const TEAM = join(ROOT, 'apps', 'server', 'test', 'fixtures', 'team');

/** Конфигурация пакета team с личными настройками personal; null - файла личных настроек нет. */
function configOf(team: string, personal: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'task-pilot-profile-'));
  dirs.push(dir);
  if (personal !== null) writeFileSync(join(dir, 'profile.yaml'), personal);
  return loadConfig({ TASK_PILOT_CLAUDE_JSON: '/nonexistent/claude.json', TASK_PILOT_PERSONAL: join(dir, 'profile.yaml'), TASK_PILOT_DATA: join(dir, 'data'), TASK_PILOT_TEAM: team });
}

describe('profile for the side panel', () => {
  it('shows the team with its company layer, board, statuses, skills and repositories, and the personal settings as applied', () => {
    const config = configOf(TEAM, 'me: colleague\njavaHome: ~/jdk21\nstyle: { yo: true }\n');
    const p = profileOf(config);
    expect(p.team).toMatchObject({
      id: 'fixture',
      title: 'Команда тестов',
      dir: 'apps/server/test/fixtures/team',
      company: { id: 'example', dir: 'company/example' },
      board: { name: 'Доска тестов', url: 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=7' },
      statuses: ['Open', 'In Progress', 'Review', 'Testing', 'Merged', 'Monitoring'],
      skills: { qa: 'stand-qa', wiki: 'wiki-pages' },
      wikiSpace: 'TEAM',
      stands: config.profiles.stands.length,
    });
    expect(p.team.repos.map((r) => r.id)).toEqual(config.profiles.repos.map((r) => r.id));
    expect(p.team.repos.filter((r) => r.default)).toHaveLength(1);
    // Пути на этой машине - через ~, а не с именем пользователя.
    expect(p.team.repos.every((r) => !r.path.startsWith(homedir()))).toBe(true);
    expect(p.personal).toMatchObject({ exists: true, me: 'colleague', javaHome: '~/jdk21', style: { yo: true, dash: false, quotes: false } });
    expect(p.personal.file.endsWith('profile.yaml')).toBe(true);
  });

  it('says so when the team has no company layer and no board for sprints, and when there are no personal settings', () => {
    const p = profileOf(configOf(DEMO_TEAM, null));
    expect(p.team).toMatchObject({ id: 'demo', dir: 'examples/demo', company: null, board: null, statuses: ['Open', 'In Progress', 'Review', 'Testing', 'Done'] });
    expect(p.personal).toMatchObject({ exists: false, me: '', javaHome: null, style: { yo: false, dash: false, quotes: false } });
  });
});
