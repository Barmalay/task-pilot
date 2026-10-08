# Интеграции

Экран "Интеграции" (`#/integrations`, `IntegrationsPage.tsx`) показывает каждую внешнюю систему: Jira, Confluence,
Bitbucket и Bamboo каждого контура, у которого в профиле есть их MCP-сервер, логи прода, Kibana стендов и Claude.
Список собирает `integrationDefs` (`integrations/registry.ts`) из профилей и `~/.claude.json`: адрес Jira, Bitbucket и
Bamboo дают профили, адрес Confluence и кластера логов прода - env их MCP-сервера. По каждой интеграции видно, что от
нее зависит, и все ее аккаунты с проверкой: сервис сам отвечает, кто владелец доступа (`whoami.ts`: Jira
`/rest/api/2/myself`, Confluence `/rest/api/user/current`, Bitbucket `/plugins/servlet/applinks/whoami`, Bamboo
`/rest/api/latest/currentUser`, Elasticsearch `/_security/_authenticate`, у Kibana стендов только `/api/status`, у
Claude `claude auth status --json`). Проверки кэшируются на 5 минут, одновременные запросы ждут одну.

Доступ "как обычно" - env MCP-сервера из `~/.claude.json` и вход CLI claude, как было без этого экрана; его токен
уходит только на хост системы из профиля. Токен, заведенный на экране, проверяется запросом "кто я" к самой системе
(токен Claude - коротким запуском `claude -p` на haiku), сохраняется в Keychain macOS через `/usr/bin/security`
(значение идет в stdin в шестнадцатеричном виде и не попадает в аргументы процесса) и сразу становится активным; в
базе (`integration_accounts`, `integration_settings`) лежат только подпись, владелец и последние символы. Активный
токен подменяет адрес и токен, у Bitbucket и логин, в env MCP-сервера интеграции (`effectiveServers`), остальное env
берется из `~/.claude.json` как есть, а сервер, которого там нет, запускается пакетом из `DEFAULT_MCP`. Смена
действует без перезапуска: `McpHub` открывает новое подключение, как только конфигурация сервера изменилась, и
закрывает старое после вызовов, которые в нем уже идут, порт Bamboo контура и клиент логов прода пересоздаются по env,
REST Jira берет текущий токен при каждом запросе, новые агенты получают текущий доступ, а агент, который уже работает,
доделывает шаг со старым. При токене Task Pilot шаги назначают задачи на владельца токена, а не на `me` личных настроек
(`jiraProfile`), наблюдатель по нему же отличает свои комментарии. Если при запуске токен активного аккаунта не
прочитался из Keychain, интеграция возвращается к доступу "как обычно" с объяснением в ленте: Task Pilot не ходит
молча под другим доступом, чем выбран.

Аккаунты Claude бывают трех видов. Вход через браузер: Task Pilot создает папку аккаунта в `~/.task-pilot/claude/<id>`
(`TASK_PILOT_CLAUDE_ACCOUNTS`), кладет в нее ссылки на общее из `~/.claude` (`SHARED_CLAUDE`: CLAUDE.md, настройки,
скиллы, агенты, команды, плагины, сессии) и запускает в ней `claude auth login`: CLI сам открывает браузер, а если
вход закончился кодом, его вставляют на экране. Вход в `~/.claude` и сессии владельца при этом не меняются, а агенты
работают с `CLAUDE_CONFIG_DIR` этой папки. Папка лежит вне `.data`: скиллы агент читает по пути внутри нее. Токен
`claude setup-token` идет агентам в `CLAUDE_CODE_OAUTH_TOKEN`, ключ API - в `ANTHROPIC_API_KEY`. Удаление аккаунта
удаляет токен из Keychain, у входа через браузер - выходит из аккаунта и удаляет папку, сначала сняв ссылки на общее.
Маршруты: `GET /api/integrations`, `POST /api/integrations/:id/check`, `POST /api/integrations/:id/accounts`,
`PATCH /api/integrations/:id`, `DELETE /api/integrations/:id/accounts/:account`, `POST /api/integrations/claude/logins`,
`POST /api/integrations/claude/logins/:id/code`, `DELETE /api/integrations/claude/logins/:id`. Смена доступа идет
событием `integration.changed` в общий поток: экран, шапка и после смены Jira доска перечитываются.
