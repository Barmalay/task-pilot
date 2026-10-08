import type { Contour, RepoProfile } from './profiles.ts';
import type { IssueRef } from './types.ts';

/** Выбор репозитория по задаче. */
export interface RepoChoice {
  repoId: string;
  /** Почему выбран этот репозиторий: для подписи в интерфейсе. */
  reason: string;
  /** Все подходящие репозитории, если их несколько. */
  candidates: string[];
  /** Задача репозиторий не подсказала: стоит репозиторий по умолчанию, и прогон ждет, пока владелец выберет свой. */
  unsure?: boolean;
}

/** Сторона задачи и репозитория: фронтенд или бэкенд. */
export type Side = 'frontend' | 'backend';

/** Задача для выбора репозитория: метки, компоненты и, для префикса [Front] или [Back], название. */
export type RepoHints = Pick<IssueRef, 'labels' | 'components'> & { summary?: string };

const REPO_LABEL = /^repo:([^/]+)\/(.+)$/i;
const SIDE_PREFIX = /^\s*\[(front|back)(?:end)?\]/i;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Сторона задачи: по метке frontend или backend, а если такой метки нет или есть обе - по префиксу [Front] или
 * [Back] в начале названия. null - задача сторону не подсказала.
 */
export function sideOf(issue: RepoHints): { side: Side; why: string } | null {
  const labels = issue.labels.filter((l) => same(l, 'frontend') || same(l, 'backend'));
  const sides = new Set(labels.map((l) => l.toLowerCase() as Side));
  if (sides.size === 1) return { side: [...sides][0]!, why: `метке ${labels[0]}` };
  const prefix = SIDE_PREFIX.exec(issue.summary ?? '');
  if (prefix) return { side: prefix[1]!.toLowerCase() === 'front' ? 'frontend' : 'backend', why: `префиксу ${prefix[0].trim()} в названии` };
  return null;
}

/**
 * Подбирает репозиторий по задаче: сначала по метке repo:<проект>/<репозиторий>, затем по компонентам в порядке, в
 * котором они указаны в задаче. Среди репозиториев одного компонента выбирает репозиторий стороны задачи (`sideOf`),
 * а репозиторий другой стороны задаче не подходит; без стороны впереди репозиторий по умолчанию. Среди нескольких
 * подходящих предпочитает репозиторий подключенного контура. null - задача ничего не подсказала.
 */
export function pickRepo(issue: RepoHints, repos: RepoProfile[], contours: Contour[]): RepoChoice | null {
  const connected = (r: RepoProfile) => contours.find((c) => c.id === r.contour)?.connected === true;
  const choose = (found: { repo: RepoProfile; why: string }[]): RepoChoice | null => {
    const unique = found.filter((f, i) => found.findIndex((g) => g.repo.id === f.repo.id) === i);
    const best = unique.find((f) => connected(f.repo)) ?? unique[0];
    return best ? { repoId: best.repo.id, reason: best.why, candidates: unique.map((f) => f.repo.id) } : null;
  };

  const byLabel = issue.labels.flatMap((label) => {
    const m = REPO_LABEL.exec(label);
    if (!m?.[2]) return [];
    const name = m[2];
    // Репозиторий, который метку перечисляет в своем профиле, важнее совпавшего только по имени: одно имя, например
    // k8s-ansible, бывает у репозиториев разных контуров.
    const claims = (r: RepoProfile) => r.match.labels.some((l) => same(l, label));
    return repos
      .filter((r) => claims(r) || same(r.bitbucket?.repo ?? '', name) || same(r.id, name))
      .sort((a, b) => Number(claims(b)) - Number(claims(a)))
      .map((repo) => ({ repo, why: `по метке ${label}` }));
  });
  const fromLabel = choose(byLabel);
  if (fromLabel) return fromLabel;

  const hint = sideOf(issue);
  const own = (r: RepoProfile) => hint !== null && r.match.side === hint.side;
  const byComponent = issue.components.flatMap((component) =>
    repos
      .filter((r) => r.match.components.some((c) => same(c, component)) && (!hint || !r.match.side || own(r)))
      // Своя сторона впереди репозитория без стороны, а без стороны задачи впереди репозиторий по умолчанию.
      .sort((a, b) => (hint ? Number(own(b)) - Number(own(a)) : Number(b.default) - Number(a.default)))
      .map((repo) => ({ repo, why: own(repo) ? `по компоненту ${component} и ${hint!.why}` : `по компоненту ${component}` })),
  );
  return choose(byComponent);
}

/** Почему задача не подсказала репозиторий: для подписи в прогоне, где стоит репозиторий по умолчанию. */
export function whyNoRepo(issue: RepoHints, repos: RepoProfile[]): string {
  if (!issue.components.length) return 'у задачи нет компонентов и метки repo:';
  const side = sideOf(issue);
  const known = issue.components.filter((c) => repos.some((r) => r.match.components.some((x) => same(x, c))));
  if (known.length && side) return `у компонента ${known.join(', ')} нет репозитория стороны ${side.side} (по ${side.why})`;
  return `у компонента ${issue.components.join(', ')} нет профиля репозитория`;
}

/** Программы сборки Java: для них JDK задается явно, сборка идет только под JDK 21. */
const JAVA_BUILDS = new Set(['mvn', 'mvnw', './mvnw', 'gradle', 'gradlew', './gradlew']);

/** Сборка Java: команда сборки из профиля запускает Maven или Gradle. */
export function isJavaBuild(command: string): boolean {
  return JAVA_BUILDS.has(command.trim().split(/\s+/)[0] ?? '');
}
