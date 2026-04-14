const https = require('https');
const fs = require('fs');

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
  
  // 🔥 Декодируем HTML-entities
  const decoded = html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  
  // 🔥 Стратегия 1: Ищем tg:// ссылки
  const tgPattern = /tg:\/\/proxy[?\s]*[^"'\s>]*server[=\s]+([^&\s"']+(?:\.[^&\s"']+)*)[^"'\s>]*port[=\s]+(\d{3,5})[^"'\s>]*secret[=\s]+([A-Za-z0-9_+\-=/]{16,})/gi;
  
  let match;
  while ((match = tgPattern.exec(decoded)) !== null) {
    try {
      const server = match[1].trim();
      const port = match[2].trim();
      const secret = match[3].trim();
      
      if (server && port && secret.length >= 16 && server.toLowerCase() !== 'unknown') {
        proxies.push({
          type: 'MTProto',
          server,
          port,
          secret,
          flag: getFlag(server),
          raw: `tg://proxy?server=${server}&port=${port}&secret=${secret}`
        });
        console.log('✅ Parsed:', server, port);
      }
    } catch(e) {
      console.warn('Parse error:', e.message);
    }
  }
  
  // 🔥 Стратегия 2: Прямой поиск по атрибутам href
  const hrefPattern = /href=["']([^"']*tg:\/\/proxy[^"']*)["']/gi;
  let hrefMatch;
  while ((hrefMatch = hrefPattern.exec(decoded)) !== null) {
    try {
      const link = hrefMatch[1].replace(/&amp;/g, '&');
      const params = new URLSearchParams(link.replace('tg://proxy?', ''));
      const server = params.get('server');
      const port = params.get('port');
      const secret = params.get('secret');
      
      if (server && port && secret?.length >= 16) {
        proxies.push({
          type: 'MTProto',
          server,
          port,
          secret,
          flag: getFlag(server),
          raw: link
        });
      }
    } catch(e) {}
  }
  
  console.log(`🔍 Total parsed: ${proxies.length}`);
  return proxies;
}

function getFlag(ip) {
  if (ip.includes('185.')) return '🇳🇱';
  if (ip.includes('91.107.')) return '🇩🇪';
  if (ip.includes('65.109.')) return '🇫🇮';
  if (ip.includes('51.15.')) return '🇫🇷';
  if (ip.includes('149.154.')) return '🇬🇧';
  return '🌐';
}

async function main() {
  let proxies = [];
  const seen = new Set();
  
  console.log('🔍 Fetching proxies from Telegram...');
  
  for (const channel of CHANNELS) {
    if (proxies.length >= 12) break;
    
    try {
      console.log('📡 Trying:', channel);
      const html = await fetchUrl(channel);
      console.log('📄 HTML length:', html.length);
      
      const found = parseProxies(html);
      console.log('✅ Found:', found.length, 'proxies');
      
      for (const p of found) {
        const key = `${p.server}:${p.port}`;
        if (!seen.has(key) && p.secret.length >= 16) {
          seen.add(key);
          proxies.push(p);
          console.log('➕ Added:', key);
        }
      }
    } catch (e) {
      console.error('❌ Error:', channel, e.message);
    }
  }
  
  console.log('📊 Total unique:', proxies.length);
  
  if (proxies.length < 3) {
    console.log('⚠️ Using fallback proxies');
    proxies = FALLBACK.map(p => ({
      ...p,
      raw: `tg://proxy?server=${p.server}&port=${p.port}&secret=${p.secret}`
    }));
  }
  
  // ✅ Добавляем next_update для синхронизации таймера
  const result = {
    success: true,
    count: proxies.length,
    timestamp: new Date().toISOString(),
    next_update: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    proxies: proxies.slice(0, 12),
    source: proxies.length >= 3 && !proxies.every(p => FALLBACK.some(fb => fb.server === p.server)) ? 'telegram' : 'fallback'
  };
  
  fs.writeFileSync('proxies.json', JSON.stringify(result, null, 2));
  console.log('💾 Saved', proxies.length, 'proxies to proxies.json');
}

main().catch(console.error);
