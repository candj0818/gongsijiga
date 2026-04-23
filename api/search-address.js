/* =========================================
   주소 후보 검색 API
   - VWorld Search 2.0 API 호출
   - 시/도 없이 입력된 주소의 후보 리스트 반환
   ========================================= */

// undici 설정 (lookup.js와 동일한 커넥션 설정)
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 10,
    keepAliveMaxTimeout: 10,
    pipelining: 0,
    connect: { timeout: 10000 }
  }));
} catch (e) {
  console.log('[INIT] undici not available:', e.message);
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body));
}

async function safeFetchJson(url, label, maxRetries = 2) {
  const RETRYABLE = [
    'fetch failed', 'socket hang up', 'ECONNRESET', 'ETIMEDOUT',
    'aborted', 'TRANSIENT_HTTP_', 'SocketError', 'ConnectTimeoutError'
  ];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'gongsijiga/1.0 (+https://gongsijiga.vercel.app)' },
        signal: AbortSignal.timeout(12000)
      });
      if (r.status >= 500 && r.status < 600) {
        throw new Error(`TRANSIENT_HTTP_${r.status}`);
      }
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Invalid JSON from ${label}: ${text.slice(0, 120)}`);
      }
    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);
      const retryable = RETRYABLE.some((k) => msg.includes(k));
      if (!retryable || attempt === maxRetries) throw err;
      const wait = 500 * Math.pow(2, attempt);
      console.log(`[${label}] retry ${attempt + 1} after ${wait}ms: ${msg}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = async (req, res) => {
  // CORS (same-origin이지만 혹시 모르니)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const query = (body.query || '').toString().trim();
  const isRoad = !!body.isRoad;

  if (!query) {
    json(res, 400, { success: false, error: 'query가 비어있습니다' });
    return;
  }

  const vworldKey = process.env.VWORLD_KEY;
  if (!vworldKey) {
    json(res, 500, { success: false, error: 'VWORLD_KEY 환경변수가 설정되지 않았습니다' });
    return;
  }

  try {
    const category = isRoad ? 'ROAD' : 'PARCEL';
    const params = new URLSearchParams({
      service: 'search',
      request: 'search',
      version: '2.0',
      crs: 'EPSG:4326',
      size: '20',
      page: '1',
      query,
      type: 'ADDRESS',
      category,
      format: 'json',
      errorformat: 'json',
      key: vworldKey
    });
    const url = `https://api.vworld.kr/req/search?${params}`;
    console.log(`[SEARCH] ${category} query="${query}"`);

    const data = await safeFetchJson(url, 'VWorld Search');

    const status = data?.response?.status;
    if (status === 'NOT_FOUND') {
      json(res, 200, { success: true, candidates: [] });
      return;
    }
    if (status !== 'OK') {
      const errMsg = data?.response?.error?.text || `VWorld status: ${status}`;
      throw new Error(errMsg);
    }

    const items = data?.response?.result?.items || [];
    const seen = new Set();
    const candidates = [];
    for (const it of items) {
      const title = (it.title || it.address?.parcel || it.address?.road || '').trim();
      if (!title) continue;
      if (seen.has(title)) continue;
      seen.add(title);
      candidates.push({
        title,
        zipcode: it.address?.zipcode || '',
        category: it.address?.category || category.toLowerCase(),
        bldName: it.address?.bldnm || ''
      });
      if (candidates.length >= 20) break;
    }

    console.log(`[SEARCH] ${candidates.length} candidates`);
    json(res, 200, { success: true, candidates });
  } catch (err) {
    console.error('[SEARCH] error:', err);
    json(res, 500, { success: false, error: err.message || '검색 실패' });
  }
};
