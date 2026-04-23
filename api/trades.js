/* =========================================
   /api/trades — 국토교통부 실거래가 조회

   흐름:
     1. 프론트에서 { pnu, aptName, exclusiveArea, propertyType, startYmd, endYmd } 수신
        - propertyType: "apt" | "rowhouse"
        - startYmd, endYmd: "YYYYMM" (그 사이 모든 달 조회)
     2. PNU 앞 5자리 = LAWD_CD (법정동코드)
     3. 월 단위로 병렬 호출 (data.go.kr RTMS)
     4. XML 응답 파싱, aptName + exclusiveArea(±1㎡) 매칭 필터
     5. 거래일 내림차순 정렬, 해제여부 포함해서 반환

   환경변수:
     MOLIT_TRADE_KEY — data.go.kr 인증키 (Encoding 안 된 원본)
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

const { XMLParser } = require('fast-xml-parser');
const xml = new XMLParser({ ignoreAttributes: true, trimValues: true });

const ENDPOINTS = {
  apt:      'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  rowhouse: 'https://apis.data.go.kr/1613000/RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade'
};

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(body));
}

// "YYYYMM" 사이의 모든 월 나열 (양끝 포함)
function enumerateMonths(startYmd, endYmd) {
  const months = [];
  let y = parseInt(startYmd.slice(0, 4), 10);
  let m = parseInt(startYmd.slice(4, 6), 10);
  const endY = parseInt(endYmd.slice(0, 4), 10);
  const endM = parseInt(endYmd.slice(4, 6), 10);
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

async function safeFetchXml(url, label, maxRetries = 2) {
  const RETRYABLE = [
    'fetch failed', 'socket hang up', 'ECONNRESET', 'ETIMEDOUT',
    'aborted', 'TRANSIENT_HTTP_', 'SocketError', 'ConnectTimeoutError'
  ];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GongsiLookup/1.0)',
          'Accept': 'application/xml, text/xml, */*'
        },
        signal: AbortSignal.timeout(15000)
      });
      if (r.status >= 500 && r.status < 600) {
        throw new Error(`TRANSIENT_HTTP_${r.status}`);
      }
      const text = await r.text();
      // SERVICE ERROR / JSON 에러 응답 감지
      const trimmed = text.trim();
      if (!trimmed) throw new Error(`${label} 응답이 비어있습니다`);
      // 키 만료/차단시 JSON으로 에러 옴
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const j = JSON.parse(trimmed);
          const hdr = j?.OpenAPI_ServiceResponse?.cmmMsgHeader || j?.response?.header;
          const errMsg = hdr?.errMsg || hdr?.returnAuthMsg || JSON.stringify(hdr || j).slice(0, 200);
          throw new Error(`${label} API 오류: ${errMsg}`);
        } catch (e) {
          throw new Error(`${label} 비정상 응답: ${trimmed.slice(0, 200)}`);
        }
      }
      const parsed = xml.parse(trimmed);
      // 응답 기본 구조: response.header.resultCode, response.body.items.item
      const rc = parsed?.response?.header?.resultCode;
      if (rc && String(rc) !== '00' && String(rc) !== '000') {
        const msg = parsed?.response?.header?.resultMsg || `resultCode=${rc}`;
        // 00/000 외에는 에러. 단, OpenAPI_ServiceResponse 형태도 처리
        throw new Error(`${label} API 오류 [${rc}]: ${msg}`);
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);
      const retryable = RETRYABLE.some((k) => msg.includes(k));
      if (!retryable || attempt === maxRetries) throw err;
      const wait = 500 * Math.pow(2, attempt);
      console.log(`[${label}] retry ${attempt + 1} after ${wait}ms: ${msg.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// 공통: response.body.items.item을 배열로 정규화
function extractItems(parsed) {
  const items = parsed?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

// 거래가격 문자열("12,345") → 숫자(만원 단위)
function parsePriceMan(s) {
  if (s == null) return null;
  const n = parseInt(String(s).replace(/[^0-9-]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// 전용면적 매칭: ±1㎡ 허용
function matchArea(itemArea, targetArea) {
  if (targetArea == null) return true; // 필터 미지정이면 전부 통과
  const a = parseFloat(itemArea);
  if (isNaN(a)) return false;
  return Math.abs(a - targetArea) <= 1.0;
}

// 아파트명 매칭: 공백/특수문자 무시하고 부분일치
function normalizeName(s) {
  return String(s || '')
    .replace(/[\s\-\(\)\[\]·,.]/g, '')
    .toLowerCase();
}
function matchName(itemName, targetName) {
  if (!targetName) return true;
  const a = normalizeName(itemName);
  const b = normalizeName(targetName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// "2025", "1", "15" → "2025-01-15"
function fmtDate(y, m, d) {
  const Y = String(y || '').padStart(4, '0');
  const M = String(m || '').padStart(2, '0');
  const D = String(d || '').padStart(2, '0');
  return `${Y}-${M}-${D}`;
}

// item 하나를 정규화된 거래 객체로 변환
// 아파트/연립 스펙 차이:
//   아파트: aptNm(단지명), aptDong(동), floor, excluUseAr, dealAmount, dealYear/Month/Day, cdealType(해제여부)
//   연립:   mhouseType(주택유형), umdNm(법정동), excluUseAr, dealAmount, dealYear/Month/Day, cdealType
//          연립은 "단지명"이 따로 없고 동 정보도 약함. 주소(지번) + 면적으로 매칭.
function toTrade(item, propertyType) {
  const price = parsePriceMan(item.dealAmount);
  const area = parseFloat(item.excluUseAr) || null;
  const year = item.dealYear;
  const month = item.dealMonth;
  const day = item.dealDay;
  const floor = item.floor != null ? String(item.floor) : '';
  const cancelled = String(item.cdealType || '').trim() === 'O';
  const cancelDate = item.cdealDay ? String(item.cdealDay) : '';

  if (propertyType === 'apt') {
    return {
      dealDate: fmtDate(year, month, day),
      name: String(item.aptNm || '').trim(),
      dong: String(item.aptDong || '').trim(),
      floor,
      area,
      price,                // 만원 단위
      jibun: String(item.jibun || '').trim(),
      buildYear: item.buildYear ? String(item.buildYear) : '',
      dealType: String(item.dealingGbn || '').trim(),  // 중개/직거래
      cancelled,
      cancelDate,
      umdNm: String(item.umdNm || '').trim()
    };
  }
  // rowhouse
  return {
    dealDate: fmtDate(year, month, day),
    name: String(item.mhouseNm || item.mhouseType || '').trim(),  // 연립은 단지명 약함
    dong: '',
    floor,
    area,
    price,
    jibun: String(item.jibun || '').trim(),
    buildYear: item.buildYear ? String(item.buildYear) : '',
    dealType: String(item.dealingGbn || '').trim(),
    cancelled,
    cancelDate,
    umdNm: String(item.umdNm || '').trim()
  };
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

  const key = process.env.MOLIT_TRADE_KEY;
  if (!key) {
    return json(res, 500, { success: false, error: 'MOLIT_TRADE_KEY 환경변수가 설정되지 않았습니다' });
  }

  const body = req.body || {};
  const pnu = String(body.pnu || '').trim();
  const aptName = String(body.aptName || '').trim();
  const exclusiveArea = body.exclusiveArea != null ? Number(body.exclusiveArea) : null;
  const propertyType = body.propertyType === 'rowhouse' ? 'rowhouse' : 'apt';
  const startYmd = String(body.startYmd || '').trim();
  const endYmd = String(body.endYmd || '').trim();

  if (!pnu || pnu.length < 10) {
    return json(res, 400, { success: false, error: 'pnu가 올바르지 않습니다' });
  }
  if (!/^\d{6}$/.test(startYmd) || !/^\d{6}$/.test(endYmd)) {
    return json(res, 400, { success: false, error: 'startYmd/endYmd는 YYYYMM 형식이어야 합니다' });
  }

  const lawdCd = pnu.slice(0, 5);
  const months = enumerateMonths(startYmd, endYmd);
  if (months.length === 0) {
    return json(res, 400, { success: false, error: '조회 기간이 올바르지 않습니다' });
  }
  if (months.length > 60) {
    return json(res, 400, { success: false, error: '한 번에 최대 60개월까지만 조회 가능합니다' });
  }

  console.log(`[TRADES] pnu=${pnu} lawd=${lawdCd} type=${propertyType} months=${months.length} (${startYmd}~${endYmd})`);

  const endpoint = ENDPOINTS[propertyType];

  async function fetchMonth(dealYmd) {
    const params = new URLSearchParams({
      serviceKey: key,
      LAWD_CD: lawdCd,
      DEAL_YMD: dealYmd,
      numOfRows: '1000',
      pageNo: '1'
    });
    const url = `${endpoint}?${params}`;
    try {
      const parsed = await safeFetchXml(url, `실거래(${propertyType}/${dealYmd})`);
      const items = extractItems(parsed);
      return items.map((it) => toTrade(it, propertyType));
    } catch (err) {
      console.log(`[TRADES] ${dealYmd} 실패:`, err.message.slice(0, 120));
      return [];
    }
  }

  try {
    // 월 단위 병렬 호출 (동시성 제한 없이 — 24개 이하라 무방)
    const perMonth = await Promise.all(months.map(fetchMonth));
    const allTrades = perMonth.flat();

    const totalInLawd = allTrades.length;

    // 필터링: 단지명 + 전용면적
    const filtered = allTrades.filter((t) => {
      if (!matchName(t.name, aptName)) return false;
      if (!matchArea(t.area, exclusiveArea)) return false;
      return true;
    });

    // 거래일 내림차순 정렬
    filtered.sort((a, b) => (a.dealDate < b.dealDate ? 1 : a.dealDate > b.dealDate ? -1 : 0));

    console.log(`[TRADES] total=${totalInLawd} filtered=${filtered.length}`);

    return json(res, 200, {
      success: true,
      propertyType,
      startYmd,
      endYmd,
      monthsQueried: months.length,
      totalInLawd,
      filter: { aptName: aptName || null, exclusiveArea },
      trades: filtered
    });
  } catch (err) {
    console.error('[TRADES] error:', err);
    return json(res, 500, { success: false, error: err.message || '실거래가 조회 실패' });
  }
};
