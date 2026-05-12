# MTProto Proxy Radar

Красивое статическое табло для Telegram MTProto-прокси с автоматической проверкой поставщиков через GitHub Actions.

## Что изменено

- Интерфейс полностью переработан: табло, карточки, метрики, фильтры, поиск, статусы поставщиков, адаптивная верстка.
- Рабочие серверы теперь проверяются не браузерным трюком, а в `fetch-proxies.js` через TCP-connect.
- В `proxies.json` сохраняются `online`, `pingMs`, `checkedAt`, `provider`, `changeType`, `firstSeenAt`, `updatedAt`.
- Новые и обновленные серверы подсвечиваются анимацией, а внутри страницы появляется уведомление.
- Можно включить браузерные уведомления. Они работают, когда страница открыта и браузер разрешил Notification API.
- Переход по прокси помечает карточку как использованную только у текущего пользователя/браузера через `localStorage`.
- Использованный сервер не удаляется: он тухнет, но кнопку подключения можно нажать повторно.
- GitHub Actions настроен на проверку поставщиков по расписанию: 08:30, 12:30, 16:30, 20:30 и 22:00 по МСК. Ночью автообновление не запускается.

## Файлы

```text
.github/workflows/update-proxies.yml  # расписание и запуск проверки
.github/workflows/cleanup.yml         # очистка старых workflow runs
fetch-proxies.js                      # парсинг поставщиков + TCP-проверка
index.html                            # frontend табло
proxies.json                          # результат последней проверки
README.md                             # эта инструкция
```

## Запуск локально

> Открывать `index.html` двойным кликом не надо: браузер может заблокировать `fetch('./proxies.json')` через `file://`.

### Вариант 1. Через Python

```bash
cd telegram-proxy-redirect-main
python -m http.server 8080
```

Открой:

```text
http://localhost:8080
```

### Вариант 2. Через Node.js

```bash
cd telegram-proxy-redirect-main
npx serve .
```

## Ручное обновление прокси локально

Нужен Node.js 20+ или 22+.

```bash
cd telegram-proxy-redirect-main
node fetch-proxies.js
```

После выполнения обновится `proxies.json`, затем обнови страницу в браузере.

## Запуск на GitHub Pages

1. Залей файлы в репозиторий.
2. Открой `Settings` → `Pages`.
3. В `Build and deployment` выбери:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
4. Открой `Actions` → `Fetch Telegram Proxies` → `Run workflow`.
5. После первого успешного запуска в репозитории обновится `proxies.json`, а табло начнет показывать проверенные серверы.

## Как менять поставщиков

По умолчанию в `fetch-proxies.js` используются каналы:

```js
const DEFAULT_PROVIDERS = [
  { name: 'ProxyFree_Ru', url: 'https://t.me/s/ProxyFree_Ru' },
  { name: 'ProxyMTProto', url: 'https://t.me/s/ProxyMTProto' },
  { name: 'TelMTProto', url: 'https://t.me/s/TelMTProto' },
  { name: 'MTP_roto', url: 'https://t.me/s/MTP_roto' }
];
```

Можно заменить их прямо в коде или передать свои URL через переменную окружения `PROXY_PROVIDERS`:

```bash
PROXY_PROVIDERS="https://t.me/s/channel1,https://t.me/s/channel2" node fetch-proxies.js
```

## Как менять расписание

Сейчас расписание в `.github/workflows/update-proxies.yml` задано под МСК UTC+3:

```yaml
- cron: '30 5,9,13,17 * * *'  # 08:30, 12:30, 16:30, 20:30 МСК
- cron: '0 19 * * *'          # 22:00 МСК
```

Если нужно время другого часового пояса, меняй cron, потому что GitHub Actions всегда использует UTC.

## Важный момент про “настоящий пинг”

Браузер не умеет честно делать ICMP ping или TCP ping до произвольного MTProto-сервера. Поэтому старый способ через загрузку `https://server:port/favicon.ico` был ненадежным. В этой версии задержка считается в GitHub Actions как время TCP-подключения до `server:port`. Это честнее для проверки доступности MTProto-прокси, хотя это не ICMP ping.
