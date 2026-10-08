import type { LucideIcon } from 'lucide-react';
import { Activity, LayoutGrid, Plane, Server, Settings, Workflow } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { AttentionMenu } from './components/AttentionMenu.tsx';
import { BudgetBadge } from './components/BudgetBadge.tsx';
import { NoticesMenu } from './components/NoticesMenu.tsx';
import { OpenTask } from './components/OpenTask.tsx';
import { ProfileButton } from './components/ProfilePanel.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { SECTIONS, sectionHref, sectionOf, type NavSection, type NavTab } from './nav.ts';
import { AttemptPage } from './pages/AttemptPage.tsx';
import { CatalogPage } from './pages/CatalogPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { EnvironmentPage } from './pages/EnvironmentPage.tsx';
import { FeaturePage } from './pages/FeaturePage.tsx';
import { ServicePage } from './pages/ServicePage.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { IntegrationsPage } from './pages/IntegrationsPage.tsx';
import { MonitorPage } from './pages/MonitorPage.tsx';
import { PresetsPage } from './pages/PresetsPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { StandsPage } from './pages/StandsPage.tsx';
import { TasksPage } from './pages/TasksPage.tsx';
import { useRoute, type Route } from './router.ts';
import { cx, Tip } from './ui.tsx';
import { useGlobalEvents } from './useEvents.ts';

const ICONS: Record<NavSection['id'], LucideIcon> = { tasks: LayoutGrid, stands: Server, monitor: Activity, pipeline: Workflow, settings: Settings };

/** Вкладка раздела. Уже 1200px названия не помещаются рядом с полем задачи и кнопками шапки: остается иконка, название видно в подсказке. */
function NavLink({ href, active, icon: Icon, hint, label }: { href: string; active: boolean; icon: LucideIcon; hint: string; label: string }) {
  const text = (
    <>
      <span className="font-medium min-[1200px]:hidden">{label}. </span>
      {hint}
    </>
  );
  return (
    <Tip text={text}>
      <a
        href={href}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
          active ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
        )}
      >
        <Icon className="size-4" aria-hidden />
        <span className="hidden min-[1200px]:inline">{label}</span>
      </a>
    </Tip>
  );
}

function SubTab({ tab, active }: { tab: NavTab; active: boolean }) {
  return (
    <Tip text={tab.hint}>
      <a
        href={tab.href}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'inline-flex whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
          active
            ? 'border-blue-600 text-slate-900 dark:border-blue-400 dark:text-white'
            : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:hover:border-slate-600 dark:hover:text-slate-200',
        )}
      >
        {tab.label}
      </a>
    </Tip>
  );
}

/**
 * Каркас приложения: шапка с пятью разделами, полем "Открыть задачу", тем, что ждет владельца, расходом агентов у
 * лимита, уведомлениями, темой и кнопкой профиля, строка подвкладок у раздела из нескольких экранов и текущий экран.
 * Вкладка раздела ведет на подвкладку, открытую в нем последней.
 */
export function App() {
  const route = useRoute();
  useGlobalEvents();
  const section = sectionOf(route.name);
  const lastTab = useRef(new Map<NavSection['id'], Route['name']>());
  useEffect(() => {
    if (section.tabs.some((t) => t.route === route.name)) lastTab.current.set(section.id, route.name);
  }, [section, route.name]);
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-screen-2xl items-center gap-3 px-4 py-2.5 lg:gap-5">
          <a href="#/" aria-label="Task Pilot" className="flex shrink-0 items-center gap-2 whitespace-nowrap text-base font-semibold">
            <Plane className="size-5 text-blue-600" aria-hidden />
            {/* В совсем узком окне остается значок: разделы, уведомления и профиль важнее надписи. */}
            <span className="hidden sm:inline">Task Pilot</span>
          </a>
          <nav className="flex shrink-0 gap-1" aria-label="Разделы">
            {SECTIONS.map((s) => (
              <NavLink key={s.id} href={sectionHref(s, lastTab.current.get(s.id))} active={s === section} icon={ICONS[s.id]} hint={s.hint} label={s.label} />
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <OpenTask />
            <AttentionMenu />
            <BudgetBadge />
            <NoticesMenu />
            <ThemeToggle />
            <ProfileButton />
          </div>
        </div>
        {section.tabs.length > 0 && (
          <div className="border-t border-slate-100 dark:border-slate-800">
            <nav className="mx-auto flex max-w-screen-2xl gap-1 overflow-x-auto px-4" aria-label={`Подразделы: ${section.label}`}>
              {section.tabs.map((t) => (
                <SubTab key={t.route} tab={t} active={t.route === route.name} />
              ))}
            </nav>
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {route.name === 'tasks' && <TasksPage />}
        {route.name === 'catalog' && <CatalogPage />}
        {route.name === 'presets' && <PresetsPage />}
        {route.name === 'stands' && <StandsPage />}
        {route.name === 'history' && <HistoryPage />}
        {route.name === 'integrations' && <IntegrationsPage />}
        {route.name === 'environment' && <EnvironmentPage />}
        {route.name === 'service' && <ServicePage />}
        {route.name === 'run' && <RunPage key={route.id} id={route.id} />}
        {route.name === 'monitor' && <MonitorPage />}
        {route.name === 'dashboard' && <DashboardPage key={route.id} id={route.id} />}
        {route.name === 'feature' && <FeaturePage key={route.id} id={route.id} />}
        {route.name === 'attempt' && <AttemptPage key={`${route.value}/${route.at ?? ''}`} value={route.value} at={route.at} />}
      </main>
    </div>
  );
}
