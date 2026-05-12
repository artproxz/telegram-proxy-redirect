const https = require('https');
const fs = require('fs');
const net = require('net');

const OUTPUT_FILE = 'proxies.json';
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 180);
const MAX_REAL_CANDIDATES = Number(process.env.MAX_REAL_CANDIDATES || 32);
const MAX_PROXIES = Number(process.env.MAX_PROXIES || 10);
const TCP_TIMEOUT_MS = Number(process.env.TCP_TIMEOUT_MS || 2500);
const REAL_TIMEOUT_MS = Number(process.env.REAL_TIMEOUT_MS || 9000);
const TCP_CHECKS = Number(process.env.TCP_CHECKS || 5);
const REAL_CHECKS = Number(process.env.REAL_CHECKS || 5);
const CHECK_CONCURRENCY = Number(process.env.CHECK_CONCURRENCY || 24);
const STRICT_REQUIRED = TCP_CHECKS + REAL_CHECKS;

const SCHEDULE_TZ = 'Europe/Moscow';
const SCHEDULE_TZ_OFFSET_MINUTES = 180;
const SCHEDULE_POINTS = [
  { hour: 8, minute: 30, label: '08:30' },
  { hour: 12, minute: 30, label: '12:30' },
  { hour: 16, minute: 30, label: '16:30' },
  { hour: 20, minute: 30, label: '20:30' },
  { hour: 22, minute: 0, label: '22:00' }
];

// Источники расставлены по приоритету: сначала агрегаторы с автообновлением,
// затем крупные Telegram-каналы со свежими MTProto-ссылками.
const DEFAULT_PROVIDERS = [
  { name: 'SoliSpirit verified feed', url: 'https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt' },
  { name: 'Grim1313 verified mirror', url: 'https://raw.githubusercontent.com/Grim1313/mtproto-for-telegram/master/all_proxies.txt' },
  { name: 'iwh3n/devho3ein working feed', url: 'https://raw.githubusercontent.com/devho3ein/tg-proxy/refs/heads/main/proxys/All_Proxys.txt' },
  { name: 'kort0881 collector RU feed', url: 'https://raw.githubusercontent.com/kort0881/telegram-proxy-collector/main/proxy_ru.txt' },
  { name: 'ProxyMTProto channel', url: 'https://t.me/s/ProxyMTProto' },
  { name: 'MTPro.XYZ channel', url: 'https://t.me/s/mtpro_xyz' },
  { name: 'ProxyFree_Ru channel', url: 'https://t.me/s/ProxyFree_Ru' },
  { name: 'TelMTProto channel', url: 'https://t.me/s/TelMTProto' }
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/plain,text/html,application/json,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchUrl(new URL(res.headers.location, url).toString()).then(resolve, reject);
        return;
      }
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
    .replace(/&#x3D;/g, '=')
    .replace(/&nbsp;/g, ' ');
}

function stripTrailingGarbage(value) {
  return String(value || '')
    .trim()
    .replace(/[),.;<>'"\]\s]+$/g, '')
    .replace(/^[`'"\s]+/g, '')
    .replace(/[`]+$/g, '');
}

function normalizeSecretForLink(secret) {
  let result = stripTrailingGarbage(secret);
  try { result = decodeURIComponent(result); } catch (_) {}
  return result.replace(/\s/g, '');
}

function normalizeSecretForTdlib(secret) {
  const raw = normalizeSecretForLink(secret);
  if (!raw) throw new Error('INVALID_SECRET');

  if (/^[0-9a-fA-F]+$/.test(raw)) {
    if (raw.length % 2 !== 0) throw new Error('INVALID_SECRET');
    return Buffer.from(raw, 'hex').toString('hex').toLowerCase();
  }

  let normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  if (padding !== 0) normalized += '='.repeat(4 - padding);
  const bytes = Buffer.from(normalized, 'base64');
  if (!bytes.length) throw new Error('INVALID_SECRET');
  return bytes.toString('hex').toLowerCase();
}

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  if (/unknown|null|undefined|localhost/i.test(host)) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return host.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
  }
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host);
}

function getFlag(server) {
  const clean = String(server || '').toLowerCase();
  for (const [pattern, flag] of FLAG_MAP) if (pattern.test(clean)) return flag;
  return '🌐';
}

function buildRaw(proxy) {
  return `tg://proxy?server=${encodeURIComponent(proxy.server)}&port=${encodeURIComponent(proxy.port)}&secret=${encodeURIComponent(proxy.secret)}`;
}

function parseProxyLink(link, providerName, sourceTime = null) {
  const decoded = decodeHtml(String(link || '')).trim();
  const query = decoded
    .replace(/^tg:\/\/proxy\?/i, '')
    .replace(/^https?:\/\/(t\.me|telegram\.me)\/proxy\?/i, '')
    .replace(/^https?:\/\/(t\.me|telegram\.me)\/socks\?/i, '');

  const params = new URLSearchParams(query);
  const server = stripTrailingGarbage(params.get('server'));
  const port = stripTrailingGarbage(params.get('port'));
  const secret = normalizeSecretForLink(params.get('secret'));

  if (!isValidHost(server)) return null;
  if (!/^\d{1,5}$/.test(port)) return null;
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) return null;
  if (!secret || secret.length < 16) return null;

  const proxy = {
    id: `${server}:${portNum}:${secret.slice(0, 12)}`,
    shortId: `${server}:${portNum}`,
    type: 'MTProto',
    server,
    port: String(portNum),
    secret,
    secretHex: null,
    flag: getFlag(server),
    provider: providerName,
    sourceTime,
    raw: ''
  };
  proxy.raw = buildRaw(proxy);
  proxy.fingerprint = `${proxy.server}:${proxy.port}:${proxy.secret}`;
  return proxy;
}

function parseAnyText(content, providerName) {
  const decoded = decodeHtml(content);
  const proxies = [];

  const directLinks = decoded.match(/(?:tg:\/\/proxy|https?:\/\/(?:t\.me|telegram\.me)\/proxy)\?server=[^\s"'<>]+/gi) || [];
  for (const link of directLinks) {
    const proxy = parseProxyLink(link, providerName, null);
    if (proxy) proxies.push(proxy);
  }

  const blocks = decoded.split(/<div[^>]*class="[^"]*tgme_widget_message[^"]*"[^>]*>/i).slice(1);
  const chunks = blocks.length ? blocks : decoded.split(/\n{2,}|<br\s*\/?>/i);

  for (const chunk of chunks) {
    const timeMatch = chunk.match(/<time[^>]*datetime="([^"]+)"/i);
    const sourceTime = timeMatch ? new Date(timeMatch[1]).toISOString() : null;
    const text = chunk.replace(/<[^>]+>/g, ' ').replace(/`/g, ' ');

    const serverMatch = text.match(/(?:server|хост|сервер)\s*[:=]\s*([a-z0-9._-]+)/i);
    const portMatch = text.match(/(?:port|порт)\s*[:=]\s*(\d{1,5})/i);
    const secretMatch = text.match(/(?:secret|ключ)\s*[:=]\s*([A-Za-z0-9_+\-=%/]{16,})/i);
    if (serverMatch && portMatch && secretMatch) {
      const proxy = parseProxyLink(`tg://proxy?server=${serverMatch[1]}&port=${portMatch[1]}&secret=${secretMatch[1]}`, providerName, sourceTime);
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
      resolve({ online, pingMs: online ? Date.now() - startedAt : null, error: error ? String(error.message || error).slice(0, 120) : null });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', err => finish(false, err));
    socket.connect(Number(port), server);
  });
}

async function tcpStabilityCheck(proxy, attempts = TCP_CHECKS) {
  const samples = [];
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const result = await tcpConnectPing(proxy.server, proxy.port);
    if (!result.online) {
      lastError = result.error || 'TCP failed';
      return { ok: false, samples, error: lastError };
    }
    samples.push(result.pingMs);
    if (i + 1 < attempts) await sleep(90);
  }
  return { ok: true, samples, error: null };
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
  } catch (_) { return null; }
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
      candidates.push(new Date(Date.UTC(y, m, d + dayShift, point.hour, point.minute, 0) - offsetMs));
    }
  }
  return candidates.find(date => date.getTime() > now.getTime()) || candidates[candidates.length - 1];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function loadTdlib() {
  try {
    const tdl = require('tdl');
    const { Client } = require('tdl');
    const { TDLib } = require('tdl-tdlib-addon');
    const { getTdjson } = require('prebuilt-tdlib');
    tdl.configure({ tdjson: getTdjson() });
    const tdlib = new TDLib();
    const client = new Client(tdlib, {
      apiId: 12345,
      apiHash: '0123456789abcdef0123456789abcdef',
      useTestDc: false,
      databaseDirectory: './tdlib-db',
      filesDirectory: './tdlib-files'
    });
    return client;
  } catch (error) {
    throw new Error(`TDLib dependencies are not installed or unavailable: ${error.message || error}`);
  }
}

function classifyTdlibError(error) {
  const msg = String(error?.response?.message || error?.message || error || 'Unknown error');
  if (/timeout/i.test(msg)) return 'TIMEOUT';
  if (/secret/i.test(msg)) return 'INVALID_SECRET';
  if (/port/i.test(msg)) return 'INVALID_PORT';
  if (/server|hostname|getaddrinfo|ENOTFOUND|DNS/i.test(msg)) return 'DNS_OR_SERVER_ERROR';
  if (/refused|ECONNREFUSED/i.test(msg)) return 'CONNECTION_REFUSED';
  if (/reset|ECONNRESET/i.test(msg)) return 'CONNECTION_RESET';
  if (/Response hash mismatch/i.test(msg)) return 'SECRET_OR_PROXY_MISMATCH';
  return msg.slice(0, 140);
}

async function pingProxyThroughTelegram(client, proxy) {
  const secretHex = proxy.secretHex || normalizeSecretForTdlib(proxy.secret);
  const startedAt = Date.now();
  let proxyObj = null;
  try {
    proxyObj = await client.invoke({
      _: 'addProxy',
      server: proxy.server,
      port: Number(proxy.port),
      enable: true,
      type: { _: 'proxyTypeMtproto', secret: secretHex }
    });
    const proxyId = proxyObj?.id;
    if (!proxyId && proxyId !== 0) throw new Error('TDLib did not return proxy id');
    await Promise.race([
      client.invoke({ _: 'pingProxy', proxy_id: proxyId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), REAL_TIMEOUT_MS))
    ]);
    return { ok: true, pingMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return { ok: false, pingMs: null, error: classifyTdlibError(error) };
  } finally {
    try {
      if (proxyObj?.id || proxyObj?.id === 0) await client.invoke({ _: 'removeProxy', proxy_id: proxyObj.id });
    } catch (_) {}
  }
}

async function realTelegramStrictCheck(client, proxy, attempts = REAL_CHECKS) {
  const samples = [];
  let lastError = null;
  try { proxy.secretHex = normalizeSecretForTdlib(proxy.secret); }
  catch (error) { return { ok: false, samples, error: 'INVALID_SECRET' }; }

  for (let i = 0; i < attempts; i += 1) {
    const result = await pingProxyThroughTelegram(client, proxy);
    if (!result.ok) {
      lastError = result.error || 'REAL_CHECK_FAILED';
      return { ok: false, samples, error: lastError };
    }
    samples.push(result.pingMs);
    if (i + 1 < attempts) await sleep(180);
  }
  return { ok: true, samples, error: null };
}

function mergeMetadata(current, previous, nowIso) {
  const previousMap = new Map((previous?.proxies || []).map(p => [p.fingerprint, p]));
  return current.map(proxy => {
    const old = previousMap.get(proxy.fingerprint);
    return {
      ...proxy,
      firstSeenAt: old?.firstSeenAt || nowIso,
      checkedAt: nowIso,
      updatedAt: nowIso,
      fetchedAt: proxy.sourceTime || nowIso
    };
  });
}

async function collectCandidates() {
  const providerReports = [];
  const parsed = [];

  for (const provider of PROVIDERS) {
    const report = { name: provider.name, url: provider.url, ok: false, parsed: 0, error: null };
    try {
      const content = await fetchUrl(provider.url);
      const proxies = parseAnyText(content, provider.name);
      report.ok = true;
      report.parsed = proxies.length;
      parsed.push(...proxies);
      console.log(`✅ ${provider.name}: parsed ${proxies.length}`);
    } catch (error) {
      report.error = String(error.message || error);
      console.log(`❌ ${provider.name}: ${report.error}`);
    }
    providerReports.push(report);
  }

  const unique = [];
  const seen = new Set();
  for (const proxy of parsed) {
    // Дедуп по полному fingerprint, чтобы один сервер с разными secret не потерять.
    if (seen.has(proxy.fingerprint)) continue;
    seen.add(proxy.fingerprint);
    unique.push(proxy);
  }

  return { providerReports, unique };
}

async function main() {
  const started = new Date();
  const nowIso = started.toISOString();
  const previous = readPrevious();
  console.log(`🔎 Start REAL Telegram MTProto check: ${nowIso}`);
  console.log(`Rule: ${REAL_CHECKS} TDLib pingProxy checks + ${TCP_CHECKS} TCP checks = ${STRICT_REQUIRED}/${STRICT_REQUIRED}`);

  const { providerReports, unique } = await collectCandidates();
  const candidates = unique.slice(0, MAX_CANDIDATES);
  console.log(`📦 Unique candidates: ${unique.length}; quick TCP shortlist from: ${candidates.length}`);

  const quickChecked = await mapLimit(candidates, CHECK_CONCURRENCY, async proxy => {
    const first = await tcpConnectPing(proxy.server, proxy.port);
    return { ...proxy, tcpFirstOk: first.online, tcpFirstPingMs: first.pingMs, precheckError: first.error };
  });

  const shortlist = quickChecked
    .filter(p => p.tcpFirstOk)
    .sort((a, b) => (a.tcpFirstPingMs ?? 999999) - (b.tcpFirstPingMs ?? 999999))
    .slice(0, MAX_REAL_CANDIDATES);

  console.log(`⚡ TCP shortlist: ${shortlist.length}/${quickChecked.length}`);

  const client = loadTdlib();
  await client.connect();
  console.log('✅ TDLib connected; starting real Telegram pingProxy checks');

  const checked = [];
  try {
    for (const proxy of shortlist) {
      const tcp = await tcpStabilityCheck(proxy, TCP_CHECKS);
      if (!tcp.ok) {
        checked.push({ ...proxy, online: false, checkPassed: false, strictPassed: tcp.samples.length, error: tcp.error, tcpSamplesMs: tcp.samples, realSamplesMs: [] });
        console.log(`⛔ ${proxy.shortId} TCP ${tcp.samples.length}/${TCP_CHECKS}: ${tcp.error}`);
        continue;
      }

      const real = await realTelegramStrictCheck(client, proxy, REAL_CHECKS);
      const strictPassed = tcp.samples.length + real.samples.length;
      const allSamples = [...tcp.samples, ...real.samples];
      const ok = real.ok && strictPassed === STRICT_REQUIRED;
      checked.push({
        ...proxy,
        online: ok,
        checkPassed: ok,
        strictPassed,
        strictRequired: STRICT_REQUIRED,
        realChecksPassed: real.samples.length,
        realChecksRequired: REAL_CHECKS,
        tcpChecksPassed: tcp.samples.length,
        tcpChecksRequired: TCP_CHECKS,
        pingMs: ok ? median(real.samples) : null,
        pingAvgMs: ok ? Math.round(real.samples.reduce((s, v) => s + v, 0) / real.samples.length) : null,
        pingBestMs: ok ? Math.min(...real.samples) : null,
        pingWorstMs: ok ? Math.max(...real.samples) : null,
        tcpMedianMs: median(tcp.samples),
        realSamplesMs: real.samples,
        tcpSamplesMs: tcp.samples,
        error: ok ? null : real.error
      });
      console.log(`${ok ? '✅' : '⛔'} ${proxy.shortId} real ${real.samples.length}/${REAL_CHECKS}, tcp ${tcp.samples.length}/${TCP_CHECKS}${ok ? `, ping=${median(real.samples)}ms` : `, ${real.error}`}`);
    }
  } finally {
    try { await client.close(); } catch (_) {}
  }

  const working = mergeMetadata(
    checked
      .filter(p => p.online && p.checkPassed && p.strictPassed === STRICT_REQUIRED)
      .sort((a, b) => (a.pingMs ?? 999999) - (b.pingMs ?? 999999))
      .slice(0, MAX_PROXIES)
      .map((p, index) => ({ ...p, rank: index + 1, fast: index < 2 || (p.pingMs ?? 999999) <= 350 })),
    previous,
    nowIso
  );

  const result = {
    success: working.length > 0,
    count: working.length,
    timestamp: nowIso,
    next_update: nextScheduledUpdate(started).toISOString(),
    schedule: { timezone: SCHEDULE_TZ, points: SCHEDULE_POINTS.map(p => p.label) },
    check: {
      type: 'tdlib_pingProxy_plus_tcp_stability',
      note: 'На сайт попадают только прокси, которые прошли реальные TDLib pingProxy-проверки и TCP-стабильность. Открытый порт больше не считается рабочим прокси.',
      real_checks_required: REAL_CHECKS,
      tcp_checks_required: TCP_CHECKS,
      strict_required: STRICT_REQUIRED,
      candidates: candidates.length,
      tcp_shortlist: shortlist.length,
      passed: working.length,
      failed: checked.filter(p => !p.checkPassed).length,
      timeout_ms: { tcp: TCP_TIMEOUT_MS, tdlib: REAL_TIMEOUT_MS }
    },
    providers: providerReports,
    proxies: working.map(({ secretHex, ...safe }) => safe),
    error: working.length ? null : `Не найдено прокси, прошедших ${REAL_CHECKS} реальных TDLib-проверок и ${TCP_CHECKS} TCP-проверок.`
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`💾 Saved real working proxies: ${working.length}; next=${result.next_update}`);
}

main().catch(error => {
  console.error('💥 Fatal:', error);
  const now = new Date();
  const result = {
    success: false,
    count: 0,
    timestamp: now.toISOString(),
    next_update: nextScheduledUpdate(now).toISOString(),
    schedule: { timezone: SCHEDULE_TZ, points: SCHEDULE_POINTS.map(p => p.label) },
    check: { type: 'tdlib_pingProxy_plus_tcp_stability', real_checks_required: REAL_CHECKS, tcp_checks_required: TCP_CHECKS, strict_required: STRICT_REQUIRED },
    providers: [],
    proxies: [],
    error: String(error.message || error)
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
