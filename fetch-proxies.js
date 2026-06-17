'use strict';

/**
 * Telegram MTProto proxy updater for GitHub Actions.
 *
 * The dashboard should show only proxies that passed a fresh TCP check.
 * Public providers are noisy, so the script ranks verified proxies by
 * latency, freshness, port quality, repeated appearances, and previous uptime.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');

const DEFAULT_SOURCES = [
  'https://t.me/s/ProxyMTProto',
  'https://t.me/s/MTProtoProxies',
  'https://t.me/s/ProxyFree_Ru',
  'https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt',
  'https://raw.githubusercontent.com/Grim1313/mtproto-for-telegram/master/all_proxies.txt'
];

const CONFIG = {
  outputFile: process.env.OUTPUT_FILE || 'proxies.json',
  timezone: process.env.TIMEZONE || 'Europe/Paris',
  maxProxies: toInt(process.env.MAX_PROXIES, 18),
  perSourceLimit: toInt(process.env.PER_SOURCE_LIMIT, 120),
  timeoutMs: toInt(process.env.CHECK_TIMEOUT_MS, 4500),
  checkConcurrency: toInt(process.env.CHECK_CONCURRENCY, 20),
  candidateMultiplier: toInt(process.env.CANDIDATE_MULTIPLIER, 8),
  sourceUrls: parseSourceUrls(process.env.SOURCE_URLS),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || ''
};

function parseSourceUrls(value) {
  if (!value || !value.trim()) return DEFAULT_SOURCES;
  return value
    .split(/[\n,]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function nextUpdateIso() {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setUTCMinutes(17, 0, 0);

  while (candidate <= now || candidate.getUTCHours() % 4 !== 0) {
    candidate.setUTCHours(candidate.getUTCHours() + 1);
    candidate.setUTCMinutes(17, 0, 0);
  }

  return candidate.toISOString();
}

function readPrevious(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`Cannot read previous ${filePath}: ${error.message}`);
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function fetchUrl(url) {
  const client = url.startsWith('http://') ? http : https;

  return new Promise((resolve, reject) => {
    const req = client.get(url, {
      timeout: CONFIG.timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 GitHubActionsProxyUpdater/3.0 (+https://github.com/)',
        'Accept': 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8',
        'Cache-Control': 'no-cache'
      }
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchUrl(new URL(res.headers.location, url).toString()).then(resolve, reject);
        return;
      }

      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode || 'unknown'}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 5_000_000) req.destroy(new Error('Response is too large'));
      });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
  });
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(text) {
  return decodeHtml(String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '));
}

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^\[|\]$/g, '')
    .replace(/[\s`'"<>]+/g, '')
    .replace(/\/+$/g, '')
    .replace(/\.+$/g, '')
    .toLowerCase();
}

function normalizeSecret(secret) {
  return String(secret || '')
    .trim()
    .replace(/[\s`'"<>]+/g, '')
    .replace(/&amp;/g, '&');
}

function isValidHost(host) {
  if (!host || host.toLowerCase() === 'unknown') return false;
  if (host.length > 253) return false;
  if (/[/:?#@]/.test(host)) return false;
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const domain = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  return ipv4.test(host) || domain.test(host);
}

function isValidPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function isValidSecret(secret) {
  if (!secret || secret.length < 16 || secret.length > 256) return false;
  return /^[A-Za-z0-9_+\-=/]+$/.test(secret);
}

function proxyHash(server, port, secret) {
  return crypto.createHash('sha256').update(`${server}:${port}:${secret}`).digest('hex').slice(0, 16);
}

function enrichProxy(proxy, overrides = {}) {
  const server = normalizeHost(proxy.server);
  const port = String(proxy.port || '').trim().replace(/\D/g, '');
  const secret = normalizeSecret(proxy.secret);
  const params = new URLSearchParams({ server, port, secret });
  const hash = proxy.hash || proxyHash(server, port, secret);
  return {
    ...proxy,
    ...overrides,
    server,
    port,
    secret,
    flag: proxy.flag || guessFlag(server),
    raw: `tg://proxy?${params.toString()}`,
    webUrl: `https://t.me/proxy?${params.toString()}`,
    hash
  };
}

function makeProxy(server, port, secret, source, fetchedAt) {
  server = normalizeHost(server);
  port = String(port || '').trim().replace(/\D/g, '');
  secret = normalizeSecret(secret);

  if (!isValidHost(server) || !isValidPort(port) || !isValidSecret(secret)) return null;

  return enrichProxy({
    type: 'MTProto',
    server,
    port,
    secret,
    flag: guessFlag(server),
    source,
    sources: [source],
    fetchedAt: fetchedAt || nowIso()
  });
}

function guessFlag(server) {
  const s = server.toLowerCase();
  const map = [
    ['.ru', 'RU'], ['.de', 'DE'], ['.nl', 'NL'], ['.fr', 'FR'], ['.fi', 'FI'],
    ['.uk', 'GB'], ['.co.uk', 'GB'], ['.us', 'US'], ['.sg', 'SG'], ['.ir', 'IR'],
    ['.ae', 'AE'], ['.tr', 'TR'], ['.pl', 'PL'], ['.it', 'IT']
  ];
  for (const [needle, flag] of map) if (s.endsWith(needle)) return flag;
  if (s.startsWith('185.')) return 'NL';
  if (s.startsWith('91.107.')) return 'DE';
  if (s.startsWith('65.109.')) return 'FI';
  if (s.startsWith('51.15.')) return 'FR';
  return 'GL';
}

function sourceName(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 't.me') return `t.me/${u.pathname.split('/').filter(Boolean).slice(-1)[0] || 'channel'}`;
    if (u.hostname.includes('githubusercontent.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      return `${parts[0]}/${parts[1]}`;
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function parseTextForProxies(text, source, sourceUrl) {
  const decoded = decodeHtml(text);
  const cleaned = stripTags(decoded);
  const proxies = [];
  const fetchedAt = nowIso();

  const linkRegex = /(?:tg:\/\/proxy|https?:\/\/t\.me\/proxy)\?[^\s"'<>]+/gi;
  for (const match of decoded.matchAll(linkRegex)) {
    const link = decodeHtml(match[0]).replace(/\)$/, '');
    try {
      const query = link.includes('?') ? link.slice(link.indexOf('?') + 1) : '';
      const params = new URLSearchParams(query);
      const proxy = makeProxy(params.get('server'), params.get('port'), params.get('secret'), source, fetchedAt);
      if (proxy) proxies.push(proxy);
    } catch (_) {}
  }

  const lines = cleaned.split(/\n+/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const proxy = parseLine(line, source, fetchedAt);
    if (proxy) proxies.push(proxy);
  }

  const blocks = decoded.split(/tgme_widget_message[^>]*>/i);
  for (const block of blocks) {
    const timeMatch = block.match(/<time[^>]+datetime=["']([^"']+)["']/i);
    const blockTime = timeMatch ? new Date(timeMatch[1]).toISOString() : fetchedAt;
    const proxy = parseBlock(stripTags(block), source, blockTime);
    if (proxy) proxies.push(proxy);
  }

  const genericBlocks = cleaned.split(/(?:\r?\n){2,}|-{3,}/g);
  for (const block of genericBlocks) {
    const proxy = parseBlock(block, source, fetchedAt);
    if (proxy) proxies.push(proxy);
  }

  const unique = dedupe(proxies).slice(0, CONFIG.perSourceLimit);
  console.log(`   ${unique.length} parsed from ${sourceUrl}`);
  return unique;
}

function parseLine(line, source, fetchedAt) {
  const compact = line.trim();
  let m = compact.match(/^([a-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})[:\s]+(\d{1,5})[:\s]+([A-Za-z0-9_+\-=/]{16,256})$/i);
  if (m) return makeProxy(m[1], m[2], m[3], source, fetchedAt);

  m = compact.match(/["']server["']\s*:\s*["']([^"']+)["'][\s\S]*?["']port["']\s*:\s*["']?(\d{1,5})["']?[\s\S]*?["']secret["']\s*:\s*["']([^"']+)["']/i);
  if (m) return makeProxy(m[1], m[2], m[3], source, fetchedAt);

  return null;
}

function parseBlock(block, source, fetchedAt) {
  const text = block.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const server = firstMatch(text, [
    /(?:server|host|ip|сервер|хост|адрес)\s*[:：]\s*([a-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})/i,
    /(?:Server|IP)\s+([a-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})/i
  ]);
  const port = firstMatch(text, [
    /(?:port|порт)\s*[:：]\s*(\d{1,5})/i,
    /Port\s+(\d{1,5})/i
  ]);
  const secret = firstMatch(text, [
    /(?:secret|ключ)\s*[:：]\s*([A-Za-z0-9_+\-=/]{16,256})/i,
    /Secret\s+([A-Za-z0-9_+\-=/]{16,256})/i
  ]);

  return makeProxy(server, port, secret, source, fetchedAt);
}

function firstMatch(text, regexes) {
  for (const regex of regexes) {
    const m = text.match(regex);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function dedupe(items) {
  const seen = new Map();
  for (const item of items) {
    const key = `${item.server}:${item.port}:${item.secret}`;
    if (!seen.has(key)) {
      seen.set(key, { ...item, sources: item.sources || [item.source] });
      continue;
    }

    const existing = seen.get(key);
    const sources = new Set([...(existing.sources || []), item.source]);
    seen.set(key, {
      ...existing,
      sources: [...sources],
      source: [...sources].join(', '),
      fetchedAt: newestIso(existing.fetchedAt, item.fetchedAt)
    });
  }
  return [...seen.values()];
}

function newestIso(a, b) {
  const at = new Date(a).getTime() || 0;
  const bt = new Date(b).getTime() || 0;
  return bt > at ? b : a;
}

async function checkTcp(proxy) {
  const started = Date.now();

  return new Promise(resolve => {
    let done = false;
    const socket = net.createConnection({ host: proxy.server, port: Number(proxy.port), timeout: CONFIG.timeoutMs });

    const finish = (status, error = '') => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(enrichProxy(proxy, {
        status,
        latencyMs: status === 'online' ? Date.now() - started : null,
        checkedAt: nowIso(),
        check: 'tcp-connect',
        error
      }));
    };

    socket.once('connect', () => finish('online'));
    socket.once('timeout', () => finish('offline', 'timeout'));
    socket.once('error', error => finish('offline', error.code || error.message));
  });
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let index = 0;

  async function next() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await worker(current));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

function previousByHash(previous) {
  const map = new Map();
  for (const p of previous?.proxies || []) {
    const item = enrichProxy(p);
    map.set(item.hash, item);
  }
  return map;
}

function withQuality(proxy, previousMap) {
  const previous = previousMap.get(proxy.hash);
  const successCount = (previous?.successCount || 0) + 1;
  const onlineStreak = previous?.status === 'online' ? (previous.onlineStreak || 0) + 1 : 1;
  const firstSeenAt = previous?.firstSeenAt || proxy.fetchedAt || nowIso();
  const sourceCount = new Set(proxy.sources || [proxy.source]).size;
  const latency = proxy.latencyMs ?? CONFIG.timeoutMs;
  const portBonus = Number(proxy.port) === 443 ? 25 : Number(proxy.port) === 8443 ? 12 : 0;
  const sourceBonus = Math.min(sourceCount, 4) * 18;
  const streakBonus = Math.min(onlineStreak, 8) * 10;
  const latencyScore = Math.max(0, 260 - Math.round(latency / 4));
  const score = latencyScore + portBonus + sourceBonus + streakBonus;

  return enrichProxy(proxy, {
    status: 'online',
    successCount,
    onlineStreak,
    firstSeenAt,
    lastOnlineAt: proxy.checkedAt,
    sourceCount,
    score
  });
}

function sortProxies(a, b) {
  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
  return (a.latencyMs ?? 999999) - (b.latencyMs ?? 999999);
}

function previousHashes(previous) {
  return new Set((previous?.proxies || []).map(p => enrichProxy(p).hash));
}

async function notifyNewProxies(newItems, payload) {
  if (!newItems.length) return;

  const lines = newItems.slice(0, 5).map((p, i) => {
    const latency = p.latencyMs ? `${p.latencyMs} ms` : 'n/a';
    return `${i + 1}. ${p.server}:${p.port} | ${latency} | score ${p.score || 0}`;
  });
  const text = [
    `New verified MTProto proxies: ${newItems.length}`,
    `Online on dashboard: ${payload.count}`,
    `Updated: ${payload.timestamp}`,
    `Next check: ${payload.next_update}`,
    '',
    ...lines,
    newItems.length > 5 ? `and ${newItems.length - 5} more` : '',
    '',
    'Dashboard shows only proxies that passed TCP connect check.'
  ].filter(Boolean).join('\n');

  const tasks = [];
  if (CONFIG.telegramBotToken && CONFIG.telegramChatId) tasks.push(sendTelegram(text));
  if (CONFIG.discordWebhookUrl) tasks.push(sendDiscord(text));

  if (!tasks.length) {
    console.log('New verified proxies found, but notification secrets are not configured.');
    return;
  }

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'rejected') console.warn(`Notify failed: ${result.reason.message}`);
  }
}

function requestJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;
    const req = client.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: CONFIG.timeoutMs
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Notify timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  return requestJson(url, {
    chat_id: CONFIG.telegramChatId,
    text,
    disable_web_page_preview: true
  });
}

function sendDiscord(text) {
  return requestJson(CONFIG.discordWebhookUrl, { content: text });
}

async function main() {
  const previous = readPrevious(CONFIG.outputFile);
  const previousMap = previousByHash(previous);
  const prevHashes = previousHashes(previous);

  console.log(`Start MTProto proxy update: ${nowIso()}`);
  console.log(`Sources: ${CONFIG.sourceUrls.length}`);

  const parsed = [];
  const sourceStats = [];

  for (const url of CONFIG.sourceUrls) {
    const name = sourceName(url);
    try {
      console.log(`Fetch ${name}`);
      const body = await fetchUrl(url);
      const items = parseTextForProxies(body, name, url);
      parsed.push(...items);
      sourceStats.push({ source: name, ok: true, parsed: items.length });
    } catch (error) {
      console.warn(`${name}: ${error.message}`);
      sourceStats.push({ source: name, ok: false, parsed: 0, error: error.message });
    }
  }

  const unique = dedupe(parsed).sort((a, b) => {
    const sourceDelta = (b.sources?.length || 1) - (a.sources?.length || 1);
    if (sourceDelta) return sourceDelta;
    return (new Date(b.fetchedAt).getTime() || 0) - (new Date(a.fetchedAt).getTime() || 0);
  });
  console.log(`Unique parsed: ${unique.length}`);

  const candidateLimit = Math.max(CONFIG.maxProxies * CONFIG.candidateMultiplier, CONFIG.maxProxies);
  const checked = await runPool(unique.slice(0, candidateLimit), checkTcp, CONFIG.checkConcurrency);
  const online = checked.filter(p => p.status === 'online').map(p => withQuality(p, previousMap)).sort(sortProxies);
  console.log(`Online by TCP: ${online.length}`);

  const finalProxies = online.slice(0, CONFIG.maxProxies);
  const newItems = finalProxies.filter(p => p.hash && !prevHashes.has(p.hash));
  const success = finalProxies.length > 0;

  const payload = {
    success,
    count: finalProxies.length,
    newCount: newItems.length,
    timestamp: nowIso(),
    next_update: nextUpdateIso(),
    timezone: CONFIG.timezone,
    schedule: 'Every 4 hours via GitHub Actions cron: 17 */4 * * *',
    sourceStats,
    note: success
      ? 'Dashboard contains only proxies that passed a fresh TCP connect check. Best entries are ranked by latency, source confidence, and previous uptime.'
      : 'No TCP-online proxies were found in the current provider scan.',
    proxies: finalProxies
  };

  writeJson(CONFIG.outputFile, payload);
  console.log(`Saved ${finalProxies.length} verified proxies to ${CONFIG.outputFile}`);

  await notifyNewProxies(newItems, payload);
  console.log('Done');
}

main().catch(error => {
  console.error(`Fatal error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
