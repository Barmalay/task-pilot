# Учебный слой компании Example

Слой вымышленной компании Example: на нем работают тесты Task Pilot (пакет `apps/server/test/fixtures/team`), а по
нему видно, как описать свою компанию. В слое лежит общее для команд компании: контуры git и Bamboo с их
соглашениями, репозитории конфига деплоя, источники логов стендов, адрес Jira и id ее полей, кластер логов прода для
панели мониторинга и общий линтер текстов. Пакет команды называет слой полем `company: example` в `team.yaml`, и
профили отсюда ложатся под профили команды (`docs/team-pack.md`). Своего у команды здесь нет: репозитории сервисов,
стенды Keycloak, доска и сервисы мониторинга лежат в ее пакете.

| Файл | Что |
|---|---|
| `contours/cloud.yaml` | контур cloud: git.cloud.example.com и bamboo.cloud.example.com, стенды описаны в пакете команды |
| `contours/core.yaml` | контур core: git.example.com и bamboo.example.com, правило стендов из Bamboo |
| `repos/k8s-ansible-cloud.yaml`, `repos/k8s-ansible-core.yaml` | конфиг деплоя обоих контуров (DEVOPS/k8s-ansible) |
| `logs.yaml` | тестовая Kibana: индексы стендов контура cloud (`kibana-cloud`) и сервисов контура core (`kibana-core`) |
| `jira.yaml` | jira.example.com, MCP-сервер `atlassian`, поле спринта `customfield_10330` и эпика `customfield_10933` |
| `monitor.yaml` | логи прода es-prod через MCP-сервер `elasticsearch`, Kibana прода kibana.example.com |
| `lint.yaml` | имена, которые нельзя упоминать в публичных текстах, и разрешенные адреса почты, общие для команд |

## Контуры

Оба контура подключены (`connected: true`) и описывают одни и те же соглашения Bamboo. Прод запрещен по слову prod
всегда, а сверх него по `prodLike: reserve|staging`; стенд по умолчанию у прогона - Stable (`defaultStand: ^stable`),
при смене репозитория на другой контур стенд переходит на Stable этого контура. Тег образа сборки ветки плана -
`1.0.<номер сборки>-<номер ветки плана>`, сборки самого плана - `1.0.<номер>-master`, а релиз основной ветки называется
`release-<номер>` (`builds`). Production-Cloud (24674389) в cloud и Production, Reserve и Staging всех четырех
сервисов контура core перечислены в `forbiddenBambooEnvIds`: токен Bamboo технически разрешает туда деплой, Task
Pilot - никогда.

Контур cloud ходит в Bitbucket через MCP-сервер `bitbucket`, в Bamboo - через `bamboo-cloud`. Контур core
подключен так же: Bitbucket `bitbucket-core` (MCP-сервера в `~/.claude.json` нет, Task Pilot запускает его сам с
токеном с экрана "Интеграции"), Bamboo из MCP-сервера `bamboo`. Для core на экране "Интеграции" нужен HTTP access
token git.example.com: им идут и PR, и git fetch и push. При активном токене Bitbucket `createGit` передает git
заголовок `Authorization` через `GIT_CONFIG_COUNT` и `http.<адрес>.extraHeader`, только для хоста этого Bitbucket и не
в аргументах процесса, а без токена git берет учетные данные из Keychain.

## Стенды

Стенды контура cloud с адресом Keycloak и realm описывает пакет команды (`profiles/stands`), путь проверки живости у
них - well-known realm (`health: /auth/realms/{realm}/.well-known/openid-configuration`).

Стенды контура core в файлах не описаны: контур задает правило `stands`, а список окружений и их id Task Pilot читает
из Bamboo - дашборды проектов деплоя сервисов контура - при запуске и раз в час. Стендами становятся Stable и тестовые
окружения Testing-* (`include: ^(Stable|Testing-.+)$`), id стенда - `core-` плюс имя окружения в нижнем регистре,
namespace - имя в нижнем регистре, логи - источник `kibana-core`. У mobile, api, adapter и proxy свои проекты деплоя,
и Stable у каждого со своим id, поэтому стенд хранит окружение каждого сервиса (`bambooEnvIds`), а сервис без
окружения на стенд не деплоится и стенда не видит.

Адреса Keycloak у стендов контура core нет, зато у каждого сервиса свой адрес: `serviceUrl`
`https://{service}-{host}.test.example.com`, где `{host}` - namespace стенда с `team-` вместо `testing-` (Stable -
mobile-stable.test.example.com, Testing-A-0 - mobile-team-a-0.test.example.com). Путь здоровья задает профиль сервиса
в пакете команды (`health`: у сервисов на Java `/health/readiness`, у proxy его нет). Сервисы отвечают с заголовком
`x-environment` (`serviceHeader` контура), равным namespace стенда: адрес сервиса на тестовом стенде, где его нет,
отвечает со Stable, и один код 200 принял бы чужой ответ за свой.

## Конфиг деплоя

Конфиг деплоя сервисов контура cloud - профиль `k8s-ansible-cloud` (DEVOPS/k8s-ansible на git.cloud.example.com),
сервисов контура core - `k8s-ansible-core` (DEVOPS/k8s-ansible на git.example.com); на них ссылаются `deployRepo`
репозиториев команды, и `ansible.config` работает с обоими одинаково. Метка задачи `repo:DEVOPS/k8s-ansible` выбирает
k8s-ansible контура cloud: `pickRepo` ставит репозиторий, который перечисляет метку в своем профиле, выше совпавшего
только по имени в Bitbucket. Fetch конфига деплоя идет только по ветке задачи и базовой: в репозитории бывают ветки,
различающиеся только регистром, и полный fetch на macOS падает.

Скрипт деплоя контура cloud берет ветку k8s-ansible задачи сам, если она названа как ветка релиза. Деплой контура core
ветку задачи сам не берет, даже названную как ветка релиза: ее задает только форма Customize Deploy
(`https://bamboo.example.com/plugins/deploy/customDeploymentVersion.action`), поэтому в профиле контура
`deploy.ansibleBranch: customize`, и деплой с веткой задачи там всегда полуавтоматический: Deploy в форме жмет
владелец. Скрипт деплоя контура core клонирует k8s-ansible и после хода клона (десятки строк git "Updating files")
печатает его текущую ветку строкой `* <ветка>`, а потом идет вывод ansible: `ansibleBranchOf` ищет эту строку между
клоном и выводом ansible, поэтому сверка ветки после деплоя работает и в core, а релиз, выкаченный с конфигом не из
той ветки, не засчитывается готовым. Релизы веток задач называются по ветке плана Bamboo через дефис
(`feature-TEAM-2586-4`), а ветки k8s-ansible - по ветке git через слэш (`feature/TEAM-2586`).

## Сборки

Сервисы Java собираются офлайн (`mvn -o`, у mobile и api с номерами сборки в параметрах: в их pom нет значений по
умолчанию); proxy на Go локально не собирается, его сборку делает только Bamboo, поэтому у него в профиле нет команды
сборки. Команды сборки задают профили репозиториев в пакете команды.

## Логи

Тестовая Kibana отвечает без авторизации, запросы идут через console proxy. Стенды контура cloud пишут в
`cloud-k8s-*` (источник `kibana-cloud`, поля Kubernetes как у filebeat), сервисы контура core - в `core-k8s-*`
(`kibana-core`): образ пода в `kubernetes.container.image.keyword`, текст записи в `messagetext`, логгер в `logger`.
Логи прода панели мониторинга - кластер es-prod: адрес `ES_URL` и ключ только на чтение `ES_API_KEY` берутся из `env`
MCP-сервера `elasticsearch`; MCP-инструменты с таким ключом отвечают 403, а `_search` и `_msearch` работают, поэтому
Task Pilot ходит в кластер напрямую.
