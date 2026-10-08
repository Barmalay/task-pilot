import { describe, expect, it } from 'vitest';
import { REFERENCES, type ReferenceFacts } from '../src/reference.ts';

const ref = (key: string) => REFERENCES.find((r) => r.key === key)!;
const facts = (over: Partial<ReferenceFacts> = {}): ReferenceFacts => ({ status: 'completed', context: {}, questions: 0, plan: null, ...over });
const failed = (key: string, f: ReferenceFacts) => ref(key).checks(f).filter((c) => !c.ok).map((c) => c.name);

describe('reference tasks', () => {
  it('take DEMO-1 from the plan to a pull request with a green build, a new test that ran and no question to the owner', () => {
    const done = facts({ context: { testReport: { failures: 0, errors: 0, changedTests: [{ executed: true }] }, pr: { id: 1 } } });
    expect(failed('DEMO-1', done)).toEqual([]);
    expect(failed('DEMO-1', facts({ status: 'failed', questions: 1, context: { testReport: { failures: 1, errors: 0, changedTests: [{ executed: false }] } } }))).toEqual([
      'прогон дошел до конца',
      'сборка и тесты зеленые',
      'новый тест есть и выполнился',
      'PR создан',
      'агент не спрашивал владельца: в задаче все сказано',
    ]);
  });

  it('expect the analysis of DEMO-2 to ask the owner and to take the answer into the plan, which only a real agent can', () => {
    expect(ref('DEMO-2').skip).toEqual(['code.implement', 'code.verify', 'code.publish']);
    expect(failed('DEMO-2', facts({ questions: 1, plan: '# План\nБросать ArithmeticException при делении на ноль' }))).toEqual([]);
    expect(failed('DEMO-2', facts({ plan: '# План\nВернуть 0' }))).toEqual(['агент спросил владельца о делении на ноль', 'план учел ответ: ArithmeticException']);
    expect(ref('DEMO-2').checks(facts()).filter((c) => c.agent).map((c) => c.name)).toEqual(['агент спросил владельца о делении на ноль', 'план учел ответ: ArithmeticException']);
  });
});
