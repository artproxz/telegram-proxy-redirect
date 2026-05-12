'use strict';

/**
 * Telegram MTProto proxy updater for GitHub Actions.
 *
 * What it does:
 * 1. Reads public MTProto proxy lists/channels.
 * 2. Parses tg://proxy links and "Server / Port / Secret" blocks.
 * 3. Deduplicates and checks TCP reachability only for listed public servers.
 * 4. Writes proxies.json for GitHub Pages.
 * 5. Optionally notifies you about newly added proxies via Telegram Bot or Discord webhook.
 *
 * No port scanning, no brute force, no authentication bypass.
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
  maxProxies: toInt(process.env.MAX_PROXIES, 24),
  perSourceLimit: toInt(process.env.PER_SOURCE_LIMIT, 80),
  timeoutMs: toInt(process.env.CHECK_TIMEOUT_MS, 4500),
  checkConcurrency: toInt(process.env.CHECK_CONCURRENCY, 16),
  keepUnverifiedIfFew: process.env.KEEP_UNVERIFIED_IF_FEW !== 'false',
  minVerified: toInt(process.env.MIN_VERIFIED, 3),
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
  const allowedHours = [9, 13, 17, 21];

  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    for (const hour of allowedHours) {
      const candidate = zonedDateCandidate(CONFIG.timezone, dayOffset, hour, 17, 0);
      if (candidate && candidate.getTime() > now.getTime() + 60_000) {
        return candidate.toISOString();
      }
    }
  }
  return new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();
}

function zonedDateCandidate(timeZone, dayOffset, hour, minute, second) {
  // Build an approximate UTC date, then adjust with Intl offset.
  const base = new Date();
  const utc = new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dayOffset,
    hour, minute, second
  ));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(utc).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});

  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = asIfUtc - utc.getTime();
  return new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dayOffset,
    hour, minute, second
  ) - offsetMs);
}

function readPrevious(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`⚠️ Cannot read previous ${filePath}: ${error.message}`);
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
        'User-Agent': 'Mozilla/5.0 GitHubActionsProxyUpdater/2.0 (+https://github.com/)',
        'Accept': 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8'
      }
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const redirected = new URL(res.headers.location, url).toString();
        fetchUrl(redirected).then(resolve, reject);
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
        if (data.length > 4_000_000) {
          req.destroy(new Error('Response is too large'));
        }
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


function enrichProxy(proxy, overrides = {}) {
  const server = normalizeHost(proxy.server);
  const port = String(proxy.port || '').trim().replace(/\D/g, '');
  const secret = normalizeSecret(proxy.secret);
  const params = new URLSearchParams({ server, port, secret });
  const hash = proxy.hash || crypto.createHash('sha256').update(`${server}:${port}:${secret}`).digest('hex').slice(0, 16);
  return {
    ...proxy,
    ...overrides,
    server,
    port,
    secret,
    flag: proxy.flag || guessFlag(server),
    raw: proxy.raw || `tg://proxy?${params.toString()}`,
    webUrl: proxy.webUrl || `https://t.me/proxy?${params.toString()}`,
    hash
  };
}

function makeProxy(server, port, secret, source, fetchedAt) {
  server = normalizeHost(server);
  port = String(port || '').trim().replace(/\D/g, '');
  secret = normalizeSecret(secret);

  if (!isValidHost(server) || !isValidPort(port) || !isValidSecret(secret)) return null;

  const params = new URLSearchParams({ server, port, secret });
  const raw = `tg://proxy?${params.toString()}`;
  const webUrl = `https://t.me/proxy?${params.toString()}`;
  const hash = crypto.createHash('sha256').update(`${server}:${port}:${secret}`).digest('hex').slice(0, 16);

  return {
    type: 'MTProto',
    server,
    port,
    secret,
    flag: guessFlag(server),
    source,
    fetchedAt: fetchedAt || nowIso(),
    raw,
    webUrl,
    hash
  };
}

function guessFlag(server) {
  const s = server.toLowerCase();
  const map = [
    ['.ru', '🇷🇺'], ['.de', '🇩🇪'], ['.nl', '🇳🇱'], ['.fr', '🇫🇷'], ['.fi', '🇫🇮'],
    ['.uk', '🇬🇧'], ['.co.uk', '🇬🇧'], ['.us', '🇺🇸'], ['.sg', '🇸🇬'], ['.ir', '🇮🇷'],
    ['.ae', '🇦🇪'], ['.tr', '🇹🇷'], ['.pl', '🇵🇱'], ['.it', '🇮🇹'], ['.space', '🌐']
  ];
  for (const [needle, flag] of map) if (s.endsWith(needle)) return flag;
  if (s.startsWith('185.')) return '🇳🇱';
  if (s.startsWith('91.107.')) return '🇩🇪';
  if (s.startsWith('65.109.')) return '🇫🇮';
  if (s.startsWith('51.15.')) return '🇫🇷';
  if (s.startsWith('149.154.')) return '🌐';
  return '🌐';
}

function sourceName(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 't.me') {
      return `t.me/${u.pathname.split('/').filter(Boolean).slice(-1)[0] || 'channel'}`;
    }
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

  // Telegram public channel format usually keeps Server/Port/Secret in one message block.
  const blocks = decoded.split(/tgme_widget_message[^>]*>/i);
  for (const block of blocks) {
    const timeMatch = block.match(/<time[^>]+datetime=["']([^"']+)["']/i);
    const blockTime = timeMatch ? new Date(timeMatch[1]).toISOString() : fetchedAt;
    const blockText = stripTags(block);
    const proxy = parseBlock(blockText, source, blockTime);
    if (proxy) proxies.push(proxy);
  }

  // Generic multiline fallback for raw pages.
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

  // server:port:secret or host port secret formats.
  let m = compact.match(/^([a-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})[:\s]+(\d{1,5})[:\s]+([A-Za-z0-9_+\-=/]{16,256})$/i);
  if (m) return makeProxy(m[1], m[2], m[3], source, fetchedAt);

  // JSON-ish snippets.
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
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.server}:${item.port}:${item.secret}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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
      resolve({
        ...proxy,
        status,
        latencyMs: status === 'online' ? Date.now() - started : null,
        checkedAt: nowIso(),
        check: 'tcp-connect',
        error
      });
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

function sortProxies(a, b) {
  if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
  const at = new Date(a.fetchedAt).getTime() || 0;
  const bt = new Date(b.fetchedAt).getTime() || 0;
  if (at !== bt) return bt - at;
  return (a.latencyMs ?? 999999) - (b.latencyMs ?? 999999);
}

function previousHashes(previous) {
  return new Set((previous?.proxies || []).map(p => p.hash || crypto.createHash('sha256').update(`${p.server}:${p.port}:${p.secret}`).digest('hex').slice(0, 16)));
}

async function notifyNewProxies(newItems, payload) {
  if (!newItems.length) return;

  const lines = newItems.slice(0, 8).map((p, i) => `${i + 1}. ${p.server}:${p.port} — ${p.source}`);
  const text = [
    `🟢 Новые MTProto прокси: ${newItems.length}`,
    `Всего на сайте: ${payload.count}`,
    '',
    ...lines,
    newItems.length > 8 ? `…и ещё ${newItems.length - 8}` : '',
    '',
    `Обновлено: ${payload.timestamp}`
  ].filter(Boolean).join('\n');

  const tasks = [];
  if (CONFIG.telegramBotToken && CONFIG.telegramChatId) {
    tasks.push(sendTelegram(text));
  }
  if (CONFIG.discordWebhookUrl) {
    tasks.push(sendDiscord(text));
  }

  if (!tasks.length) {
    console.log('ℹ️ New proxies found, but notification secrets are not configured.');
    return;
  }

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'rejected') console.warn(`⚠️ Notify failed: ${result.reason.message}`);
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
  const prevHashes = previousHashes(previous);

  console.log(`🔎 Start MTProto proxy update: ${nowIso()}`);
  console.log(`🧭 Sources: ${CONFIG.sourceUrls.length}`);

  const parsed = [];
  const sourceStats = [];

  for (const url of CONFIG.sourceUrls) {
    const name = sourceName(url);
    try {
      console.log(`🌐 Fetch ${name}`);
      const body = await fetchUrl(url);
      const items = parseTextForProxies(body, name, url);
      parsed.push(...items);
      sourceStats.push({ source: name, ok: true, parsed: items.length });
    } catch (error) {
      console.warn(`⚠️ ${name}: ${error.message}`);
      sourceStats.push({ source: name, ok: false, parsed: 0, error: error.message });
    }
  }

  const unique = dedupe(parsed).sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));
  console.log(`📦 Unique parsed: ${unique.length}`);

  const toCheck = unique.slice(0, Math.max(CONFIG.maxProxies * 4, CONFIG.maxProxies));
  const checked = await runPool(toCheck, checkTcp, CONFIG.checkConcurrency);
  const online = checked.filter(p => p.status === 'online').sort(sortProxies);
  console.log(`✅ Online by TCP: ${online.length}`);

  let finalProxies = online.slice(0, CONFIG.maxProxies);
  let success = finalProxies.length > 0;
  let note = 'Only TCP reachability is checked; Telegram availability may vary by country/operator.';

  if (finalProxies.length < CONFIG.minVerified && CONFIG.keepUnverifiedIfFew) {
    const existingKeys = new Set(finalProxies.map(p => p.hash));
    const unverified = unique
      .filter(p => !existingKeys.has(p.hash))
      .slice(0, CONFIG.maxProxies - finalProxies.length)
      .map(p => ({ ...p, status: 'unverified', latencyMs: null, checkedAt: nowIso(), check: 'not-checked' }));
    finalProxies = [...finalProxies, ...unverified].slice(0, CONFIG.maxProxies);
    success = finalProxies.length > 0;
    note = unverified.length
      ? 'Few TCP-verified proxies were found, so fresh unverified public entries are shown below verified entries.'
      : 'Only a small number of TCP-verified proxies was found.';
  }

  if (!finalProxies.length && previous?.proxies?.length) {
    const previousOnline = previous.proxies.filter(p => p.status === 'online');
    const previousUsable = CONFIG.keepUnverifiedIfFew ? previous.proxies : previousOnline;

    if (previousUsable.length) {
      console.warn('⚠️ No fresh verified proxies found. Keeping previous usable cache.');
      finalProxies = previousUsable.map(p => enrichProxy(p, {
        status: p.status || 'cached',
        checkedAt: nowIso(),
        check: p.check || 'previous-cache'
      }));
      success = false;
      note = CONFIG.keepUnverifiedIfFew
        ? 'Sources did not return usable proxies; previous cache is kept.'
        : 'Sources did not return fresh TCP-online proxies; previous online cache is kept.';
    }
  }

  if (!finalProxies.length) {
    success = false;
    note = 'No usable proxies were found. Check source availability or add your own SOURCE_URLS.';
  }

  finalProxies = finalProxies.sort(sortProxies).slice(0, CONFIG.maxProxies);
  finalProxies = finalProxies.map(p => enrichProxy(p));
  const newItems = finalProxies.filter(p => p.hash && !prevHashes.has(p.hash));

  const payload = {
    success,
    count: finalProxies.length,
    newCount: newItems.length,
    timestamp: nowIso(),
    next_update: nextUpdateIso(),
    timezone: CONFIG.timezone,
    schedule: '09:17, 13:17, 17:17, 21:17 local time',
    sourceStats,
    note,
    proxies: finalProxies
  };

  writeJson(CONFIG.outputFile, payload);
  console.log(`💾 Saved ${finalProxies.length} proxies to ${CONFIG.outputFile}`);

  await notifyNewProxies(newItems, payload);
  console.log('🏁 Done');
}

main().catch(error => {
  console.error(`❌ Fatal error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
