import type { LinkedRun } from './types.ts';

/** Итоги шага деплоя, после которых связанный прогон больше не ждут. */
const SETTLED = new Set(['succeeded', 'already', 'skipped', 'simulated']);

interface Deployed {
  stand?: string;
  build?: string;
  tag?: string | null;
}

const buildOf = (l: LinkedRun) => l.get<{ key?: string }>('build')?.key ?? null;
const deployedOf = (l: LinkedRun) => l.get<Deployed>('deployedBuild') ?? null;

/**
 * Связанные прогоны, чей деплой ждет тест на стенде: шаг деплоя deployStep в прогоне выбран, но еще не прошел или
 * выкатил не последнюю сборку ветки. Прогон без шага деплоя, с выключенным или пропущенным деплоем не ждут.
 */
export function pendingDeploys(linked: LinkedRun[], deployStep: string): LinkedRun[] {
  return linked.filter((l) => {
    const step = l.steps.find((s) => s.id === deployStep);
    if (!step?.selected) return false;
    if (!SETTLED.has(step.status)) return true;
    if (step.status === 'skipped' || step.status === 'simulated') return false;
    const build = buildOf(l);
    return build !== null && deployedOf(l)?.build !== build;
  });
}

/** Что со связанным прогоном: что он выкатил или чего ждет его деплой deployStep. */
export function linkedText(l: LinkedRun, deployStep: string): string {
  const step = l.steps.find((s) => s.id === deployStep);
  const build = buildOf(l);
  const deployed = deployedOf(l);
  if (deployed?.build && (!build || deployed.build === build)) {
    return `${l.repo.title}: сборка ${deployed.build}${deployed.tag ? ` с образом ${deployed.tag}` : ''} выкачена на ${deployed.stand}`;
  }
  if (deployed?.build) return `${l.repo.title}: на ${deployed.stand} старая сборка ${deployed.build}, ждет деплоя ${build}`;
  if (!step) return `${l.repo.title}: шага деплоя в прогоне нет`;
  if (!step.selected) return `${l.repo.title}: деплой в прогоне выключен`;
  return `${l.repo.title}: деплой еще не прошел`;
}
