import type { Route } from './router.ts';

type RouteName = Route['name'];

/** Подвкладка раздела: экран, его адрес и подсказка. */
export interface NavTab {
  route: RouteName;
  href: string;
  label: string;
  hint: string;
}

/** Раздел шапки. У раздела из нескольких экранов есть подвкладки, у раздела из одного - только адрес. */
export interface NavSection {
  id: 'tasks' | 'stands' | 'monitor' | 'pipeline' | 'settings';
  label: string;
  hint: string;
  /** Куда ведет вкладка раздела без подвкладок. */
  href: string;
  /** Экраны раздела помимо подвкладок: страница прогона у задач, дашборд, фича и попытка входа у мониторинга. */
  routes: RouteName[];
  tabs: NavTab[];
}

/** Разделы шапки по порядку: пять вкладок, у "Конвейера" и "Настроек" подвкладки. */
export const SECTIONS: readonly NavSection[] = [
  { id: 'tasks', label: 'Задачи', hint: 'Задачи из Jira по статусам доски: мои или спринта', href: '#/', routes: ['tasks', 'run'], tabs: [] },
  { id: 'stands', label: 'Стенды', hint: 'Что сейчас выкачено на каждый стенд: релиз, задача, образ и доступность', href: '#/stands', routes: ['stands'], tabs: [] },
  {
    id: 'monitor',
    label: 'Мониторинг',
    hint: 'Логи прода: воронки фич входа, дашборды задач, алерты, строки лога и одна попытка входа',
    href: '#/monitor',
    routes: ['monitor', 'dashboard', 'feature', 'attempt'],
    tabs: [],
  },
  {
    id: 'pipeline',
    label: 'Конвейер',
    hint: 'Шаги цикла, пресеты и история прогонов: время, расход агентов и кэш',
    href: '#/catalog',
    routes: [],
    tabs: [
      { route: 'catalog', href: '#/catalog', label: 'Каталог шагов', hint: 'Все шаги цикла по фазам и пресеты' },
      { route: 'presets', href: '#/presets', label: 'Пресеты', hint: 'Наборы шагов, из которых начинается прогон: создать, изменить порядок и выбор по умолчанию, удалить' },
      { route: 'history', href: '#/history', label: 'История', hint: 'Сколько шел каждый прогон и на что ушло время, расход агентов, место на диске и очистка кэша' },
    ],
  },
  {
    id: 'settings',
    label: 'Настройки',
    hint: 'Интеграции с аккаунтами, окружение этой машины и служебные сведения о Task Pilot',
    href: '#/integrations',
    routes: [],
    tabs: [
      {
        route: 'integrations',
        href: '#/integrations',
        label: 'Интеграции',
        hint: 'Jira, Confluence, Bitbucket, Bamboo, логи и Claude: под какими аккаунтами работает Task Pilot, вход токеном и смена аккаунта',
      },
      { route: 'environment', href: '#/environment', label: 'Окружение', hint: 'Программы, файлы и папки этой машины, от которых зависит Task Pilot: то же, что pnpm checkup' },
      {
        route: 'service',
        href: '#/service',
        label: 'Служебное',
        hint: 'Запущенный сервер и нужен ли ему перезапуск, репозиторий Task Pilot, что ждет вашего решения и журнал сервера',
      },
    ],
  },
];

/** Раздел, к которому относится экран. */
export function sectionOf(route: RouteName): NavSection {
  return SECTIONS.find((s) => s.routes.includes(route) || s.tabs.some((t) => t.route === route)) ?? SECTIONS[0]!;
}

/** Куда ведет вкладка раздела: на подвкладку, открытую в нем последней, иначе на первую; у раздела без подвкладок - на его адрес. */
export function sectionHref(section: NavSection, lastTab: RouteName | undefined): string {
  return section.tabs.find((t) => t.route === lastTab)?.href ?? section.tabs[0]?.href ?? section.href;
}
