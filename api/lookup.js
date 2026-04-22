/**
 * /api/lookup — 공시가격 조회 서버리스 함수
 *
 * 흐름:
 *   1. 프론트에서 { parsed, type } 수신
 *   2. 주소 형식(지번/도로명)에 따라 VWorld로 법정동코드+지번 획득 → PNU 구성
 *      - 지번: 1단계 (type=parcel 지오코딩)
 *      - 도로명: 2단계 (type=road 지오코딩 → 좌표 → 역지오코딩으로 지번 획득)
 *   3. 유형별 국토교통부 공시가격 API 호출
 *   4. 결과 정제해서 반환
 */

const DATA_KEY = process.env.DATA_GO_KR_KEY;
const VWORLD_KEY = process.env.VWORLD_KEY;
const MOCK = process.env.MOCK_MODE === 'true';

const API = {
  geocode: 'https://api.vworld.kr/req/address',
  // VWorld NED(국가공간정보센터) 직접 호출 — VWorld 키로 인증
  house:   'https://api.vworld.kr/ned/data/getIndvdHousingPriceAttr',
  apt:     'https://api.vworld.kr/ned/data/getApartHousingPriceAttr',
  land:    'https://api.vworld.kr/ned/data/getIndvdLandPriceAttr'
};

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'POST만 지원합니다' });
  }

  // 요청 호스트를 도메인 파라미터로 전달 (VWorld 키 도메인 검증용)
  // 로컬: http://localhost:3000, 배포: https://your-app.vercel.app
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const requestDomain = `${proto}://${host}`;

  try {
    const { parsed, type } = req.body || {};

    if (!parsed || !type) {
      return res.status(400).json({ success: false, error: '요청 데이터가 올바르지 않습니다' });
    }
    if (!['apt', 'house', 'land'].includes(type)) {
      return res.status(400).json({ success: false, error: '유효하지 않은 유형입니다' });
    }

    // 지번 / 도로명 주소 기본 필드 검증
    if (parsed.isRoad) {
      if (!parsed.sido || !parsed.sigungu || !parsed.roadName || !parsed.buildingNum) {
        return res.status(400).json({ success: false, error: '도로명주소 구성요소가 부족합니다' });
      }
    } else {
      if (!parsed.sido || !parsed.sigungu || !parsed.dong || !parsed.bonbun) {
        return res.status(400).json({ success: false, error: '지번주소 구성요소가 부족합니다' });
      }
    }

    if (MOCK || !DATA_KEY || !VWORLD_KEY) {
      return res.json(buildMockResponse(parsed, type));
    }

    // 1. PNU 조회 (지번/도로명 각각 분기)
    const pnuInfo = parsed.isRoad
      ? await getPnuFromRoad(parsed)
      : await getPnuFromLot(parsed);

    if (!pnuInfo) {
      return res.status(404).json({
        success: false,
        error: '해당 주소의 법정동코드를 찾지 못했습니다. 주소를 다시 확인해주세요.'
      });
    }

    // 2. 유형별 공시가격 API
    let priceData;
    if (type === 'apt') {
      priceData = await fetchApt(pnuInfo.pnu, parsed, requestDomain);
    } else if (type === 'house') {
      priceData = await fetchHouse(pnuInfo.pnu, requestDomain);
    } else {
      priceData = await fetchLand(pnuInfo.pnu, requestDomain);
    }

    if (!priceData || !priceData.price) {
      return res.json({
        success: true,
        type,
        address: formatAddress(parsed),
        pnu: pnuInfo.pnu,
        convertedFrom: parsed.isRoad ? pnuInfo.convertedJibun : null,
        price: null,
        notice: '이 주소의 공시가격 정보를 찾지 못했습니다. 신축이거나 아직 공시되지 않았을 수 있어요.'
      });
    }

    return res.json({
      success: true,
      type,
      address: formatAddress(parsed),
      pnu: pnuInfo.pnu,
      convertedFrom: parsed.isRoad ? pnuInfo.convertedJibun : null,
      price: priceData.price,
      history: priceData.history || [],
      details: priceData.details || [],
      notice: priceData.notice || null
    });
  } catch (err) {
    console.error('[lookup]', err);
    return res.status(500).json({
      success: false,
      error: err.message || '서버 오류가 발생했습니다'
    });
  }
};

// =========================================
// 지번 → PNU (기존 로직)
// =========================================
async function getPnuFromLot(parsed) {
  const addr = formatLotAddressForGeocode(parsed);

  const url = new URL(API.geocode);
  url.searchParams.set('service', 'address');
  url.searchParams.set('request', 'getcoord');
  url.searchParams.set('version', '2.0');
  url.searchParams.set('crs', 'epsg:4326');
  url.searchParams.set('address', addr);
  url.searchParams.set('refine', 'true');
  url.searchParams.set('simple', 'false');
  url.searchParams.set('format', 'json');
  url.searchParams.set('type', 'parcel');
  url.searchParams.set('key', VWORLD_KEY);

  console.log('[DEBUG] 지번 지오코딩 요청:', addr);
  const r = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  const data = await r.json();
  console.log('[DEBUG] 지번 지오코딩 응답:', JSON.stringify(data).slice(0, 500));
  if (data?.response?.status !== 'OK') return null;

  // VWorld getcoord 응답: structure는 response.refined.structure 에 있음
  // (response.result 아래가 아님 — 이전 코드 버그)
  const structure =
    data.response.refined?.structure || data.response.result?.structure;
  if (!structure) return null;

  const level4LC = String(structure.level4LC || '').trim();

  // 지번 getcoord는 level4LC에 19자리 PNU를 통째로 주는 경우가 많음
  if (level4LC.length === 19) {
    return { pnu: level4LC, legalCode: level4LC.slice(0, 10) };
  }

  // 10자리 법정동코드면 본번/부번으로 PNU 조립
  if (level4LC.length === 10) {
    const daejang = parsed.isSan ? '2' : '1';
    const bonbun4 = String(parsed.bonbun).padStart(4, '0');
    const bubun4 = String(parsed.bubun || '0').padStart(4, '0');
    return { pnu: level4LC + daejang + bonbun4 + bubun4, legalCode: level4LC };
  }

  // level4AC(행정동 코드)는 PNU 재료로 쓸 수 없으므로 실패 처리
  return null;
}

// =========================================
// 도로명 → PNU (2단계 지오코딩)
// =========================================
async function getPnuFromRoad(parsed) {
  // Step 1: 도로명주소 → 좌표
  const roadAddr = formatRoadAddressForGeocode(parsed);

  const url1 = new URL(API.geocode);
  url1.searchParams.set('service', 'address');
  url1.searchParams.set('request', 'getcoord');
  url1.searchParams.set('version', '2.0');
  url1.searchParams.set('crs', 'epsg:4326');
  url1.searchParams.set('address', roadAddr);
  url1.searchParams.set('refine', 'true');
  url1.searchParams.set('simple', 'false');
  url1.searchParams.set('format', 'json');
  url1.searchParams.set('type', 'road'); // 도로명
  url1.searchParams.set('key', VWORLD_KEY);

  console.log('[DEBUG] 도로명 → 좌표 요청:', roadAddr);
  const r1 = await fetch(url1.toString(), { signal: AbortSignal.timeout(8000) });
  const d1 = await r1.json();
  console.log('[DEBUG] 도로명 → 좌표 응답:', JSON.stringify(d1).slice(0, 500));
  if (d1?.response?.status !== 'OK') return null;

  const point = d1.response.result?.point;
  if (!point || !point.x || !point.y) return null;

  // Step 2: 좌표 → 지번주소 역지오코딩
  const url2 = new URL(API.geocode);
  url2.searchParams.set('service', 'address');
  url2.searchParams.set('request', 'getaddress');
  url2.searchParams.set('version', '2.0');
  url2.searchParams.set('crs', 'epsg:4326');
  url2.searchParams.set('point', `${point.x},${point.y}`);
  url2.searchParams.set('type', 'parcel'); // 지번으로 역변환
  url2.searchParams.set('format', 'json');
  url2.searchParams.set('key', VWORLD_KEY);

  console.log('[DEBUG] 좌표 → 지번 요청:', `${point.x},${point.y}`);
  const r2 = await fetch(url2.toString(), { signal: AbortSignal.timeout(8000) });
  const d2 = await r2.json();
  console.log('[DEBUG] 좌표 → 지번 응답:', JSON.stringify(d2).slice(0, 500));
  if (d2?.response?.status !== 'OK') return null;

  const result = Array.isArray(d2.response.result) ? d2.response.result[0] : d2.response.result;
  const structure = result?.structure;
  if (!structure) return null;

  const legalCode = structure.level4LC || structure.level4AC;
  // VWorld 응답에서 지번 본번-부번은 보통 structure.level5 에 들어있음
  // (detail 필드는 비어있는 경우가 많음)
  // 예: level5 = "19" 또는 "45-2"
  let jibunPart = String(structure.level5 || structure.detail || '').trim();

  // 그래도 비어있으면 result.text에서 마지막 지번 부분 추출 시도
  if (!jibunPart && result.text) {
    const m = String(result.text).match(/(?:산\s*)?\d+(?:-\d+)?\s*$/);
    if (m) jibunPart = m[0].trim();
  }

  if (!legalCode || !jibunPart) return null;

  // 산 여부: text 필드 또는 jibunPart 앞부분으로 판단
  const fullText = String(result.text || '');
  const isSan = /산\s*\d/.test(fullText) || /^산/.test(jibunPart);
  const cleanDetail = jibunPart.replace(/^산\s*/, '');
  const m = cleanDetail.match(/^(\d+)(?:-(\d+))?/);
  if (!m) return null;
  const bonbun = m[1];
  const bubun = m[2] || '0';

  const daejang = isSan ? '2' : '1';
  const bonbun4 = String(bonbun).padStart(4, '0');
  const bubun4 = String(bubun).padStart(4, '0');
  const pnu = legalCode + daejang + bonbun4 + bubun4;

  // 변환된 지번 표기용
  const convertedJibun =
    (structure.level1 || '') +
    ' ' +
    (structure.level2 || '') +
    (structure.level4L ? ' ' + structure.level4L : '') +
    (isSan ? ' 산 ' : ' ') +
    bonbun +
    (bubun !== '0' ? '-' + bubun : '');

  return { pnu, legalCode, convertedJibun: convertedJibun.trim() };
}

// =========================================
// 유형별 공시가격 API 호출
// =========================================
async function fetchHouse(pnu, requestDomain) {
  // 최신 연도부터 역순으로 7개 연도 병렬 조회
  // (stdrYear 미지정 시 VWorld가 가장 오래된 연도만 반환하는 문제 해결)
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => currentYear - i);

  async function fetchYear(year) {
    const url = new URL(API.house);
    url.searchParams.set('key', VWORLD_KEY);
    url.searchParams.set('pnu', pnu);
    url.searchParams.set('format', 'json');
    url.searchParams.set('numOfRows', '100');
    url.searchParams.set('pageNo', '1');
    url.searchParams.set('stdrYear', String(year));
    url.searchParams.set('domain', requestDomain || 'http://localhost:3000');
    try {
      const data = await safeFetchJson(url.toString(), `개별주택(${year})`);
      const items = extractItems(data);
      return { year, items: items || [] };
    } catch (err) {
      console.log(`[DEBUG] 개별주택 ${year}년 실패:`, err.message);
      return { year, items: [] };
    }
  }

  const responses = await Promise.all(years.map(fetchYear));

  // 연도별 아이템 병합
  const allItems = [];
  responses.forEach(({ year, items }) => {
    items.forEach((it) => allItems.push({ ...it, _year: year }));
  });
  if (allItems.length === 0) return null;

  console.log('[DEBUG] 개별주택 전체 수신:', allItems.length, '건');

  // 최신 연도 우선 정렬
  allItems.sort((a, b) => b._year - a._year);
  const latest = allItems[0];

  // 연도별 가격 이력 (한 연도당 하나)
  const byYear = new Map();
  allItems.forEach((it) => {
    const value = parseInt(it.housePc || it.price || 0);
    if (value && !byYear.has(it._year)) byYear.set(it._year, value);
  });
  const history = Array.from(byYear.entries())
    .map(([year, value]) => ({ year, value }))
    .sort((a, b) => b.year - a.year);

  return {
    price: {
      label: '개별주택가격',
      value: parseInt(latest.housePc || latest.price || 0),
      year: latest._year
    },
    history,
    details: [
      { label: '대지면적', value: (latest.lndpclAr || '-') + (latest.lndpclAr ? '㎡' : '') },
      { label: '건물연면적', value: (latest.bldngAr || '-') + (latest.bldngAr ? '㎡' : '') },
      { label: '주택구조', value: latest.strctCd || '-' }
    ]
  };
}

async function fetchApt(pnu, parsed, requestDomain) {
  // 최신 연도부터 역순으로 5개 연도 병렬 조회
  // (stdrYear 미지정 시 VWorld가 가장 오래된 연도만 반환하는 문제 해결)
  // 7년 → 5년: Vercel 함수 실행 시간 절약 (대형 단지 대응)
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  // 한 연도당 여러 페이지까지 긁어오기 (대형 단지 대응: 5,000+ 세대)
  async function fetchYear(year) {
    const allItems = [];
    for (let page = 1; page <= 20; page++) {
      const url = new URL(API.apt);
      url.searchParams.set('key', VWORLD_KEY);
      url.searchParams.set('pnu', pnu);
      url.searchParams.set('format', 'json');
      url.searchParams.set('numOfRows', '1000');
      url.searchParams.set('pageNo', String(page));
      url.searchParams.set('stdrYear', String(year));
      url.searchParams.set('domain', requestDomain || 'http://localhost:3000');
      try {
        const data = await safeFetchJson(url.toString(), `공동주택(${year}/p${page})`);
        const items = extractItems(data);
        if (!items || items.length === 0) break;
        allItems.push(...items);
        if (items.length < 1000) break; // 마지막 페이지
      } catch (err) {
        console.log(`[DEBUG] 공동주택 ${year}년 p${page} 실패:`, err.message);
        break;
      }
    }
    return { year, items: allItems };
  }

  const responses = await Promise.all(years.map(fetchYear));

  // 연도별 아이템 병합 (각 아이템에 _year 태그 부여)
  const allItems = [];
  responses.forEach(({ year, items }) => {
    items.forEach((it) => allItems.push({ ...it, _year: year }));
  });
  if (allItems.length === 0) return null;

  console.log('[DEBUG] 공동주택 전체 수신:', allItems.length, '건');

  // 동/호 매칭 (숫자만 비교해서 "제148동" vs "148" 같은 표기 차이 흡수)
  let matched = allItems;
  let dongMatched = true;
  let hoMatched = true;

  if (parsed.buildingDong) {
    const target = String(parsed.buildingDong).trim();
    const isNumeric = /^\d+$/.test(target);

    const dongOnly = allItems.filter((it) => {
      const itemDong = String(it.dongNm || '').trim();
      if (!itemDong) return false;
      if (isNumeric) {
        // 숫자 동 ("148" 등): 응답의 숫자 부분과 비교 ("제148동" → "148")
        return itemDong.replace(/[^0-9]/g, '') === target;
      }
      // 한글 동 ("가", "나", "가동" 등): 동 접미사 제거 후 비교
      const itemCore = itemDong.replace(/동$/, '');
      const targetCore = target.replace(/동$/, '');
      return itemCore === targetCore;
    });

    if (dongOnly.length > 0) {
      matched = dongOnly;
    } else {
      dongMatched = false;
    }
  }
  if (parsed.ho) {
    const hoOnly = matched.filter((it) => String(it.hoNm || '') === String(parsed.ho));
    if (hoOnly.length > 0) {
      matched = hoOnly;
    } else {
      hoMatched = false;
    }
  }

  // 최신 연도 기준 정렬
  matched.sort((a, b) => b._year - a._year);
  const latest = matched[0];

  // 연도별 추이 — 동일 동/호 기준으로만 (연도마다 다른 세대가 섞이지 않도록)
  const unitDong = latest.dongNm;
  const unitHo = latest.hoNm;
  const sameUnitItems = matched.filter(
    (it) => it.dongNm === unitDong && it.hoNm === unitHo
  );

  const byYear = new Map();
  sameUnitItems.forEach((it) => {
    const value = parseInt(it.pblntfPc || 0);
    if (value && !byYear.has(it._year)) byYear.set(it._year, value);
  });
  const history = Array.from(byYear.entries())
    .map(([year, value]) => ({ year, value }))
    .sort((a, b) => b.year - a.year);

  // 매칭 실패 안내
  let notice = null;
  if (parsed.buildingDong && !dongMatched) {
    notice = `⚠️ 입력하신 ${parsed.buildingDong}동이 이 단지에 없어서, 해당 번지의 대표 호수를 표시합니다. 동 번호를 다시 확인해주세요. (표시된 동: ${latest.dongNm})`;
  } else if (parsed.ho && !hoMatched) {
    notice = `⚠️ 입력하신 ${parsed.ho}호를 찾지 못해 같은 동의 다른 호수를 표시합니다. (표시된 호수: ${latest.hoNm}호)`;
  }

  return {
    price: {
      label: '공동주택가격',
      value: parseInt(latest.pblntfPc || 0),
      year: latest._year
    },
    history,
    details: [
      { label: '단지명', value: parsed.buildingName || '-' },
      { label: '동', value: latest.dongNm || '-' },
      { label: '호', value: latest.hoNm || '-' },
      { label: '전용면적', value: latest.prvuseAr ? latest.prvuseAr + '㎡' : '-' }
    ],
    notice
  };
}

async function fetchLand(pnu, requestDomain) {
  // 최신 연도부터 역순으로 7개 연도 병렬 조회
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => currentYear - i);

  async function fetchYear(year) {
    const url = new URL(API.land);
    url.searchParams.set('key', VWORLD_KEY);
    url.searchParams.set('pnu', pnu);
    url.searchParams.set('format', 'json');
    url.searchParams.set('numOfRows', '100');
    url.searchParams.set('pageNo', '1');
    url.searchParams.set('stdrYear', String(year));
    url.searchParams.set('domain', requestDomain || 'http://localhost:3000');
    try {
      const data = await safeFetchJson(url.toString(), `개별공시지가(${year})`);
      const items = extractItems(data);
      return { year, items: items || [] };
    } catch (err) {
      console.log(`[DEBUG] 개별공시지가 ${year}년 실패:`, err.message);
      return { year, items: [] };
    }
  }

  const responses = await Promise.all(years.map(fetchYear));

  // 연도별 아이템 병합
  const allItems = [];
  responses.forEach(({ year, items }) => {
    items.forEach((it) => allItems.push({ ...it, _year: year }));
  });
  if (allItems.length === 0) return null;

  console.log('[DEBUG] 개별공시지가 전체 수신:', allItems.length, '건');

  // 최신 연도 우선 정렬
  allItems.sort((a, b) => b._year - a._year);
  const latest = allItems[0];

  // 연도별 가격 이력 (한 연도당 하나)
  const byYear = new Map();
  allItems.forEach((it) => {
    const value = parseInt(it.pblntfPclnd || it.price || 0);
    if (value && !byYear.has(it._year)) byYear.set(it._year, value);
  });
  const history = Array.from(byYear.entries())
    .map(([year, value]) => ({ year, value }))
    .sort((a, b) => b.year - a.year);

  return {
    price: {
      label: '개별공시지가 (㎡당)',
      value: parseInt(latest.pblntfPclnd || 0),
      year: latest._year
    },
    history,
    details: [
      { label: '지목', value: latest.lndcgrCodeNm || '-' },
      { label: '면적', value: (latest.lndpclAr || '-') + (latest.lndpclAr ? '㎡' : '') },
      { label: '용도지역', value: latest.prposArea1Nm || '-' }
    ]
  };
}

// =========================================
// Helpers
// =========================================
function extractItems(data) {
  // VWorld NED: data.indvdHousingPrices.field / apHousingPrices.field / indvdLandPrices.field
  // 구 data.go.kr: data.response.body.items.item
  const ned =
    data?.indvdHousingPrices?.field ||
    data?.apHousingPrices?.field ||
    data?.apartHousingPrices?.field ||
    data?.indvdLandPrices?.field ||
    null;

  if (ned) return Array.isArray(ned) ? ned : [ned];

  const legacy =
    data?.response?.body?.items?.item ||
    data?.body?.items?.item ||
    data?.items?.item ||
    null;
  if (legacy) return Array.isArray(legacy) ? legacy : [legacy];

  return null;
}

// 응답을 먼저 text로 받고 JSON인지 확인한 뒤 파싱 — 에러 메시지를 또렷하게
async function safeFetchJson(url, label) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  console.log(`[DEBUG] ${label} 응답 상태:`, r.status, '본문 앞부분:', text.slice(0, 300));
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} API 응답이 비어있습니다`);
  if (trimmed.startsWith('<')) {
    throw new Error(`${label} API가 JSON이 아닌 응답(HTML/XML)을 반환했습니다. 키 권한을 확인해주세요.`);
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error(`${label} API 오류: ${trimmed.slice(0, 150)}`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`${label} API 응답 파싱 실패: ${trimmed.slice(0, 150)}`);
  }
}

function formatAddress(parsed) {
  let s = `${parsed.sido} ${parsed.sigungu}`;
  if (parsed.sigungu2) s += ` ${parsed.sigungu2}`;

  if (parsed.isRoad) {
    s += ` ${parsed.roadName}`;
    if (parsed.subRoad) s += ` ${parsed.subRoad}번길`;
    s += ` ${parsed.buildingNum}`;
    if (parsed.buildingSubNum && parsed.buildingSubNum !== '0') {
      s += `-${parsed.buildingSubNum}`;
    }
  } else {
    s += ` ${parsed.dong}`;
    if (parsed.isSan) s += ' 산';
    s += ` ${parsed.bonbun}`;
    if (parsed.bubun && parsed.bubun !== '0') s += `-${parsed.bubun}`;
  }

  if (parsed.buildingName) s += ` ${parsed.buildingName}`;
  if (parsed.buildingDong) s += ` 제${parsed.buildingDong}동`;
  if (parsed.floor) s += ` 제${parsed.floor}층`;
  if (parsed.ho) s += ` 제${parsed.ho}호`;
  return s;
}

function formatLotAddressForGeocode(parsed) {
  let s = `${parsed.sido} ${parsed.sigungu}`;
  if (parsed.sigungu2) s += ` ${parsed.sigungu2}`;
  s += ` ${parsed.dong}`;
  if (parsed.isSan) s += ' 산';
  s += ` ${parsed.bonbun}`;
  if (parsed.bubun && parsed.bubun !== '0') s += `-${parsed.bubun}`;
  return s;
}

function formatRoadAddressForGeocode(parsed) {
  let s = `${parsed.sido} ${parsed.sigungu}`;
  if (parsed.sigungu2) s += ` ${parsed.sigungu2}`;
  s += ` ${parsed.roadName}`;
  if (parsed.subRoad) s += ` ${parsed.subRoad}번길`;
  s += ` ${parsed.buildingNum}`;
  if (parsed.buildingSubNum && parsed.buildingSubNum !== '0') {
    s += `-${parsed.buildingSubNum}`;
  }
  return s;
}

// =========================================
// Mock 응답 (API 키 없을 때)
// =========================================
function buildMockResponse(parsed, type) {
  const mockData = {
    apt: {
      price: { label: '공동주택가격 (샘플)', value: 210000000, year: 2025 },
      history: [
        { year: 2025, value: 210000000 },
        { year: 2024, value: 200000000 },
        { year: 2023, value: 195000000 },
        { year: 2022, value: 180000000 }
      ],
      details: [
        { label: '단지명', value: parsed.buildingName || '샘플단지' },
        { label: '동', value: (parsed.buildingDong || '-') + '동' },
        { label: '호', value: (parsed.ho || '-') + '호' },
        { label: '전용면적', value: '27.47㎡' }
      ]
    },
    house: {
      price: { label: '개별주택가격 (샘플)', value: 320000000, year: 2025 },
      history: [
        { year: 2025, value: 320000000 },
        { year: 2024, value: 305000000 },
        { year: 2023, value: 295000000 }
      ],
      details: [
        { label: '대지면적', value: '125.5㎡' },
        { label: '건물연면적', value: '367.66㎡' },
        { label: '주택구조', value: '철근콘크리트' }
      ]
    },
    land: {
      price: { label: '개별공시지가 (㎡당, 샘플)', value: 3500000, year: 2025 },
      history: [
        { year: 2025, value: 3500000 },
        { year: 2024, value: 3350000 },
        { year: 2023, value: 3200000 }
      ],
      details: [
        { label: '지목', value: '대' },
        { label: '면적', value: '125.5㎡' },
        { label: '용도지역', value: '제2종일반주거지역' }
      ]
    }
  };

  const formatNote = parsed.isRoad
    ? ' (도로명주소 → 지번 변환 시뮬레이션)'
    : '';

  return {
    success: true,
    type,
    address: formatAddress(parsed),
    pnu: '(MOCK)',
    convertedFrom: parsed.isRoad ? '(MOCK) 변환된 지번 예시' : null,
    ...mockData[type],
    notice:
      `⚠️ 현재 MOCK 모드입니다${formatNote}. 실제 공시가격이 아닌 샘플 데이터가 표시됩니다. ` +
      '환경변수(DATA_GO_KR_KEY, VWORLD_KEY)를 설정하면 실제 데이터를 조회할 수 있습니다.'
  };
}
