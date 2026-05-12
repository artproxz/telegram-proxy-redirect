const https = require('https');
const fs = require('fs');
const net = require('net');

const OUTPUT_FILE = 'proxies.json';
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 80);
const MAX_PROXIES = Number(process.env.MAX_PROXIES || 24);
const TCP_TIMEOUT_MS = Number(process.env.TCP_TIMEOUT_MS || 3500);
const CHECK_CONCURRENCY = Number(process.env.CHECK_CONCURRENCY || 16);

// GitHub cron настроен под московское время UTC+3.
// Если нужно другое время — поменяй workflow cron и эту подпись в schedule.
const SCHEDULE_TZ = 'Europe/Moscow';
const SCHEDULE_TZ_OFFSET_MINUTES = 180;
const SCHEDULE_POINTS = [
  { hour: 8, minute: 30, label: '08:30' },
  { hour: 12, minute: 30, label: '12:30' },
  { hour: 16, minute: 30, label: '16:30' },
  { hour: 20, minute: 30, label: '20:30' },
  { hour: 22, minute: 0, label: '22:00' }
];

const DEFAULT_PROVIDERS = [
  { name: 'ProxyFree_Ru', url: 'https://t.me/s/ProxyFree_Ru' },
  { name: 'ProxyMTProto', url: 'https://t.me/s/ProxyMTProto' },
  { name: 'TelMTProto', url: 'https://t.me/s/TelMTProto' },
  { name: 'MTP_roto', url: 'https://t.me/s/MTP_roto' }
];

const PROVIDERS = (process.env.PROXY_PROVIDERS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean)
  .map((url, index) => ({ name: `custom_${index + 1}`, url }))
  .concat(process.env.PROXY_PROVIDERS ? [] : DEFAULT_PROVIDERS);

const FLAG_MAP = [
  [/\.ru$/i, '🇷🇺'], [/\.de$/i, '🇩🇪'], [/\.nl$/i, '🇳🇱'], [/\.fr$/i, '🇫🇷'],
  [/\.fi$/i, '🇫🇮'], [/\.uk$/i, '🇬🇧'], [/\.co\.uk$/i, '🇬🇧'], [/\.us$/i, '🇺🇸'],
  [/\.sg$/i, '🇸🇬'], [/\.ir$/i, '🇮🇷'], [/\.ae$/i, '🇦🇪'], [/\.tr$/i, '🇹🇷'],
  [/\.pl$/i, '🇵🇱'], [/\.by$/i, '🇧🇾'], [/^185\./, '🇳🇱'], [/^91\.107\./, '🇩🇪'],
  [/^65\.109\./, '🇫🇮'], [/^51\.15\./, '🇫🇷'], [/^149\.154\./, '🇬🇧']
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7'
      }
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function decodeHtml(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=');
}

function stripTrailingGarbage(value) {
  return String(value || '')
    .trim()
    .replace(/[),.;<>'"\]\s]+$/g, '')
    .replace(/^['"\s]+/g, '');
}

function normalizeSecret(secret) {
  let result = stripTrailingGarbage(secret);
  try { result = decodeURIComponent(result); } catch (_) {}
  return result.replace(/\s/g, '');
}

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  if (/unknown|null|undefined/i.test(host)) return false;
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host) || /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function getFlag(server) {
  const clean = String(server || '').toLowerCase();
  for (const [pattern, flag] of FLAG_MAP) {
    if (pattern.test(clean)) return flag;
  }
  return '🌐';
}

function buildRaw(proxy) {
  const server = encodeURIComponent(proxy.server);
  const port = encodeURIComponent(proxy.port);
  const secret = encodeURIComponent(proxy.secret);
  return `tg://proxy?server=${server}&port=${port}&secret=${secret}`;
}

function parseProxyLink(link, providerName, sourceTime) {
  const decoded = decodeHtml(link).trim();
  const query = decoded
    .replace(/^tg:\/\/proxy\?/i, '')
    .replace(/^https?:\/\/(t\.me|telegram\.me)\/proxy\?/i, '')
    .replace(/^https?:\/\/(t\.me|telegram\.me)\/socks\?/i, '');

  const params = new URLSearchParams(query);
  const server = stripTrailingGarbage(params.get('server'));
  const port = stripTrailingGarbage(params.get('port'));
  const secret = normalizeSecret(params.get('secret'));

  if (!isValidHost(server)) return null;
  if (!/^\d{2,5}$/.test(port)) return null;
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) return null;
  if (!secret || secret.length < 16) return null;

  const proxy = {
    id: `${server}:${port}`,
    type: 'MTProto',
    server,
    port: String(portNum),
    secret,
    flag: getFlag(server),
    provider: providerName,
    sourceTime: sourceTime || null,
    raw: ''
  };
  proxy.raw = buildRaw(proxy);
  proxy.fingerprint = `${proxy.server}:${proxy.port}:${proxy.secret}`;
  return proxy;
}

function parseMessageBlocks(html, providerName) {
  const decoded = decodeHtml(html);
  const blocks = decoded.split(/<div[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*>/i).slice(1);
  const chunks = blocks.length ? blocks : [decoded];
  const proxies = [];

  for (const chunk of chunks) {
    const timeMatch = chunk.match(/<time[^>]*datetime="([^"]+)"/i);
    const sourceTime = timeMatch ? new Date(timeMatch[1]).toISOString() : null;

    const links = chunk.match(/(?:tg:\/\/proxy|https?:\/\/(?:t\.me|telegram\.me)\/proxy)\?server=[^\s"'<>]+/gi) || [];
    for (const link of links) {
      const proxy = parseProxyLink(link, providerName, sourceTime);
      if (proxy) proxies.push(proxy);
    }

    const text = chunk.replace(/<[^>]+>/g, ' ');
    const serverMatch = text.match(/(?:server|хост|сервер)\s*[:=]\s*([a-z0-9._-]+)/i);
    const portMatch = text.match(/(?:port|порт)\s*[:=]\s*(\d{2,5})/i);
    const secretMatch = text.match(/(?:secret|ключ)\s*[:=]\s*([A-Za-z0-9_+\-=/]{16,})/i);
    if (serverMatch && portMatch && secretMatch) {
      const proxy = parseProxyLink(
        `tg://proxy?server=${serverMatch[1]}&port=${portMatch[1]}&secret=${secretMatch[1]}`,
        providerName,
        sourceTime
      );
      if (proxy) proxies.push(proxy);
    }
  }
  return proxies;
}

function tcpConnectPing(server, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (online, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        online,
        pingMs: online ? Date.now() - startedAt : null,
        error: error ? String(error.message || error).slice(0, 120) : null
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', err => finish(false, err));
    socket.connect(Number(port), server);
  });
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      result[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function readPrevious() {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return null;
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function nextScheduledUpdate(now = new Date()) {
  const offsetMs = SCHEDULE_TZ_OFFSET_MINUTES * 60 * 1000;
  const localNow = new Date(now.getTime() + offsetMs);
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth();
  const d = localNow.getUTCDate();

  const candidates = [];
  for (const dayShift of [0, 1]) {
    for (const point of SCHEDULE_POINTS) {
      const utc = Date.UTC(y, m, d + dayShift, point.hour, point.minute, 0) - offsetMs;
      candidates.push(new Date(utc));
    }
  }
  return candidates.find(date => date.getTime() > now.getTime()) || candidates[candidates.length - 1];
}

function mergeMetadata(current, previous, nowIso) {
  const previousMap = new Map((previous?.proxies || []).map(p => [p.id || `${p.server}:${p.port}`, p]));

  return current.map(proxy => {
    const old = previousMap.get(proxy.id);
    let changeType = 'new';
    let firstSeenAt = nowIso;
    let updatedAt = nowIso;

    if (old) {
      firstSeenAt = old.firstSeenAt || old.fetchedAt || nowIso;
      updatedAt = old.updatedAt || old.fetchedAt || firstSeenAt;
      changeType = 'same';

      if ((old.fingerprint && old.fingerprint !== proxy.fingerprint) || old.secret !== proxy.secret || old.raw !== proxy.raw) {
        changeType = 'updated';
        updatedAt = nowIso;
      } else if (old.online === false && proxy.online === true) {
        changeType = 'recovered';
        updatedAt = nowIso;
      } else if (typeof old.pingMs === 'number' && typeof proxy.pingMs === 'number') {
        const oldBucket = old.pingMs < 200 ? 'fast' : old.pingMs < 500 ? 'mid' : 'slow';
        const newBucket = proxy.pingMs < 200 ? 'fast' : proxy.pingMs < 500 ? 'mid' : 'slow';
        if (oldBucket !== newBucket) {
          changeType = 'latency_changed';
          updatedAt = nowIso;
        }
      }
    }

    return {
      ...proxy,
      firstSeenAt,
      fetchedAt: proxy.sourceTime || nowIso,
      checkedAt: nowIso,
      updatedAt,
      changeType
    };
  });
}

async function main() {
  const started = new Date();
  const nowIso = started.toISOString();
  const previous = readPrevious();
  const providerReports = [];
  const parsed = [];

  console.log(`🔎 Start provider check: ${nowIso}`);
  for (const provider of PROVIDERS) {
    const report = { name: provider.name, url: provider.url, ok: false, parsed: 0, error: null };
    try {
      const html = await fetchUrl(provider.url);
      const proxies = parseMessageBlocks(html, provider.name);
      report.ok = true;
      report.parsed = proxies.length;
      parsed.push(...proxies);
      console.log(`✅ ${provider.name}: ${proxies.length}`);
    } catch (err) {
      report.error = String(err.message || err);
      console.log(`❌ ${provider.name}: ${report.error}`);
    }
    providerReports.push(report);
  }

  const unique = [];
  const seen = new Set();
  for (const proxy of parsed) {
    if (seen.has(proxy.id)) continue;
    seen.add(proxy.id);
    unique.push(proxy);
  }

  const candidates = unique.slice(0, MAX_CANDIDATES);
  console.log(`📦 Parsed: ${parsed.length}; unique candidates: ${unique.length}; checking: ${candidates.length}`);

  const checked = await mapLimit(candidates, CHECK_CONCURRENCY, async proxy => {
    const result = await tcpConnectPing(proxy.server, proxy.port);
    return { ...proxy, ...result };
  });

  let working = checked
    .filter(p => p.online)
    .sort((a, b) => (a.pingMs ?? 999999) - (b.pingMs ?? 999999))
    .slice(0, MAX_PROXIES);

  let success = working.length > 0;
  let error = null;
  let stale = false;

  if (!success && previous?.proxies?.length) {
    stale = true;
    error = 'Новые рабочие MTProto-прокси не найдены, временно оставлен предыдущий список.';
    working = previous.proxies.map(p => ({ ...p, stale: true, changeType: 'stale', checkedAt: nowIso }));
    console.log('⚠️ No fresh working proxies. Previous list preserved.');
  }

  working = mergeMetadata(working, previous, nowIso);

  const result = {
    success,
    stale,
    count: working.length,
    timestamp: nowIso,
    next_update: nextScheduledUpdate(started).toISOString(),
    schedule: {
      timezone: SCHEDULE_TZ,
      mode: 'Проверка поставщиков каждые 4 часа с 08:30, последнее обновление в 22:00; ночью автообновление отключено.',
      points: SCHEDULE_POINTS.map(p => p.label)
    },
    check: {
      type: 'tcp_connect',
      timeout_ms: TCP_TIMEOUT_MS,
      candidates: candidates.length,
      online: checked.filter(p => p.online).length,
      offline: checked.filter(p => !p.online).length
    },
    providers: providerReports,
    proxies: working,
    error
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`💾 Saved ${working.length} proxies; success=${success}; next=${result.next_update}`);
}

main().catch(err => {
  console.error('💥 Fatal:', err);
  const now = new Date();
  const previous = readPrevious();
  const result = {
    success: false,
    stale: Boolean(previous?.proxies?.length),
    count: previous?.proxies?.length || 0,
    timestamp: now.toISOString(),
    next_update: nextScheduledUpdate(now).toISOString(),
    schedule: { timezone: SCHEDULE_TZ, points: SCHEDULE_POINTS.map(p => p.label) },
    check: { type: 'tcp_connect', timeout_ms: TCP_TIMEOUT_MS, candidates: 0, online: 0, offline: 0 },
    providers: [],
    proxies: previous?.proxies || [],
    error: String(err.message || err)
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
