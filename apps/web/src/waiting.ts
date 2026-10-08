import type { WaitEvent } from '@task-pilot/step-kit';

/** Чего ждет шаг, словами: what - после "Жду" (что), of - после "Ждет" в контексте прогона (чего). */
export function waitWords(e: WaitEvent): { what: string; of: string } {
  switch (e.kind) {
    case 'pr':
      return { what: `мерж PR #${e.pr}`, of: `мержа PR #${e.pr}` };
    case 'plan-branch':
      return { what: `ветку плана ${e.plan} для ${e.branch}`, of: `ветки плана ${e.plan} для ${e.branch}` };
    case 'build':
      return { what: `сборку коммита ${e.revision.slice(0, 8)}`, of: `сборки коммита ${e.revision.slice(0, 8)}` };
    case 'manual-deploy':
      return { what: 'Customize Deploy в Bamboo', of: 'Customize Deploy в Bamboo' };
    case 'deploy':
      return { what: 'окончание деплоя', of: 'окончания деплоя' };
    case 'rollout':
      return { what: `выкатку на стенде ${e.standId}`, of: `выкатки на стенде ${e.standId}` };
    case 'linked':
      return { what: 'деплой связанных прогонов', of: 'деплоя связанных прогонов' };
  }
}
