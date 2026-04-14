const https = require('https');
const fs = require('fs');
const path = require('path');

const CHANNELS = [
  'https://t.me/s/ProxyFree_Ru',
  'https://t.me/s/MTProto_Proxy_Russia',
  'https://t.me/s/proxy_fast',
  'https://t.me/s/ProxyMTProto',
  'https://t.me/s/FreeMTProto'
];

const FALLBACK = [
  {type:"MTProto",server:"185.173.36.38",port:"443",secret:"eeRighJJvXrFGRMCIMJdCQ",flag:"🇳🇱"},
  {type:"MTProto",server:"91.107.255.159",port:"8443",secret:"eeNEgYdJvXrFGRMCIMJdCQ",flag:"🇩🇪"},
  {type:"MTProto",server:"65.109.153.70",port:"8443",secret:"1320PuNyHw_LQKT_Y7XNJw",flag:"🇫🇮"},
  {type:"MTProto",server:"51.15.246.20",port:"8443",secret:"eeNEgYdJvXrFGRMCIMJdCQ",flag:"🇫🇷"},
  {type:"MTProto",server:"149.154.167.91",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"},
  {type:"MTProto",server:"149.154.167.103",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"},
  {type:"MTProto",server:"149.154.167.92",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"},
  {type:"MTProto",server:"149.154.167.100",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"},
  {type:"MTProto",server:"149.154.171.100",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"},
  {type:"MTProto",server:"149.154.175.100",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"},
  {type:"MTProto",server:"149.154.175.102",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"},
  {type:"MTProto",server:"149.154.167.200",port:"8443",secret:"dd070b1b71f82167e279061e9b53f4f1",flag:"🇬🇧"}
];

const FLAG_MAP = {
  '185.': '🇳🇱', '91.107.': '🇩🇪', '65.109.': '🇫🇮', '51.15.': '🇫🇷',
  '149.154.': '🇬🇧', '.ru': '🇷🇺', '.de': '🇩🇪', '.nl': '🇳🇱',
  '.fr': '🇫🇷', '.fi': '🇫🇮', '.uk': '🇬🇧', '.us': '🇺🇸', '.sg': '🇸🇬',
  '.ir': '🇮🇷', '.ae': '🇦🇪', '.tr': '🇹🇷', '.pl': '🇵🇱', '.by': '🇧🇾'
};

// 🔑 Создаём уникальный ключ для прокси (для сравнения)
const makeKey = (server, port, secret) => `${server}:${port}:${secret}`;
const makeShortKey = (server, port) => `${server}:${port}`;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseProxies(html) {
  const proxies = [];
  const decoded = html
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
  
  // 🔍 Стратегия 1: tg:// ссылки
  const tgPattern = /tg:\/\/proxy\?server=([^&\s"']*)&port=(\d+)&secret=([A-Za-z0-9_+\-=/]+)/gi;
  let match;
  while ((match = tgPattern.exec(decoded)) !== null) {
    const server = match[1].trim(), port = match[2].trim(), secret = match[3].trim();
    if (server && port && secret.length >= 16 && server.toLowerCase() !== 'unknown') {
      proxies.push({ type:'MTProto', server, port, secret, flag: getFlag(server) });
    }
  }
  
  // 🔍 Стратегия 2: href атрибуты
  const hrefPattern = /href=["']([^"']*tg:\/\/proxy[^"']*)["']/gi;
  while ((match = hrefPattern.exec(decoded)) !== null) {
    try {
      const link = match[1].replace(/&amp;/g, '&');
      const params = new URLSearchParams(link.replace('tg://proxy?', ''));
      const server = params.get('server')?.trim();
      const port = params.get('port')?.trim();
      const secret = params.get('secret')?.trim();
      if (server && port && secret?.length >= 16) {
        proxies.push({ type:'MTProto', server, port, secret, flag: getFlag(server) });
      }
    } catch(e) {}
  }
  return proxies;
}

function getFlag(ip) {
  for (const [prefix, flag] of Object.entries(FLAG_MAP)) {
    if (ip.includes(prefix) && flag !== '🇺🇦') return flag;
  }
  return '🌐';
}

// 📦 Загружаем предыдущие прокси для сравнения
function loadPreviousProxies() {
  try {
    const filePath = path.join(__dirname, 'proxies.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.proxies) {
        const map = new Map();
        for (const p of data.proxies) {
          if (p.server && p.port && p.secret) {
            map.set(makeKey(p.server, p.port, p.secret), p.fetchedAt);
          }
        }
        return map;
      }
    }
  } catch(e) { console.warn('⚠️ Could not load previous proxies:', e.message); }
  return new Map();
}

async function main() {
  const now = new Date();
  const previous = loadPreviousProxies();
  console.log('🔍 Fetching proxies... Previous known:', previous.size);
  
  let proxies = [], seen = new Set(), newCount = 0;
  
  for (const channel of CHANNELS) {
    if (proxies.length >= 20) break;
    try {
      console.log('📡', channel);
      const html = await fetchUrl(channel);
      const found = parseProxies(html);
      
      for (const p of found) {
        const key = makeKey(p.server, p.port, p.secret);
        const shortKey = makeShortKey(p.server, p.port);
        
        if (!seen.has(shortKey) && p.secret.length >= 16) {
          seen.add(shortKey);
          
          // 🔥 Если прокси новый ИЛИ секрет изменился — считаем его свежим
          const wasKnown = previous.has(key);
          const fetchedAt = wasKnown ? previous.get(key) : now.toISOString();
          
          if (!wasKnown) {
            newCount++;
            console.log('✨ NEW:', shortKey);
          }
          
          proxies.push({
            type: 'MTProto', server: p.server, port: p.port, secret: p.secret,
            flag: p.flag, fetchedAt, raw: `tg://proxy?server=${p.server}&port=${p.port}&secret=${p.secret}`
          });
        }
      }
    } catch (e) { console.error('❌', channel, e.message); }
  }
  
  // 🛡️ Фоллбэк
  if (proxies.length < 3) {
    console.log('⚠️ Using fallback');
    for (const fb of FALLBACK) {
      const shortKey = makeShortKey(fb.server, fb.port);
      if (!seen.has(shortKey)) {
        seen.add(shortKey);
        proxies.push({ ...fb, fetchedAt: previous.get(makeKey(fb.server, fb.port, fb.secret)) || now.toISOString(), raw: `tg://proxy?server=${fb.server}&port=${fb.port}&secret=${fb.secret}` });
      }
    }
  }
  
  // 🔥 Сортировка: новые первыми
  proxies.sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));
  
  const result = {
    success: true,
    count: proxies.length,
    timestamp: now.toISOString(),
    new_count: newCount,
    next_update: new Date(now.getTime() + 10*60*1000).toISOString(),
    proxies: proxies.slice(0, 12),
    source: newCount > 0 ? 'telegram' : 'fallback'
  };
  
  fs.writeFileSync(path.join(__dirname, 'proxies.json'), JSON.stringify(result, null, 2));
  console.log(`💾 Saved ${proxies.length} proxies (${newCount} new)`);
}

main().catch(console.error);
