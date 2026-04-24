/* =========================================
   /api/search-building — 건물/단지명으로 주소 후보 검색

   흐름:
     1. 프론트에서 { query } 수신 ("쌍용 더플래티넘 용마산" 같은 명칭)
     2. juso.go.kr (행정안전부 도로명주소 검색) + VWorld POI 검색을 병렬 호출
     3. 주소 기준 중복 제거 (juso 결과 우선 → 품질이 더 좋음)
     4. 후보 리스트 반환 (상위 20개)

   환경변수:
     JUSO_API_KEY — business.juso.go.kr/addrlink (도로명주소 검색) 키
     VWORLD_KEY   — POI 검색 fallback용
   ========================================= */

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

async function safeFetchJson(url, label, maxRetries = 1) {
  const RETRYABLE = [
    'fetch failed', 'socket hang up', 'ECONNRESET', 'ETIMEDOUT',
    'aborted', 'TRANSIENT_HTTP_', 'SocketError', 'ConnectTimeoutError'
  ];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'gongsijiga/1.0 (+https://gongsijiga.vercel.app)',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (r.status >= 500 && r.status < 600) {
        throw new Error(`TRANSIENT_HTTP_${r.status}`);
      }
      const text = await r.text();
      const trimmed = text.trim();
      if (!trimmed) throw new Error(`${label} 응답이 비어있습니다`);
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        throw new Error(`${label} 응답 파싱 실패: ${trimmed.slice(0, 120)}`);
      }
    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);
      const retryable = RETRYABLE.some((k) => msg.includes(k));
      if (!retryable || attempt === maxRetries) throw err;
      const wait = 400 * Math.pow(2, attempt);
      console.log(`[${label}] retry ${attempt + 1} after ${wait}ms: ${msg.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ========== juso.go.kr 도로명주소 검색 ==========
// 응답 스펙: https://business.juso.go.kr/addrlink/openApi/searchApi.do
async function searchJuso(keyword) {
  const key = process.env.JUSO_API_KEY;
  if (!key) return { ok: false, items: [], reason: 'no-key' };

  const params = new URLSearchParams({
    confmKey: key,
    currentPage: '1',
    countPerPage: '30',
    keyword,
    resultType: 'json',
    hstryYn: 'N',           // 과거 주소 제외
    firstSort: 'road'        // 도로명 주소 우선
  });
  // juso API는 공식적으로 GET, business 서브도메인 사용
  const url = `https://business.juso.go.kr/addrlink/addrLinkApi.do?${params}`;

  try {
    const data = await safeFetchJson(url, 'juso.go.kr');
    const common = data?.results?.common;
    const errCode = common?.errorCode;
    // errorCode "0"은 정상, 그 외는 에러
    if (errCode && String(errCode) !== '0') {
      return {
        ok: false, items: [],
        reason: `juso.go.kr ${errCode}: ${common.errorMessage || ''}`
      };
    }
    const raw = data?.results?.juso || [];
    const items = raw.map((it) => {
      // 지번주소에서 읍면동/지번 추출하기 위해 일부 필드 파싱
      const jibunAddr = String(it.jibunAddr || '').trim();
      const roadAddr = String(it.roadAddr || '').trim();
      const bdNm = String(it.bdNm || '').trim();
      const sido = String(it.siNm || '').trim();
      const sigungu = String(it.sggNm || '').trim();
      const emdNm = String(it.emdNm || '').trim();
      // 지번 본번/부번
      const bonbun = String(it.lnbrMnnm || '').trim();
      const bubun = String(it.lnbrSlno || '').trim();

      return {
        source: 'juso',
        title: roadAddr || jibunAddr,
        bldName: bdNm,
        sido,
        sigungu,
        dong: emdNm,
        roadAddress: roadAddr,
        jibunAddress: jibunAddr,
        bonbun,
        bubun: bubun === '0' ? '' : bubun,
        // 프론트에서 addressInput에 채울 "깨끗한" 표시 주소
        // 지번이 있으면 지번 주소 우선 (우리 lookup.js가 지번 해석 더 안정적)
        displayAddress: jibunAddr || roadAddr,
        // 검색 쿼리 관련성 점수 (지금은 단순)
        score: bdNm ? 2 : 1
      };
    });
    return { ok: true, items };
  } catch (err) {
    return { ok: false, items: [], reason: err.message };
  }
}

// ========== VWorld POI 검색 ==========
async function searchVworldPoi(keyword) {
  const key = process.env.VWORLD_KEY;
  if (!key) return { ok: false, items: [], reason: 'no-key' };

  const params = new URLSearchParams({
    service: 'search',
    request: 'search',
    version: '2.0',
    crs: 'EPSG:4326',
    size: '20',
    page: '1',
    query: keyword,
    type: 'place',        // POI/건물명 검색
    format: 'json',
    errorformat: 'json',
    key
  });
  const url = `https://api.vworld.kr/req/search?${params}`;

  try {
    const data = await safeFetchJson(url, 'VWorld POI');
    const status = data?.response?.status;
    if (status === 'NOT_FOUND') return { ok: true, items: [] };
    if (status !== 'OK') {
      const errText = data?.response?.error?.text || `status=${status}`;
      return { ok: false, items: [], reason: `VWorld ${errText}` };
    }
    const raw = data?.response?.result?.items || [];
    const items = raw.map((it) => {
      const addr = it.address || {};
      const roadAddr = String(addr.road || '').trim();
      const parcelAddr = String(addr.parcel || '').trim();
      const title = String(it.title || '').trim();

      // VWorld POI는 구조화된 시/도·시/군/구 필드가 없음 → 문자열에서 추출
      // 우선 road에서, 없으면 parcel에서
      const SIDO_SIGUNGU_RE = /^(\S+?(?:특별시|광역시|특별자치시|특별자치도|도))\s+(\S+?(?:시|군|구))(?:\s+(\S+?(?:시|군|구)))?/;
      let sido = '', sigungu = '';
      const src = roadAddr || parcelAddr;
      const m = src.match(SIDO_SIGUNGU_RE);
      if (m) {
        sido = m[1];
        sigungu = m[3] ? `${m[2]} ${m[3]}` : m[2];
      }

      // 읍면동 추출 (parcel 주소에서 최소한 시도)
      let dong = '';
      if (parcelAddr) {
        const dongRe = /(\S+?(?:동|리|가))\s+\d/;
        const dm = parcelAddr.match(dongRe);
        if (dm) dong = dm[1];
      }

      return {
        source: 'vworld',
        title: title || parcelAddr || roadAddr,
        bldName: title,
        sido,
        sigungu,
        dong,
        roadAddress: roadAddr,
        jibunAddress: parcelAddr,
        bonbun: '',
        bubun: '',
        displayAddress: parcelAddr || roadAddr || title,
        score: title ? 1 : 0
      };
    });
    return { ok: true, items };
  } catch (err) {
    return { ok: false, items: [], reason: err.message };
  }
}

// ========== 중복 제거 키 ==========
// 같은 건물이 juso/VWorld 양쪽에서 나올 수 있으므로
// 주소 문자열을 정규화해서 비교
function dedupKey(c) {
  const s = [c.sido, c.sigungu, c.jibunAddress || c.roadAddress || c.title]
    .join('|')
    .replace(/\s+/g, '')
    .toLowerCase();
  return s;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    return json(res, 405, { success: false, error: 'POST만 지원합니다' });
  }

  const body = req.body || {};
  const query = String(body.query || '').trim();

  if (!query || query.length < 2) {
    return json(res, 400, { success: false, error: '검색어가 너무 짧습니다 (2자 이상)' });
  }
  if (query.length > 100) {
    return json(res, 400, { success: false, error: '검색어가 너무 깁니다' });
  }

  console.log(`[BUILDING-SEARCH] query="${query}"`);

  // 병렬 호출 — 한 쪽이 실패해도 다른 쪽으로 폴백
  const [jusoResult, vworldResult] = await Promise.all([
    searchJuso(query),
    searchVworldPoi(query)
  ]);

  console.log(`[BUILDING-SEARCH] juso=${jusoResult.items.length} vworld=${vworldResult.items.length}` +
    (jusoResult.ok ? '' : ` juso_fail="${jusoResult.reason}"`) +
    (vworldResult.ok ? '' : ` vworld_fail="${vworldResult.reason}"`));

  // 주소 기준 중복 제거 — juso가 먼저 들어가므로 동일 주소면 juso 레코드가 유지됨
  const seen = new Set();
  const merged = [];

  const addAll = (items) => {
    for (const it of items) {
      if (!it.displayAddress) continue;
      const k = dedupKey(it);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      merged.push(it);
    }
  };
  addAll(jusoResult.items);
  addAll(vworldResult.items);

  // 점수 높은 순 + juso 우선 정렬
  merged.sort((a, b) => {
    const pa = a.source === 'juso' ? 10 : 0;
    const pb = b.source === 'juso' ? 10 : 0;
    if (pa !== pb) return pb - pa;
    return (b.score || 0) - (a.score || 0);
  });

  const candidates = merged.slice(0, 20);

  // 양쪽 모두 실패한 경우에만 에러 처리
  if (!jusoResult.ok && !vworldResult.ok) {
    return json(res, 500, {
      success: false,
      error: '검색 서비스를 사용할 수 없습니다',
      details: {
        juso: jusoResult.reason,
        vworld: vworldResult.reason
      }
    });
  }

  return json(res, 200, {
    success: true,
    query,
    count: candidates.length,
    candidates,
    sources: {
      juso: { ok: jusoResult.ok, count: jusoResult.items.length },
      vworld: { ok: vworldResult.ok, count: vworldResult.items.length }
    }
  });
};
