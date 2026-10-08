import { describe, expect, it } from 'vitest';
import { checkOutputs, CONTEXT_SCHEMAS, type Build, type Changes, type Plan, type PrReview, type QaReport, z } from '../src/contracts.ts';

// Значения как у настоящих шагов: такие кладут task.analyze, code.implement, ci.wait, qa.stand и pr.address-review.
const plan: Plan = { file: '/work/.claude/TEAM-1/plan.md', hash: 'a1b2', summary: 'План', questions: [] };
const changes: Changes = { summary: 'Добавлен метод', files: ['src/A.java'], tests: ['src/ATest.java'], buildGreen: true, sessionId: 's-1' };
const build: Build = { key: 'SSO-12', number: 12, plan: 'SSO', branch: 'feature/TEAM-1', revision: 'abc', tag: '1.0.12-3', url: 'https://bamboo/browse/SSO-12' };
const qaReport: QaReport = {
  at: '2026-09-25T10:00:00.000Z',
  stand: 'stable',
  build: '1.0.12-3',
  summary: 'Пройдено 1 из 2',
  results: [
    { ac: '1', scenario: 'вход', action: 'ввести код', expected: 'вошел', result: 'пройден', note: 'ok', files: ['01.png'] },
    { ac: '2', scenario: 'ошибка', action: 'неверный код', expected: 'снекбар', result: 'не пройден', note: 'нет снекбара', files: [] },
  ],
  remarks: [],
  guide: '/docs/qa-guide.md',
  report: '/docs/qa-report.md',
  artifacts: '/artifacts/qa',
  missing: [],
};
const prReview: PrReview = { pr: 262, replies: [{ commentId: 7, text: 'Исправил', fixed: true }], summary: 'Ответы', files: [], tests: [], pending: true, base: 'abc', at: '2026-09-25T10:00:00.000Z' };
const issue = { key: 'TEAM-1', summary: 'Задача', status: 'Open', url: 'https://jira/TEAM-1', labels: [], components: ['keycloak'], sprint: null, assignee: null, description: 'AC' };

describe('context contracts', () => {
  it('accept the values the steps put into the context', () => {
    const outputs = { plan, changes, build, qaReport, prReview, issue, ac: ['первый'], failedAc: ['2'], status: 'In Progress', branch: 'feature/TEAM-1', rebased: false };
    expect(checkOutputs(outputs)).toEqual({ issues: [], unknown: [] });
    expect(checkOutputs({ ac: null, issueChanged: null, issueSeen: null, deployedBuild: { stand: 'stable', build: 'SSO-12', tag: null, resultId: 5, pod: null } }).issues).toEqual([]);
  });

  it('reject a strict value with a foreign field, a missing field or a result outside the list', () => {
    const r = checkOutputs({ plan: { ...plan, extra: 1 }, changes: { ...changes, sessionId: undefined }, qaReport: { ...qaReport, results: [{ ...qaReport.results[0]!, result: 'ок' }] } });
    expect(r.issues.map((i) => i.key)).toEqual(['plan', 'changes', 'qaReport']);
    expect(r.issues[0]!.message).toContain('extra');
    expect(r.issues[1]!.message).toContain('sessionId');
    expect(r.issues[2]!.message).toContain('results.0.result');
  });

  it('let values of the systems carry fields of their own: a Jira issue and a pull request', () => {
    expect(checkOutputs({ issue: { ...issue, fields: { priority: 'High' } }, pr: { id: 1, title: 'PR', url: 'u', state: 'OPEN' } }).issues).toEqual([]);
    expect(checkOutputs({ issue: { ...issue, key: 1 } }).issues.map((i) => i.key)).toEqual(['issue']);
  });

  it('name keys without a contract and check a step contract of its own new key', () => {
    expect(checkOutputs({ greeting: 'Привет', skipped: undefined })).toEqual({ issues: [], unknown: ['greeting'] });
    const own = { greeting: z.string() };
    expect(checkOutputs({ greeting: 'Привет' }, own)).toEqual({ issues: [], unknown: [] });
    expect(checkOutputs({ greeting: 1 }, own).issues.map((i) => i.key)).toEqual(['greeting']);
    // Общий контракт важнее своего: шаг не ослабит контракт общего ключа.
    expect(checkOutputs({ plan: 'не план' }, { plan: z.string() }).issues.map((i) => i.key)).toEqual(['plan']);
  });

  it('cover every key the steps of the project provide', () => {
    const provided = ['issue', 'ac', 'issueChanged', 'issueSeen', 'status', 'branch', 'worktree', 'rebased', 'plan', 'changes', 'testReport', 'findings', 'commitSha', 'pr', 'build', 'ansibleBranch', 'ansiblePr', 'release', 'deployedBuild', 'qaReport', 'failedAc', 'qaFix', 'qaComment', 'prReview', 'merged', 'wikiPage', 'dashboard', 'stepRequest', 'newStep', 'improvements'];
    expect(Object.keys(CONTEXT_SCHEMAS).sort()).toEqual([...provided].sort());
  });
});
