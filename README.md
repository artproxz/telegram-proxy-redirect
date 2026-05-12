# MTProto Proxy Hub для GitHub Pages

Проект собирает публичные MTProto-прокси, проверяет TCP-доступность, обновляет `proxies.json` через GitHub Actions и показывает серверы красивыми карточками на статическом HTML-сайте.

## Что внутри

```text
.
├── .github/workflows/update-proxies.yml   # обновление списка 4 раза в день
├── .github/workflows/cleanup.yml          # очистка старых запусков Actions
├── fetch-proxies.js                       # сбор, парсинг, TCP-проверка, уведомления
├── index.html                             # сайт с карточками прокси
├── proxies.json                           # данные для сайта
└── README.md                              # инструкция
```

## Как запустить

### 1. Залей файлы в репозиторий

Скопируй все файлы из архива в корень GitHub-репозитория и сделай commit/push в основную ветку, обычно `main`.

### 2. Включи GitHub Pages

1. Открой репозиторий на GitHub.
2. Перейди в **Settings → Pages**.
3. В блоке **Build and deployment** выбери:
   - **Source:** Deploy from a branch;
   - **Branch:** `main`;
   - **Folder:** `/root`.
4. Нажми **Save**.

После публикации сайт будет доступен по адресу вида:

```text
https://USERNAME.github.io/REPOSITORY/
```

### 3. Проверь права GitHub Actions

Открой **Settings → Actions → General → Workflow permissions** и включи вариант, который разрешает workflow записывать изменения в репозиторий. В самом workflow уже стоит:

```yaml
permissions:
  contents: write
```

Это нужно, чтобы GitHub Actions мог обновлять `proxies.json` и пушить commit.

### 4. Запусти первое обновление вручную

1. Перейди во вкладку **Actions**.
2. Открой workflow **Update MTProto proxies**.
3. Нажми **Run workflow**.
4. После успешного запуска открой `proxies.json` или сайт.

## Расписание проверки

Проверка настроена на Europe/Paris:

```text
09:17, 13:17, 17:17, 21:17
```

То есть обновление идет примерно каждые 4 часа, а с 23:00 до 09:00 проверок нет.

Минуты выставлены на `17`, а не на `00`, чтобы снизить шанс задержек на стороне GitHub Actions в начале часа.

## Уведомления о новых прокси

Есть два варианта уведомлений.

### Вариант A — уведомления в Telegram

1. Создай бота через `@BotFather`.
2. Получи токен бота.
3. Узнай свой `chat_id`. Проще всего написать боту любое сообщение и открыть:

```text
https://api.telegram.org/bot<TOKEN>/getUpdates
```

4. В репозитории открой **Settings → Secrets and variables → Actions → New repository secret**.
5. Добавь секреты:

```text
TELEGRAM_BOT_TOKEN = токен бота
TELEGRAM_CHAT_ID = твой chat_id
```

После этого при появлении новых прокси workflow отправит сообщение.

### Вариант B — Discord webhook

Добавь secret:

```text
DISCORD_WEBHOOK_URL = URL webhook Discord
```

Можно использовать и Telegram, и Discord одновременно.

### Браузерные уведомления на сайте

На сайте есть кнопка **«Включить уведомления в браузере»**. Она работает только пока страница открыта в браузере. Для настоящих уведомлений без открытого сайта используй Telegram Bot или Discord webhook.

## Как добавить или заменить источники

По умолчанию используются публичные источники из `fetch-proxies.js`:

```js
const DEFAULT_SOURCES = [
  'https://t.me/s/ProxyMTProto',
  'https://t.me/s/MTProtoProxies',
  'https://t.me/s/ProxyFree_Ru',
  'https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt',
  'https://raw.githubusercontent.com/Grim1313/mtproto-for-telegram/master/all_proxies.txt'
];
```

Если хочешь менять источники без редактирования кода:

1. Открой **Settings → Secrets and variables → Actions → Variables**.
2. Создай variable `SOURCE_URLS`.
3. Укажи список URL через запятую или с новой строки.

Поддерживаются:

- `tg://proxy?...` ссылки;
- страницы Telegram `https://t.me/s/...`;
- raw `.txt` списки;
- текстовый формат `server:port:secret`;
- блоки `Server / Port / Secret`.

## Как работает проверка

Скрипт делает только TCP-подключение к `server:port`, который уже найден в публичном источнике. Это не сканер портов и не проверка Telegram-протокола. Если TCP открыт, сервер попадает выше в списке как `online`. Если проверенных мало, сайт может показать свежие, но непроверенные записи со статусом `свежий, не проверен`.

## Частые проблемы

### Actions запускается, но `proxies.json` не обновляется

Проверь **Settings → Actions → General → Workflow permissions**. Нужны права на запись. Также убедись, что workflow находится в основной ветке.

### Сайт показывает старые данные

Подожди 1–3 минуты после commit от Actions и обнови страницу с очисткой кэша: `Ctrl + F5` или `Cmd + Shift + R`.

### Нет уведомлений в Telegram

Проверь:

- бот создан и токен указан в `TELEGRAM_BOT_TOKEN`;
- ты написал боту хотя бы одно сообщение;
- `TELEGRAM_CHAT_ID` указан без лишних пробелов;
- в запуске Actions нет ошибки `Notify failed`.

### Очень мало рабочих серверов

Бесплатные публичные MTProto-прокси быстро умирают. Добавь больше проверенных источников через `SOURCE_URLS` или подключи свои серверы в таком формате:

```text
tg://proxy?server=example.com&port=443&secret=ee00000000000000000000000000000000000000
```

## Локальный тест

На компьютере с Node.js 20+ можно проверить генерацию так:

```bash
node fetch-proxies.js
```

Потом открой `index.html` через простой локальный сервер:

```bash
python -m http.server 8000
```

И перейди на:

```text
http://localhost:8000
```
