import { describe, expect, it } from 'vitest';
import { teamSkill } from './team.ts';

const team = { id: 'team', title: 'TEAM', qaSkill: '/team/plugin/skills/stand-qa', wikiSkill: null, wikiSpace: null };

describe('skills of the team for steps', () => {
  it('are the folders the team.yaml of the pack names in the plugin of the team', () => {
    expect(teamSkill({ team }, 'qa')).toBe('/team/plugin/skills/stand-qa');
  });

  it('are refused when the team.yaml names none, saying what to set', () => {
    expect(() => teamSkill({ team }, 'wiki')).toThrow('У команды TEAM нет скилла страницы вики: задайте wiki.skill в team.yaml пакета команды');
    expect(() => teamSkill({ team: { ...team, title: '', qaSkill: null } }, 'qa')).toThrow('У команды без пакета нет скилла теста на стенде: задайте qa.skill в team.yaml');
  });
});
