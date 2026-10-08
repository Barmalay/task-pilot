import { existsSync, readFileSync } from 'node:fs';
import type { Plan, StepContext } from '../../packages/step-kit/src/index.ts';
import { sha256 } from './agent.ts';

/**
 * План из контекста, если его файл на месте. hashMatches - файл не менялся после утверждения.
 * Без файла плана нет: например, после пробного прогона или если файл удалили.
 */
export function approvedPlan(c: StepContext): { plan: Plan; hashMatches: boolean } | undefined {
  const plan = c.get<Plan>('plan');
  if (!plan || !existsSync(plan.file)) return undefined;
  return { plan, hashMatches: sha256(readFileSync(plan.file, 'utf8')) === plan.hash };
}
