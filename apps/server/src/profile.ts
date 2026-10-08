import { existsSync } from 'node:fs';
import type { ProfileDto } from '@task-pilot/api-types';
import { boardStatuses } from '@task-pilot/step-kit';
import { expandHome, shortPath, type AppConfig } from './config.ts';

/** Адрес доски в Jira Server: экран доски по ее id. */
function boardUrl(baseUrl: string, id: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/secure/RapidBoard.jspa?rapidView=${id}`;
}

/**
 * Профиль для панели сбоку: команда (пакет, слой компании, доска, репозитории с путями на этой машине, число стендов,
 * скиллы агентов) и личные настройки так, как они применены к профилям. Стенды считаются при каждом вызове: список
 * стендов из Bamboo меняется, пока сервер работает. Токенов и значений из ~/.claude.json в профиле нет.
 */
export function profileOf(config: Pick<AppConfig, 'root' | 'team' | 'profiles' | 'personal' | 'personalFile' | 'style'>): ProfileDto {
  const { team, profiles, personal } = config;
  const jira = profiles.jira;
  const short = (path: string) => shortPath(path, config.root);
  return {
    team: {
      id: team.id,
      title: team.title,
      dir: short(team.dir),
      company: team.company ? { id: team.company.id, dir: short(team.company.dir) } : null,
      board: jira.board ? { name: jira.board.name, url: boardUrl(jira.baseUrl, jira.board.id) } : null,
      statuses: boardStatuses(jira),
      skills: { qa: team.manifest.qa?.skill ?? null, wiki: team.manifest.wiki?.skill ?? null },
      wikiSpace: team.manifest.wiki?.space ?? null,
      repos: profiles.repos.map((r) => ({ id: r.id, title: r.title, path: short(r.path), default: r.default })),
      stands: profiles.stands.length,
    },
    personal: {
      file: short(config.personalFile),
      exists: existsSync(config.personalFile),
      me: personal.me ?? '',
      javaHome: personal.javaHome ? short(expandHome(personal.javaHome)) : null,
      style: { ...config.style },
    },
  };
}
