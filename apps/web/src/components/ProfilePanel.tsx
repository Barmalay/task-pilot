import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { Bot, ExternalLink, History as HistoryIcon, KeyRound, MonitorCheck, UserRound, UsersRound, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { api } from '../api.ts';
import { share, spentText } from '../budget.ts';
import { claudeBadge, jiraBadge, type Shown } from '../integrations.ts';
import { doctorSummary, doctorText, initials, recentRuns, styleText, worstLook } from '../profile.ts';
import { RUN_LOOK } from '../status.tsx';
import { ago, Chip, cx, Drawer, Tip } from '../ui.tsx';
import { DOT } from './BudgetBadge.tsx';

/** Раздел панели: значок, заголовок, ссылка на экран с подробностями и содержимое. */
function Section({ icon: Icon, title, more, children }: { icon: LucideIcon; title: string; more?: { href: string; label: string }; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="size-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold">{title}</h2>
        {more && (
          <a href={more.href} className="ml-auto text-xs font-medium text-blue-700 hover:underline dark:text-blue-300">
            {more.label}
          </a>
        )}
      </div>
      <div className="space-y-1.5 text-sm">{children}</div>
    </section>
  );
}

/** Строка раздела: подпись слева, значение справа. */
function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const row = (
    <div className="flex min-w-0 gap-3">
      <span className="w-28 shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 break-words text-slate-800 dark:text-slate-100">{children}</span>
    </div>
  );
  return hint ? (
    <Tip text={hint} className="w-full">
      {row}
    </Tip>
  ) : (
    row
  );
}

/** Путь или имя в моноширинном шрифте. */
const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-xs break-all">{children}</span>;

/** Не задано: подсказка, что и где указать. */
const Missing = ({ children }: { children: ReactNode }) => <span className="text-amber-700 dark:text-amber-300">{children}</span>;

/** Аккаунт интеграции: точка состояния, подпись и объяснение при наведении. */
function Account({ icon: Icon, label, shown }: { icon: LucideIcon; label: string; shown: Shown }) {
  return (
    <Tip text={shown.title} className="w-full">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cx('size-2 shrink-0 rounded-full', DOT[shown.look])} aria-hidden />
        <Icon className="size-3.5 shrink-0 text-slate-500" aria-hidden />
        <span className="w-14 shrink-0 text-slate-500">{label}</span>
        <span className="min-w-0 truncate">{shown.text}</span>
      </div>
    </Tip>
  );
}

/** Полоса расхода: доля лимита, у исчерпанного - красная. */
function Bar({ value }: { value: number | null }) {
  if (value === null) return null;
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      <div className={cx('h-full rounded-full', value >= 1 ? 'bg-red-500' : value >= 0.8 ? 'bg-amber-500' : 'bg-blue-500')} style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

/** Состояния аккаунтов для кнопки профиля и панели; сервер не ответил - оба красные. */
function useAccounts() {
  const account = useQuery({ queryKey: ['account'], queryFn: api.account, staleTime: 5 * 60_000 });
  const failed: Shown | null = account.error ? { look: 'fail', text: 'сервер не отвечает', title: `Не удалось узнать вход: ${account.error.message}` } : null;
  const jira = failed ?? jiraBadge(account.data?.jira);
  const claude = failed ?? claudeBadge(account.data?.claude);
  // Кто "вы": владелец активного доступа к Jira, пока он неизвестен - логин, на который шаги назначают задачи.
  const login = account.data ? (account.data.jira.active.check?.login ?? account.data.jira.me) : '';
  return { jira, claude, login };
}

/**
 * Панель профиля: команда (пакет, слой компании, доска, репозитории, стенды, скиллы агентов), личные настройки этой
 * машины, аккаунты Jira и Claude, расход агентов, последние прогоны и окружение с сервером. Все, что раньше
 * приходилось искать по подвкладкам "Конвейера" и "Настроек", здесь одним взглядом, а ссылки ведут на экраны с
 * подробностями.
 */
function ProfileDrawer({ onClose }: { onClose: () => void }) {
  const { jira, claude, login } = useAccounts();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });
  const budget = useQuery({ queryKey: ['budget'], queryFn: api.budget, refetchInterval: 60_000 });
  const runs = useQuery({ queryKey: ['runs', 'recent'], queryFn: api.recentRuns, staleTime: 30_000 });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: api.catalog, staleTime: 60_000 });
  // Проверка окружения запускает программы машины: она идет, только пока панель открыта, и живет пять минут.
  const doctor = useQuery({ queryKey: ['doctor'], queryFn: api.doctor, staleTime: 5 * 60_000 });
  const service = useQuery({ queryKey: ['service'], queryFn: api.service, staleTime: 60_000 });

  const team = me.data?.team;
  const personal = me.data?.personal;
  const presetTitle = (id: string) => catalog.data?.presets.find((p) => p.id === id)?.title ?? id;
  const env = doctor.data ? doctorSummary(doctor.data.checks) : null;
  const restart = service.data ? service.data.server.changed.length > 0 || service.data.server.installNeeded : false;

  return (
    <Drawer
      label="Профиль"
      onClose={onClose}
      header={
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-blue-600 text-sm font-semibold text-white">{initials(login, team?.title ?? '')}</span>
          <div className="min-w-0">
            <div className="truncate font-semibold">{login || 'Логин Jira не задан'}</div>
            <div className="truncate text-sm text-slate-500">{team ? `${team.title}${team.company ? `, слой компании ${team.company.id}` : ''}` : 'Команда загружается'}</div>
          </div>
        </div>
      }
    >
      <Section icon={UsersRound} title="Команда">
        {me.error && <Missing>Профиль команды не загрузился: {me.error.message}</Missing>}
        {team && (
          <>
            <Row label="Команда" hint={`Пакет команды: ${team.dir}`}>
              {team.title} <span className="text-slate-400">({team.id})</span>
            </Row>
            <Row label="Слой компании" hint={team.company ? `Папка ${team.company.dir}: контуры, конфиг деплоя, логи, адрес Jira` : 'Контуры и соглашения компании команда описывает сама'}>
              {team.company ? team.company.id : 'нет'}
            </Row>
            <Row label="Доска">
              {team.board ? (
                <a href={team.board.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300">
                  {team.board.name}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : (
                <span className="text-slate-500">не задана: экран задач показывает только ваши</span>
              )}
            </Row>
            <Row label="Статусы">
              <span className="text-xs">{team.statuses.join(' → ')}</span>
            </Row>
            <Row label="Стенды">{team.stands}</Row>
            <Row label="Скиллы" hint="Скиллы агентов из team.yaml пакета команды: по ним агент проверяет задачу на стенде и пишет страницу вики">
              <span className="space-y-0.5">
                <span className="block">
                  тест на стенде: {team.skills.qa ? <Mono>{team.skills.qa}</Mono> : <span className="text-slate-500">не задан</span>}
                </span>
                <span className="block">
                  вики: {team.skills.wiki ? <Mono>{team.skills.wiki}</Mono> : <span className="text-slate-500">не задан</span>}
                  {team.wikiSpace && <span className="text-slate-500">, пространство {team.wikiSpace}</span>}
                </span>
              </span>
            </Row>
            <details className="group">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">Репозитории: {team.repos.length}</summary>
              <ul className="mt-1.5 space-y-1 border-l-2 border-slate-100 pl-3 dark:border-slate-800">
                {team.repos.map((r) => (
                  <li key={r.id} className="min-w-0">
                    <span className="text-slate-800 dark:text-slate-100">{r.title}</span>
                    {r.default && (
                      <Chip tone="blue" className="ml-1.5">
                        по умолчанию
                      </Chip>
                    )}
                    <div>
                      <Mono>{r.path}</Mono>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </Section>

      <Section icon={UserRound} title="Личные настройки">
        {personal && (
          <>
            <Row label="Логин Jira" hint="На этот логин шаги назначают задачи, если активный токен Jira не говорит другого">
              {personal.me || <Missing>не задан: укажите me в {personal.file}</Missing>}
            </Row>
            <Row label="JDK 21">{personal.javaHome ? <Mono>{personal.javaHome}</Mono> : <Missing>не задан: сборки Java не пойдут</Missing>}</Row>
            <Row label="Стиль текстов" hint="Что линтер сам правит в ваших публикуемых текстах: style в личных настройках">
              {styleText(personal.style)}
            </Row>
            <Row label="Файл">{personal.exists ? <Mono>{personal.file}</Mono> : <Missing>нет файла {personal.file}</Missing>}</Row>
          </>
        )}
      </Section>

      <Section icon={KeyRound} title="Аккаунты" more={{ href: '#/integrations', label: 'Сменить' }}>
        <Account icon={UserRound} label="Jira" shown={jira} />
        <Account icon={Bot} label="Claude" shown={claude} />
      </Section>

      <Section icon={Wallet} title="Расход агентов" more={{ href: '#/history', label: 'Лимиты' }}>
        {budget.data && (
          <>
            <div>
              <div className="flex justify-between">
                <span className="text-slate-500">Сегодня</span>
                <span>{spentText(budget.data.day)}</span>
              </div>
              <Bar value={share(budget.data.day)} />
            </div>
            <div>
              <div className="flex justify-between">
                <span className="text-slate-500">Эта неделя</span>
                <span>{spentText(budget.data.week)}</span>
              </div>
              <Bar value={share(budget.data.week)} />
            </div>
          </>
        )}
      </Section>

      <Section icon={HistoryIcon} title="Последние прогоны" more={{ href: '#/history', label: 'Вся история' }}>
        {runs.data && !runs.data.length && <div className="text-slate-500">Прогонов пока нет: откройте задачу на доске или по ключу в шапке</div>}
        <ul className="-mx-2">
          {recentRuns(runs.data ?? []).map((r) => (
            <li key={r.id}>
              <a href={`#/runs/${r.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800">
                <span className="font-mono text-xs font-medium text-blue-700 dark:text-blue-300">{r.issueKey}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{presetTitle(r.presetId)}</span>
                <Chip tone={RUN_LOOK[r.status].tone}>{RUN_LOOK[r.status].label}</Chip>
                <span className="w-20 shrink-0 text-right text-xs text-slate-400">{ago(r.updatedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={MonitorCheck} title="Окружение и сервер" more={{ href: '#/environment', label: 'Подробнее' }}>
        {doctor.isPending && <div className="text-slate-500">Проверяю окружение</div>}
        {env && !env.issues.length && <div className="text-emerald-700 dark:text-emerald-300">Все в порядке</div>}
        {env && env.issues.length > 0 && (
          <>
            <div>{doctorText(env)}</div>
            <ul className="space-y-1">
              {env.issues.slice(0, 4).map((c) => (
                <li key={c.id}>
                  <Tip text={c.fix ? `${c.detail}. Как исправить: ${c.fix}` : c.detail} className="w-full">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cx('size-2 shrink-0 rounded-full', DOT[c.level === 'fail' ? 'fail' : 'warn'])} aria-hidden />
                      <span className="truncate">{c.title}</span>
                    </span>
                  </Tip>
                </li>
              ))}
            </ul>
          </>
        )}
        {service.data && (
          <Row label="Сервер">
            запущен {ago(service.data.server.startedAt)}
            {restart && (
              <a href="#/service" className="ml-1.5">
                <Chip tone="amber">нужен перезапуск</Chip>
              </a>
            )}
          </Row>
        )}
      </Section>
    </Drawer>
  );
}

/**
 * Кнопка профиля в шапке: буквы логина с точкой худшего состояния аккаунтов и, на самом широком экране, команда и
 * логин.
 * Открывает панель профиля справа.
 */
export function ProfileButton() {
  const [open, setOpen] = useState(false);
  const { jira, claude, login } = useAccounts();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });
  const team = me.data?.team.title ?? '';
  const look = worstLook([jira.look, claude.look]);
  const problem = [jira, claude].find((s) => s.look === 'fail' || s.look === 'warn');
  return (
    <>
      <Tip text={`Профиль: команда, личные настройки, аккаунты, расход агентов и последние прогоны${problem ? `. ${problem.title}` : ''}`}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label="Профиль"
          data-profile
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-200 p-0.5 transition-colors hover:bg-slate-50 2xl:pr-3 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <span className="relative grid size-7 place-items-center rounded-full bg-blue-600 text-xs font-semibold text-white">
            {initials(login, team)}
            <span className={cx('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-white dark:ring-slate-900', DOT[look])} aria-hidden />
          </span>
          <span className="hidden max-w-56 truncate text-xs 2xl:inline">
            <span className="font-semibold">{team}</span>
            {team && login && <span className="text-slate-400"> · </span>}
            <span className="text-slate-600 dark:text-slate-300">{login}</span>
          </span>
        </button>
      </Tip>
      {open && <ProfileDrawer onClose={() => setOpen(false)} />}
    </>
  );
}
