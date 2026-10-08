import type { Issue, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { walkTransitions } from '../../packages/step-kit/src/index.ts';
import { moveOf, moveOffText, transitionIds, transitionText } from '../_shared/board.ts';

const MILESTONE = 'inProgress';

/** Логин владельца в Jira: на него назначается задача. */
function me(c: StepContext): string {
  if (!c.jira.me) throw new Error('Логин Jira не задан: укажите me в личных настройках ~/.task-pilot/profile.yaml или заведите токен Jira на экране "Интеграции"');
  return c.jira.me;
}

async function inspect(c: StepContext) {
  const issue = (c.scratch.get('issue') as Issue | undefined) ?? (await c.ports.jira.getIssue(c.run.issueKey));
  c.scratch.set('issue', issue);
  const move = moveOf(c, issue.status, MILESTONE);
  const assignedToMe = issue.assignee?.name === me(c);
  return { issue, move, plan: move.plan, assignedToMe };
}

/**
 * Назначает задачу на владельца и доводит ее до вехи inProgress доски или до статуса из настройки шага "Куда перевести
 * задачу"; с "не переводить" и пустой вехой только назначает. Назад по доске не двигает.
 */
const step: StepModule = {
  async done(c) {
    const { issue, move, plan, assignedToMe } = await inspect(c);
    if (plan.kind === 'done' && assignedToMe) {
      return { note: move.off ? `Задача назначена на вас, ${move.byBoard ? 'на этой доске шаг задачу не двигает' : 'перевод по доске выключен в настройках шага'}` : `Задача уже в статусе ${issue.status} и назначена на вас`, outputs: { status: issue.status } };
    }
    return null;
  },

  async preview(c) {
    const { issue, move, plan, assignedToMe } = await inspect(c);
    if (plan.kind === 'blocked') throw new Error(plan.reason);
    const actions: string[] = [];
    if (!assignedToMe) {
      actions.push(issue.assignee ? `Переназначить задачу на вас (сейчас: ${issue.assignee.displayName ?? issue.assignee.name})` : 'Назначить задачу на вас');
    }
    if (plan.kind === 'transitions') {
      for (const s of plan.steps) actions.push(transitionText(s, ': '));
    }
    if (move.off) actions.push(moveOffText(issue.status, move.byBoard));
    return {
      title: `${issue.key}: взять в работу`,
      summary: move.target ? `Сейчас ${issue.status}, цель ${move.target}` : `Сейчас ${issue.status}, ${move.byBoard ? 'на этой доске шаг задачу не двигает' : 'перевод по доске выключен в настройках шага'}`,
      actions,
      payload: { key: issue.key, from: issue.status, assign: !assignedToMe, transitions: plan.kind === 'transitions' ? transitionIds(plan.steps) : [] },
    };
  },

  async simulate(c) {
    // Пробный прогон задачу не читает: статус - цель перевода; с выключенным переводом статуса нет.
    const { target, off, plan } = moveOf(c, '', MILESTONE);
    if (!target && !off && plan.kind === 'blocked') throw new Error(plan.reason);
    return target ? { status: target } : {};
  },

  async run(c) {
    const { jira } = c.ports;
    const { issue, plan, assignedToMe } = await inspect(c);
    if (plan.kind === 'blocked') throw new Error(plan.reason);
    if (!assignedToMe) {
      await jira.assign(issue.key, me(c));
      c.log(`Задача назначена на ${me(c)}`);
    }
    const status = plan.kind === 'transitions' ? await walkTransitions(jira, issue.key, issue.status, plan.steps, c.log) : issue.status;
    return { status };
  },
};

export default step;
