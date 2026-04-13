const https = require('https');
const fs = require('fs');

const CHANNELS = [
  'https://t.me/s/ProxyFree_Ru',
  'https://t.me/s/MTProto_Proxy_Russia',
  'https://t.me/s/proxy_fast'
];

const FALLBACK = [
  {type:"MTProto",server:"185.173.36.38",port:"443",secret:"eeRighJJvXrFGRMCIMJdCQ",flag:"🇳🇱"},
  {type:"MTProto",server:"91.107.255.159",port:"8443",secret:"eeNEgYdJvXrFGRMCIMJdCQ",flag:"🇩"},
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
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
  const tgLinks = html.match(/tg:\/\/proxy\?server=[^&\s"]+&port=\d+&secret=[^\s"'>]+/gi) || [];
  
  for (const link of tgLinks) {
    const match = link.match(/server=([^&]+)&port=(\d+)&secret=([^&\s]+)/);
    if (match && match[3]?.length >= 16) {
      proxies.push({
        type: 'MTProto',
        server: decodeURIComponent(match[1]),
        port: match[2],
        secret: decodeURIComponent(match[3]),
        flag: getFlag(decodeURIComponent(match[1])),
        raw: link
      });
    }
  }
  return proxies;
}

function getFlag(ip) {
  if (ip.includes('185.')) return '🇳';
  if (ip.includes('91.107.')) return '🇩';
  if (ip.includes('65.109.')) return '🇫';
  if (ip.includes('51.15.')) return '🇫';
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
      const found = parseProxies(html);
      console.log('✅ Found:', found.length, 'proxies');
      
      for (const p of found) {
        const key = `${p.server}:${p.port}`;
        if (!seen.has(key) && p.secret.length >= 16) {
          seen.add(key);
          proxies.push(p);
        }
      }
    } catch (e) {
      console.error('❌ Error:', e.message);
    }
  }
  
  if (proxies.length < 3) {
    console.log('⚠️ Using fallback proxies');
    proxies = FALLBACK.map(p => ({
      ...p,
      raw: `tg://proxy?server=${p.server}&port=${p.port}&secret=${p.secret}`
    }));
  }
  
  const result = {
    success: true,
    count: proxies.length,
    timestamp: new Date().toISOString(),
    proxies: proxies.slice(0, 12),
    source: proxies.length >= 3 ? 'telegram' : 'fallback'
  };
  
  fs.writeFileSync('proxies.json', JSON.stringify(result, null, 2));
  console.log('💾 Saved', proxies.length, 'proxies to proxies.json');
}

main().catch(console.error);
