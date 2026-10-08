import type { ProfilesDto } from '@task-pilot/api-types';

/**
 * Стенды, которые можно выбрать в прогоне репозитория: стенды его контура, у которых есть окружение в его проекте
 * деплоя. Репозиторий без профиля видит все стенды: выбрать за владельца не из чего.
 */
export function standsFor(profiles: ProfilesDto, repoId: string): ProfilesDto['stands'] {
  const repo = profiles.repos.find((r) => r.id === repoId);
  if (!repo) return profiles.stands;
  return profiles.stands.filter((s) => s.contour === repo.contour && (s.repos === null || s.repos.includes(repoId)));
}
