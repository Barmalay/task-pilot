import type { StepContext } from '../../packages/step-kit/src/index.ts';

/** Скиллы команды по назначению: тест на стенде и страница вики, их называет team.yaml пакета команды. */
const SKILLS = {
  qa: { key: 'qaSkill', what: 'теста на стенде', field: 'qa.skill' },
  wiki: { key: 'wikiSkill', what: 'страницы вики', field: 'wiki.skill' },
} as const;

/** Папка скилла команды для шага; скилла нет в team.yaml - ошибка, которая говорит, что задать. */
export function teamSkill(c: Pick<StepContext, 'team'>, kind: keyof typeof SKILLS): string {
  const s = SKILLS[kind];
  const dir = c.team[s.key];
  if (!dir) throw new Error(`У команды ${c.team.title || 'без пакета'} нет скилла ${s.what}: задайте ${s.field} в team.yaml пакета команды`);
  return dir;
}
