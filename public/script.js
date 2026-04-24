/* =========================================
   공시가격 간편 조회 — 프론트엔드 로직
   (지번주소 + 도로명주소 모두 지원)
   ========================================= */

// --- DOM refs ---
const addressInput = document.getElementById('addressInput');
const detectionBox = document.getElementById('detectionBox');
const parsedPreview = document.getElementById('parsedPreview');
const detectionHigh = document.getElementById('detectionHigh');
const detectionLow = document.getElementById('detectionLow');
const detectedTypeName = document.getElementById('detectedTypeName');
const detectionReason = document.getElementById('detectionReason');
const lookupBtn = document.getElementById('lookupBtn');
const lookupBtnManual = document.getElementById('lookupBtnManual');
const changeTypeBtn = document.getElementById('changeTypeBtn');
const resultBox = document.getElementById('resultBox');
const resultContent = document.getElementById('resultContent');
const errorBox = document.getElementById('errorBox');
const errorContent = document.getElementById('errorContent');
const detectionResolve = document.getElementById('detectionResolve');
const resolveLoading = document.getElementById('resolveLoading');
const resolveCandidates = document.getElementById('resolveCandidates');
const lookupBtnResolved = document.getElementById('lookupBtnResolved');
// 단지명 검색 UI
const buildingSearchBox = document.getElementById('buildingSearchBox');
const buildingSearchQuery = document.getElementById('buildingSearchQuery');
const buildingSearchLoading = document.getElementById('buildingSearchLoading');
const buildingSearchCandidates = document.getElementById('buildingSearchCandidates');
const buildingSearchEmpty = document.getElementById('buildingSearchEmpty');

// --- State ---
let currentParsed = null;
let currentType = null;
let currentCandidates = [];
let selectedCandidateIdx = null;
let lastSearchQuery = null;
let lastLookupData = null;   // 최근 공시가격 조회 응답 (실거래가 조회시 재사용)
let tradesState = null;      // { propertyType, startYmd, endYmd, trades[], monthsQueried, totalInLawd }
let lastBuildingQuery = null; // 최근 단지명 검색어 (중복 호출 방지)
let isProgrammaticInput = false; // 후보 선택으로 input 값을 바꿀 때 parseAddress 루프 방지

// --- Type labels ---
const TYPE_LABELS = {
  apt: '공동주택 (아파트/빌라/오피스텔)',
  house: '개별주택 (단독/다가구)',
  land: '토지 (개별공시지가)'
};

// =========================================
// 주소 파싱 (지번 + 도로명)
// =========================================
function parseAddress(raw) {
  if (!raw || !raw.trim()) return null;

  // 공백 정규화 + 쉼표 제거 (도로명주소엔 쉼표가 자주 들어감)
  let text = raw.replace(/\s+/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  // --- 시/도 추출 (축약형 포함) ---
  // aliases 배열은 반드시 "긴 것부터" 나열 (정확한 매칭 우선)
  //   예) 서울특별시 > 서울시 > 서울
  const sidoPatterns = [
    { full: '서울특별시',     aliases: ['서울특별시', '서울시', '서울'] },
    { full: '부산광역시',     aliases: ['부산광역시', '부산시', '부산'] },
    { full: '대구광역시',     aliases: ['대구광역시', '대구시', '대구'] },
    { full: '인천광역시',     aliases: ['인천광역시', '인천시', '인천'] },
    { full: '광주광역시',     aliases: ['광주광역시', '광주시', '광주'] },
    { full: '대전광역시',     aliases: ['대전광역시', '대전시', '대전'] },
    { full: '울산광역시',     aliases: ['울산광역시', '울산시', '울산'] },
    { full: '세종특별자치시', aliases: ['세종특별자치시', '세종시', '세종'] },
    { full: '경기도',         aliases: ['경기도', '경기'] },
    { full: '강원특별자치도', aliases: ['강원특별자치도', '강원도', '강원'] },
    { full: '충청북도',       aliases: ['충청북도', '충북'] },
    { full: '충청남도',       aliases: ['충청남도', '충남'] },
    { full: '전북특별자치도', aliases: ['전북특별자치도', '전라북도', '전북'] },
    { full: '전라남도',       aliases: ['전라남도', '전남'] },
    { full: '경상북도',       aliases: ['경상북도', '경북'] },
    { full: '경상남도',       aliases: ['경상남도', '경남'] },
    { full: '제주특별자치도', aliases: ['제주특별자치도', '제주도', '제주'] }
  ];

  let sido = null;
  let rest = text;
  outer: for (const { full, aliases } of sidoPatterns) {
    for (const alias of aliases) {
      if (text.startsWith(alias + ' ')) {
        sido = full;
        rest = text.slice(alias.length).trim();
        break outer;
      }
    }
  }
  // 시/도가 없으면 축약 파싱 시도 (동/도로명부터 시작)
  if (!sido) return parseAbbreviated(text);

  // --- 시/군/구 ---
  const sigunguMatch = rest.match(/^(\S+?(?:특별자치시|시|군|구))(\s|$)/);
  if (!sigunguMatch) return null;
  const sigungu = sigunguMatch[1];
  rest = rest.slice(sigungu.length).trim();

  // 2단계 구(예: 수원시 영통구)
  const subSigunguMatch = rest.match(/^(\S+?구)(\s|$)/);
  let sigungu2 = null;
  if (subSigunguMatch) {
    sigungu2 = subSigunguMatch[1];
    rest = rest.slice(sigungu2.length).trim();
  }

  // 읍/면 (선택) — 예: 경기도 용인시 처인구 "원삼면" 사암리 55
  const eupmyeonMatch = rest.match(/^(\S+?(?:읍|면))(\s|$)/);
  let eupmyeon = null;
  if (eupmyeonMatch) {
    eupmyeon = eupmyeonMatch[1];
    rest = rest.slice(eupmyeon.length).trim();
  }

  // --- 도로명 vs 지번 판별 ---
  const roadHeadMatch = rest.match(/^(\S+?(?:대로|로|길))(\s|$)/);
  const lotHeadMatch = rest.match(/^(\S+?(?:동|리|가))(\s|$)/);

  if (roadHeadMatch) {
    return parseRoadTail({ sido, sigungu, sigungu2, eupmyeon }, rest, text);
  }
  if (lotHeadMatch) {
    return parseLotTail({ sido, sigungu, sigungu2, eupmyeon }, rest, text);
  }

  return null;
}

// --- 도로명주소 꼬리 파싱 ---
function parseRoadTail(head, rest, raw) {
  // (?=\s|$) lookahead로 "봉화산로6길", "테헤란로3길" 같은 N길/N번길 붙은 도로명 전체를 한 토큰으로 잡는다
  const roadMatch = rest.match(/^(\S+?(?:대로|로|길))(?=\s|$)/);
  if (!roadMatch) return null;
  const roadName = roadMatch[1];
  rest = rest.slice(roadName.length).trim();

  // 번길 (선택, "번" optional): 예) "123번길" 또는 "6길"
  let subRoad = null;
  const subRoadMatch = rest.match(/^(\d+)(?:번)?길(\s|$)/);
  if (subRoadMatch) {
    subRoad = subRoadMatch[1];
    rest = rest.slice(subRoadMatch[0].length).trim();
  }

  // 건물번호 (본번-부번)
  const bldNumMatch = rest.match(/^(\d+)(?:-(\d+))?/);
  if (!bldNumMatch) return null;
  const buildingNum = bldNumMatch[1];
  const buildingSubNum = bldNumMatch[2] || '0';
  rest = rest.slice(bldNumMatch[0].length).trim();

  const extra = parseExtra(rest);

  return {
    raw,
    isRoad: true,
    ...head,
    roadName,
    subRoad,
    buildingNum,
    buildingSubNum,
    ...extra
  };
}

// --- 지번주소 꼬리 파싱 ---
function parseLotTail(head, rest, raw) {
  const dongMatch = rest.match(/^(\S+?(?:동|리|가))/);
  if (!dongMatch) return null;
  const dong = dongMatch[1];
  rest = rest.slice(dong.length).trim();

  let isSan = false;
  if (/^산\s*\d/.test(rest)) {
    isSan = true;
    rest = rest.replace(/^산\s*/, '');
  }

  const jibunMatch = rest.match(/^(\d+)(?:-(\d+))?/);
  if (!jibunMatch) return null;
  const bonbun = jibunMatch[1];
  const bubun = jibunMatch[2] || '0';
  rest = rest.slice(jibunMatch[0].length).trim();

  const extra = parseExtra(rest);

  return {
    raw,
    isRoad: false,
    ...head,
    dong,
    isSan,
    bonbun,
    bubun,
    ...extra
  };
}

// --- 공통: 상세주소에서 건물명/동/층/호 추출 ---
function parseExtra(rest) {
  if (!rest) return { buildingName: '', buildingDong: '', floor: '', ho: '' };

  const dongMatch = rest.match(/제?([가-힣\d]+)동(?=\s|$)/);
  const floorMatch = rest.match(/제?(\d+)층(?=\s|$)/);
  const hoMatch = rest.match(/제?(\d+)호(?=\s|$)/);

  const buildingDong = dongMatch ? dongMatch[1] : '';
  const floor = floorMatch ? floorMatch[1] : '';
  const ho = hoMatch ? hoMatch[1] : '';

  const buildingName = rest
    .replace(/제?[가-힣\d]+동(?=\s|$)/g, '')
    .replace(/제?\d+층(?=\s|$)/g, '')
    .replace(/제?\d+호(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { buildingName, buildingDong, floor, ho };
}

// --- 축약 파싱 (시/도 생략) ---
// "봉천동 1529-16" 또는 "테헤란로 123" 처럼 시/도 없이 시작하는 주소
function parseAbbreviated(text) {
  let cursor = text;

  // 선행 시/군/구 감지 (optional) — 예: "관악구 봉천동 1529-16"
  const leadSigunguMatch = cursor.match(/^(\S+?(?:특별자치시|시|군|구))\s/);
  if (leadSigunguMatch) {
    cursor = cursor.slice(leadSigunguMatch[0].length);
    const leadSub = cursor.match(/^(\S+?구)\s/);
    if (leadSub) cursor = cursor.slice(leadSub[0].length);
    cursor = cursor.trim();
  }

  // 읍/면 (선택) — 예: "원삼면 사암리 55"
  let eupmyeon = null;
  const leadEupmyeonMatch = cursor.match(/^(\S+?(?:읍|면))\s/);
  if (leadEupmyeonMatch) {
    eupmyeon = leadEupmyeonMatch[1];
    cursor = cursor.slice(leadEupmyeonMatch[0].length).trim();
  }

  const roadHeadMatch = cursor.match(/^(\S+?(?:대로|로|길))(\s|$)/);
  const lotHeadMatch = cursor.match(/^(\S+?(?:동|리|가))(\s|$)/);

  let result = null;
  if (roadHeadMatch) {
    result = parseRoadTail({ eupmyeon }, cursor, text);
  } else if (lotHeadMatch) {
    result = parseLotTail({ eupmyeon }, cursor, text);
  }

  if (!result) return null;
  return { ...result, needsResolution: true };
}

// =========================================
// 유형 자동 감지
// =========================================
function detectType(parsed) {
  if (!parsed) {
    return { type: null, confidence: 'none', reason: '주소를 인식하지 못했습니다' };
  }

  if (parsed.isSan) {
    return { type: 'land', confidence: 'high', reason: '"산" 지번이라 토지로 판단됩니다' };
  }

  if (parsed.ho) {
    const reason = parsed.buildingName
      ? `"${parsed.buildingName}" 단지의 호수 정보가 있어 공동주택으로 판단됩니다`
      : '호수 정보가 있어 공동주택(다세대/빌라 등)으로 판단됩니다';
    return { type: 'apt', confidence: 'high', reason };
  }

  if (parsed.buildingDong) {
    return {
      type: 'apt',
      confidence: 'medium',
      reason: '동 정보는 있지만 호수가 없어 공동주택으로 추정됩니다 (호수 확인 권장)'
    };
  }

  if (parsed.floor) {
    return {
      type: 'apt',
      confidence: 'medium',
      reason: '층 정보가 있어 공동주택으로 추정됩니다'
    };
  }

  return {
    type: null,
    confidence: 'low',
    reason: '호수 정보가 없어 유형을 자동 판단할 수 없습니다'
  };
}

// =========================================
// UI 렌더링
// =========================================
function renderParsedPreview(parsed) {
  const lines = [];
  const formatBadge = parsed.isRoad
    ? '<span class="badge badge-success" style="margin-right:6px;">도로명</span>'
    : '<span class="badge badge-warn" style="margin-right:6px;">지번</span>';
  lines.push(`<div style="margin-bottom:4px;">${formatBadge}</div>`);

  if (parsed.sido) {
    lines.push(`<div><span class="label">시/도</span><span class="value">${parsed.sido}</span></div>`);
  }
  if (parsed.sigungu) {
    lines.push(`<div><span class="label">시/군/구</span><span class="value">${parsed.sigungu}${parsed.sigungu2 ? ' ' + parsed.sigungu2 : ''}</span></div>`);
  }
  if (parsed.eupmyeon) {
    lines.push(`<div><span class="label">읍/면</span><span class="value">${parsed.eupmyeon}</span></div>`);
  }

  if (parsed.isRoad) {
    let road = parsed.roadName;
    if (parsed.subRoad) road += ` ${parsed.subRoad}번길`;
    lines.push(`<div><span class="label">도로명</span><span class="value">${road}</span></div>`);
    let bldNum = parsed.buildingNum;
    if (parsed.buildingSubNum && parsed.buildingSubNum !== '0') bldNum += `-${parsed.buildingSubNum}`;
    lines.push(`<div><span class="label">건물번호</span><span class="value">${bldNum}</span></div>`);
  } else {
    lines.push(`<div><span class="label">법정동</span><span class="value">${parsed.dong}</span></div>`);
    const jibun = (parsed.isSan ? '산 ' : '') + parsed.bonbun + (parsed.bubun !== '0' ? '-' + parsed.bubun : '');
    lines.push(`<div><span class="label">지번</span><span class="value">${jibun}</span></div>`);
  }

  if (parsed.buildingName) {
    lines.push(`<div><span class="label">건물명</span><span class="value">${parsed.buildingName}</span></div>`);
  }
  if (parsed.buildingDong) {
    lines.push(`<div><span class="label">동</span><span class="value">${parsed.buildingDong}동</span></div>`);
  }
  if (parsed.ho) {
    lines.push(`<div><span class="label">호수</span><span class="value">${parsed.ho}호</span></div>`);
  }
  parsedPreview.innerHTML = lines.join('');
}

function showDetection(parsed, detection) {
  renderParsedPreview(parsed);
  detectionBox.hidden = false;

  // 축약 주소: 먼저 시/구 후보 선택
  if (parsed.needsResolution) {
    detectionHigh.hidden = true;
    detectionLow.hidden = true;
    detectionResolve.hidden = false;
    loadCandidates(parsed);
    return;
  }
  detectionResolve.hidden = true;

  if (detection.confidence === 'high' || detection.confidence === 'medium') {
    detectionHigh.hidden = false;
    detectionLow.hidden = true;
    detectedTypeName.textContent = TYPE_LABELS[detection.type];
    detectionReason.textContent = detection.reason;
    currentType = detection.type;
  } else {
    detectionHigh.hidden = true;
    detectionLow.hidden = false;
    currentType = null;
    document.querySelectorAll('input[name="ptype"]').forEach((r) => (r.checked = false));
    lookupBtnManual.disabled = true;
  }
}

// =========================================
// 축약 주소 — 후보 로드/선택/병합
// =========================================
function buildSearchQuery(parsed) {
  if (parsed.isRoad) {
    let q = parsed.roadName;
    if (parsed.subRoad) q += ` ${parsed.subRoad}번길`;
    q += ` ${parsed.buildingNum}`;
    if (parsed.buildingSubNum && parsed.buildingSubNum !== '0') q += `-${parsed.buildingSubNum}`;
    return q;
  } else {
    let q = parsed.dong;
    if (parsed.isSan) q += ' 산';
    q += ` ${parsed.bonbun}`;
    if (parsed.bubun && parsed.bubun !== '0') q += `-${parsed.bubun}`;
    return q;
  }
}

async function loadCandidates(parsed) {
  const query = buildSearchQuery(parsed);
  // 같은 쿼리면 재요청 방지
  if (query === lastSearchQuery && currentCandidates.length > 0) {
    renderCandidates(currentCandidates);
    return;
  }
  lastSearchQuery = query;

  resolveLoading.hidden = false;
  resolveCandidates.innerHTML = '';
  lookupBtnResolved.disabled = true;
  selectedCandidateIdx = null;

  try {
    const res = await fetch('/api/search-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, isRoad: parsed.isRoad })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '주소 검색 실패');
    }
    currentCandidates = data.candidates || [];
    renderCandidates(currentCandidates);
  } catch (err) {
    console.error(err);
    resolveCandidates.innerHTML = `<div style="color:var(--danger);font-size:14px;">검색 실패: ${err.message}</div>`;
  } finally {
    resolveLoading.hidden = true;
  }
}

function renderCandidates(candidates) {
  if (!candidates || candidates.length === 0) {
    resolveCandidates.innerHTML =
      '<div style="color:var(--gray-500);font-size:14px;">검색 결과가 없습니다. 주소를 확인해주세요.</div>';
    return;
  }
  const html = candidates
    .map((c, i) => {
      // 표시용 라벨: 시/도 + 시/군/구 + title (중복 방지)
      let label = '';
      const prefix = [c.sido, c.sigungu].filter(Boolean).join(' ').trim();
      if (prefix && c.title && !c.title.startsWith(prefix)) {
        label = `${prefix} ${c.title}`;
      } else {
        label = c.title || prefix || '(주소 정보 없음)';
      }
      const bld = c.bldName ? ` <small>(${escapeHtml(c.bldName)})</small>` : '';
      return `
      <label class="radio-chip">
        <input type="radio" name="candidate" value="${i}" />
        <span>${escapeHtml(label)}${bld}</span>
      </label>`;
    })
    .join('');
  resolveCandidates.innerHTML = html;

  resolveCandidates.querySelectorAll('input[name="candidate"]').forEach((r) => {
    r.addEventListener('change', (e) => {
      selectedCandidateIdx = parseInt(e.target.value, 10);
      lookupBtnResolved.disabled = false;
    });
  });

  // 후보가 1개면 자동 선택
  if (candidates.length === 1) {
    const input = resolveCandidates.querySelector('input[name="candidate"]');
    if (input) {
      input.checked = true;
      selectedCandidateIdx = 0;
      lookupBtnResolved.disabled = false;
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 선택한 후보로 currentParsed 재구성
// 핵심: candidate.title을 재파싱하지 말고, candidate.sido + candidate.sigungu만
// 원본 currentParsed에 덧입힌다. title은 VWorld가 지번/도로명 중 하나로만 줘서
// 원본의 도로명/건물번호/동/호수와 혼용하면 해석 불가능해지기 때문.
function applyCandidateResolution(candidate) {
  const sido = candidate.sido || '';
  const sigungu = candidate.sigungu || '';

  if (!sido || !sigungu) {
    // 안전장치: 시/도·시/군/구가 비어있으면 title에서 최후 파싱 시도
    const fullParsed = parseAddressStrict(candidate.title);
    if (!fullParsed) {
      showError('선택한 주소에서 시/도 정보를 가져올 수 없습니다: ' + candidate.title);
      return;
    }
    currentParsed = {
      ...fullParsed,
      buildingName: currentParsed.buildingName || fullParsed.buildingName || candidate.bldName || '',
      buildingDong: currentParsed.buildingDong || fullParsed.buildingDong || '',
      floor: currentParsed.floor || fullParsed.floor || '',
      ho: currentParsed.ho || fullParsed.ho || ''
    };
  } else {
    // 정상 경로: 원본 parsed에 시/도, 시/군/구만 얹고 needsResolution 해제
    currentParsed = {
      ...currentParsed,
      sido,
      sigungu,
      sigungu2: currentParsed.sigungu2 || '',
      buildingName: currentParsed.buildingName || candidate.bldName || '',
      needsResolution: false
    };
  }

  // 후보 패널 숨기고, 일반 감지 플로우로 진행
  detectionResolve.hidden = true;
  const detection = detectType(currentParsed);
  showDetection(currentParsed, detection);
}

// parseAddress는 시/도 없으면 parseAbbreviated로 fallback하므로,
// 재귀 방지를 위해 시/도 없을 땐 null을 돌려주는 엄격 버전을 별도로 둠
function parseAddressStrict(raw) {
  const p = parseAddress(raw);
  if (!p || p.needsResolution) return null;
  return p;
}

function renderResult(data) {
  resultBox.hidden = false;
  errorBox.hidden = true;

  const priceFormatted = data.price ? formatKRW(data.price.value) : '-';

  let html = `
    <p class="result-title">${TYPE_LABELS[data.type] || '공시가격'}</p>
    <p class="result-address">${data.address}</p>
    <div class="price-card">
      <div class="price-label">${data.price?.label || '공시가격'}</div>
      <p class="price-value">${priceFormatted}</p>
      <div class="price-year">${data.price?.year || ''}년 기준</div>
    </div>
  `;

  // 📊 참고 지표 (HUG 한도 / 시세 추정 / 평당 가격)
  html += renderPriceAnalysis(data);

  if (data.details && data.details.length > 0) {
    html += '<table class="detail-table"><tbody>';
    data.details.forEach((d) => {
      html += `<tr><th>${d.label}</th><td>${d.value}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  if (data.history && data.history.length > 0) {
    html += '<h4 style="margin-top:20px;font-size:14px;color:var(--gray-700);">📈 연도별 추이</h4>';
    html += '<table class="detail-table"><tbody>';
    data.history.forEach((h) => {
      html += `<tr><th>${h.year}년</th><td>${formatKRW(h.value)}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  if (data.notice) {
    html += `<p class="disclaimer" style="margin-top:16px;">${data.notice}</p>`;
  }

  // 실거래가 섹션 (공동주택에만 표시 — 단독/토지는 실거래 데이터 구조가 다름)
  if (data.type === 'apt' && data.pnu && data.tradeParams) {
    html += renderTradesIntro(data);
  }

  resultContent.innerHTML = html;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // 실거래가 섹션 이벤트 바인딩
  if (data.type === 'apt' && data.pnu && data.tradeParams) {
    attachTradesHandlers();
  }
}

// =========================================
// 실거래가 (국토교통부 RTMS)
// =========================================

// 단지명으로 propertyType 추정
// 빌라/다세대/연립 계열은 rowhouse 엔드포인트를 우선 시도
function detectPropertyType(bldName) {
  if (!bldName) return 'apt';
  const s = String(bldName);
  if (/(빌라|다세대|연립|타운하우스|빌|하우스|맨션|홈스|팰리스|스테이|하임|캐슬(?!밖)|파크빌|파크하우스)/i.test(s)) {
    return 'rowhouse';
  }
  return 'apt';
}

// YYYYMM 문자열 → {y, m}
function ymdToYm(ymd) {
  return { y: parseInt(ymd.slice(0, 4), 10), m: parseInt(ymd.slice(4, 6), 10) };
}
function ymToYmd(y, m) {
  return `${y}${String(m).padStart(2, '0')}`;
}
// 현재 월에서 N개월 전 YYYYMM
function ymdOffsetMonths(monthsAgo) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return ymToYmd(d.getFullYear(), d.getMonth() + 1);
}
// 두 YYYYMM 중 더 이른 것
function minYmd(a, b) {
  return a < b ? a : b;
}
// YYYYMM을 "YYYY년 M월"로
function formatYmd(ymd) {
  return `${ymd.slice(0, 4)}년 ${parseInt(ymd.slice(4, 6), 10)}월`;
}

// 초기 렌더: "실거래가 조회" 버튼 + 타입 토글
function renderTradesIntro(data) {
  const bldName = data.tradeParams.aptName || '';
  const jibun = data.tradeParams.jibun || '';
  const autoType = detectPropertyType(bldName);
  const aptChecked = autoType === 'apt' ? 'checked' : '';
  const rhChecked = autoType === 'rowhouse' ? 'checked' : '';
  const areaLabel = data.tradeParams.exclusiveArea
    ? `전용 ${data.tradeParams.exclusiveArea}㎡ ±1.5㎡`
    : '전용면적 정보 없음 (단지 전체 거래 표시)';
  const matchLabel = jibun
    ? `지번 ${jibun} 우선 매칭 (실패시 단지명 보조)`
    : '단지명 + 전용면적 매칭';

  return `
    <div class="trades-section" id="tradesSection" style="margin-top:24px;">
      <h4 class="trades-title">💰 실거래가 조회 <small>(국토교통부 RTMS)</small></h4>
      <div class="trades-intro">
        <div class="trades-filter-info">
          <div><strong>단지:</strong> ${escapeHtml(bldName || '(단지명 없음)')}</div>
          <div><strong>매칭방식:</strong> ${escapeHtml(matchLabel)}</div>
          <div><strong>면적:</strong> ${escapeHtml(areaLabel)}</div>
        </div>
        <div class="trades-type-toggle">
          <label class="radio-chip compact">
            <input type="radio" name="tradeType" value="apt" ${aptChecked} />
            <span>🏢 아파트</span>
          </label>
          <label class="radio-chip compact">
            <input type="radio" name="tradeType" value="rowhouse" ${rhChecked} />
            <span>🏘️ 연립/다세대</span>
          </label>
        </div>
        <button id="loadTradesBtn" class="primary-btn">최근 5년 거래 조회</button>
      </div>
      <div id="tradesResult"></div>
    </div>
  `;
}

function attachTradesHandlers() {
  const btn = document.getElementById('loadTradesBtn');
  if (btn) btn.addEventListener('click', () => loadInitialTrades());
}

async function loadInitialTrades() {
  const selected = document.querySelector('input[name="tradeType"]:checked');
  const propertyType = selected ? selected.value : 'apt';
  // 최근 60개월 (5년): 이번 달 ~ 60개월 전
  const endYmd = ymdOffsetMonths(0);
  const startYmd = ymdOffsetMonths(59);
  await fetchAndRenderTrades(propertyType, startYmd, endYmd, { reset: true });
}

async function loadMoreTrades() {
  if (!tradesState) return;
  // 기존 startYmd 직전부터 12개월 더
  const cur = ymdToYm(tradesState.startYmd);
  // startYmd의 한 달 전이 새 endYmd
  let ey = cur.y;
  let em = cur.m - 1;
  if (em < 1) { em = 12; ey--; }
  const newEnd = ymToYmd(ey, em);
  // 12개월 전
  let sy = ey;
  let sm = em - 11;
  while (sm < 1) { sm += 12; sy--; }
  const newStart = ymToYmd(sy, sm);
  await fetchAndRenderTrades(tradesState.propertyType, newStart, newEnd, { reset: false });
}

async function fetchAndRenderTrades(propertyType, startYmd, endYmd, { reset }) {
  const container = document.getElementById('tradesResult');
  if (!container || !lastLookupData) return;

  // 로딩 표시
  if (reset) {
    container.innerHTML = '<div class="loading"><span class="spinner"></span>실거래가를 조회하고 있습니다... (최대 60개월)</div>';
    // intro 박스 숨기기 (조회 시작하면 툴바만 남김)
    const intro = document.querySelector('#tradesSection .trades-intro');
    if (intro) intro.style.display = 'none';
  } else {
    const loadMoreBtn = document.getElementById('loadMoreTradesBtn');
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = '조회 중...';
    }
  }

  try {
    const res = await fetch('/api/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pnu: lastLookupData.pnu,
        aptName: lastLookupData.tradeParams.aptName,
        jibun: lastLookupData.tradeParams.jibun,  // 지번 기반 매칭 (경매 맥락 최우선)
        exclusiveArea: lastLookupData.tradeParams.exclusiveArea,
        propertyType,
        startYmd,
        endYmd
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '실거래가 조회 실패');

    if (reset) {
      tradesState = {
        propertyType: data.propertyType,
        startYmd: data.startYmd,
        endYmd: data.endYmd,
        trades: data.trades || [],
        monthsQueried: data.monthsQueried,
        totalInLawd: data.totalInLawd,
        matchStrategy: data.matchStrategy || null,
        nameHints: data.nameHints || null
      };
    } else {
      // 더 보기: 기존에 합치고 정렬
      tradesState.startYmd = minYmd(tradesState.startYmd, data.startYmd);
      tradesState.monthsQueried += data.monthsQueried;
      tradesState.totalInLawd += data.totalInLawd;
      tradesState.trades = [...tradesState.trades, ...(data.trades || [])].sort((a, b) =>
        a.dealDate < b.dealDate ? 1 : a.dealDate > b.dealDate ? -1 : 0
      );
      // matchStrategy는 최신값 우선, nameHints는 여전히 0건일 때만 갱신
      if (data.matchStrategy) tradesState.matchStrategy = data.matchStrategy;
      if (tradesState.trades.length === 0 && data.nameHints) {
        tradesState.nameHints = data.nameHints;
      }
    }
    renderTradesTable();
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="trades-error">실거래가 조회 실패: ${escapeHtml(err.message || '알 수 없는 오류')}</div>`;
  }
}

function renderTradesTable() {
  const container = document.getElementById('tradesResult');
  if (!container || !tradesState) return;

  const { propertyType, startYmd, endYmd, trades, monthsQueried, totalInLawd, matchStrategy, nameHints } = tradesState;
  const periodLabel = `${formatYmd(startYmd)} ~ ${formatYmd(endYmd)} (${monthsQueried}개월)`;
  const typeLabel = propertyType === 'rowhouse' ? '연립/다세대' : '아파트';

  // 매칭 전략 배지 (jibun/name — 사용자에게 왜 이 결과인지 알려줌)
  let strategyBadge = '';
  if (matchStrategy === 'jibun+area') {
    strategyBadge = '<span class="badge badge-success" style="margin-left:6px;">지번+면적 매칭</span>';
  } else if (matchStrategy === 'name+area') {
    strategyBadge = '<span class="badge badge-warn" style="margin-left:6px;">단지명+면적 매칭</span>';
  }

  // 최대 확장 한도 체크 (서버측 60개월 제한과 맞춤)
  const canLoadMore = monthsQueried < 60;

  let html = `
    <div class="trades-header">
      <div>
        <div><strong>${escapeHtml(typeLabel)}</strong> · ${escapeHtml(periodLabel)}${strategyBadge}</div>
        <div class="trades-summary">일치 거래 ${trades.length}건 / 법정동 전체 ${totalInLawd}건</div>
      </div>
    </div>
  `;

  if (trades.length === 0) {
    let hintHtml = '';
    if (nameHints && nameHints.length > 0) {
      const chips = nameHints.slice(0, 15).map((h) =>
        `<span class="name-hint-chip">${escapeHtml(h.name)} <small>(${h.count})</small></span>`
      ).join('');
      hintHtml = `
        <div class="trades-name-hints">
          <div class="hint-label">📋 이 법정동에서 같은 기간 거래된 ${propertyType === 'rowhouse' ? '연립/다세대' : '아파트'} 단지명 (거래 건수):</div>
          <div class="hint-chips">${chips}</div>
          <div class="hint-note">
            위 목록에 이 물건의 단지명이 있다면, RTMS 데이터에 등록된 명칭이 입력한 것과 달라서 매칭 실패한 것일 수 있어요.
            ${propertyType === 'apt' ? '"연립/다세대"로 다시 조회' : '"아파트"로 다시 조회'}하면 결과가 나올 수도 있습니다.
          </div>
        </div>
      `;
    }
    html += `
      <div class="trades-empty">
        ${escapeHtml(periodLabel)} 내 일치 거래가 없습니다.
        ${totalInLawd > 0
          ? `법정동 전체로는 ${totalInLawd}건 있어요 — 지번/단지명 매칭이 안 됐거나 전용면적이 다를 수 있습니다.`
          : '이 법정동에는 해당 유형 거래 자체가 없습니다.'}
      </div>
      ${hintHtml}
    `;
  } else {
    html += `
      <div class="trades-table-wrap">
        <table class="trades-table">
          <thead>
            <tr>
              <th>계약일</th>
              <th>동</th>
              <th>층</th>
              <th>전용면적</th>
              <th class="num">거래가</th>
              <th>비고</th>
            </tr>
          </thead>
          <tbody>
    `;
    trades.forEach((t) => {
      const priceFmt = t.price != null ? `${t.price.toLocaleString()}만원` : '-';
      const areaFmt = t.area != null ? `${t.area.toFixed(2)}㎡` : '-';
      const rowClass = t.cancelled ? 'cancelled' : '';
      const note = t.cancelled
        ? `<span class="badge-cancel">해제</span>`
        : (t.dealType ? escapeHtml(t.dealType) : '');
      html += `
        <tr class="${rowClass}">
          <td>${escapeHtml(t.dealDate)}</td>
          <td>${escapeHtml(t.dong || '-')}</td>
          <td>${escapeHtml(t.floor || '-')}</td>
          <td>${escapeHtml(areaFmt)}</td>
          <td class="num">${escapeHtml(priceFmt)}</td>
          <td>${note}</td>
        </tr>
      `;
    });
    html += `</tbody></table></div>`;
  }

  // 더 과거 보기 버튼
  if (canLoadMore) {
    html += `
      <div class="trades-actions">
        <button id="loadMoreTradesBtn" class="secondary-btn">더 과거 1년 보기</button>
        <button id="resetTradesBtn" class="secondary-btn">조건 다시 선택</button>
      </div>
    `;
  } else {
    html += `
      <div class="trades-actions">
        <div class="trades-limit-notice">최대 조회 기간(60개월)에 도달했습니다.</div>
        <button id="resetTradesBtn" class="secondary-btn">조건 다시 선택</button>
      </div>
    `;
  }

  container.innerHTML = html;

  const moreBtn = document.getElementById('loadMoreTradesBtn');
  if (moreBtn) moreBtn.addEventListener('click', () => loadMoreTrades());
  const resetBtn = document.getElementById('resetTradesBtn');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    tradesState = null;
    // intro 다시 노출
    if (lastLookupData) {
      const section = document.getElementById('tradesSection');
      if (section) section.outerHTML = renderTradesIntro(lastLookupData);
      attachTradesHandlers();
    }
  });
}

function formatKRW(n) {
  if (n == null) return '-';
  const eok = Math.floor(n / 100000000);
  const man = Math.floor((n % 100000000) / 10000);
  const won = n % 10000;
  const parts = [];
  if (eok > 0) parts.push(eok + '억');
  if (man > 0) parts.push(man.toLocaleString() + '만');
  if (won > 0 && eok === 0) parts.push(won + '원');
  return parts.length > 0 ? parts.join(' ') : n.toLocaleString() + '원';
}

// =========================================
// 참고 지표 계산 (HUG / 시세 / 평당)
// =========================================
// details 배열에서 면적(㎡) 숫자 추출
// 우선순위: 전용면적 > 건물연면적 > 대지면적 > 면적
function extractArea(data) {
  if (!data.details) return null;
  const priority = ['전용면적', '건물연면적', '대지면적', '면적'];
  for (const label of priority) {
    const d = data.details.find((x) => x.label === label);
    if (d && d.value) {
      const match = String(d.value).match(/([\d.,]+)/);
      if (match) {
        const num = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(num) && num > 0) {
          return { label, m2: num };
        }
      }
    }
  }
  return null;
}

function renderPriceAnalysis(data) {
  const price = data.price?.value;
  if (!price || price <= 0) return '';

  const type = data.type;
  const items = [];

  // 1) HUG 전세보증 한도 (apt/house만, land 제외)
  if (type === 'apt' || type === 'house') {
    const hugLimit = Math.floor(price * 1.26);
    items.push(`
      <div class="analysis-item">
        <div class="analysis-label">🏦 HUG 전세보증 한도</div>
        <div class="analysis-value">${formatKRW(hugLimit)}</div>
        <div class="analysis-formula">공시가격 × 126%</div>
      </div>
    `);
  }

  // 2) 평당 가격
  if (type === 'land') {
    // 공시지가는 원/㎡ → 원/평 = × 3.3058
    const perPyeong = Math.floor(price * 3.3058);
    items.push(`
      <div class="analysis-item">
        <div class="analysis-label">📐 평당 공시지가</div>
        <div class="analysis-value">${formatKRW(perPyeong)}</div>
        <div class="analysis-formula">㎡당 × 3.3058</div>
      </div>
    `);
  } else {
    const area = extractArea(data);
    if (area && area.m2 > 0) {
      const pyeong = area.m2 / 3.3058;
      const perPyeong = Math.floor(price / pyeong);
      items.push(`
        <div class="analysis-item">
          <div class="analysis-label">📐 평당 공시가격</div>
          <div class="analysis-value">${formatKRW(perPyeong)}</div>
          <div class="analysis-formula">${area.label} ${area.m2}㎡ (${pyeong.toFixed(2)}평)</div>
        </div>
      `);
    }
  }

  if (items.length === 0) return '';

  return `
    <div class="analysis-card">
      <div class="analysis-title">📊 참고 지표</div>
      <div class="analysis-grid">
        ${items.join('')}
      </div>
      <div class="analysis-disclaimer">
        ※ 경험칙 기반 추정치입니다. 실제 시세·보증한도는 물건 상태와 시장 상황에 따라 달라집니다.
      </div>
    </div>
  `;
}

function showError(msg) {
  errorBox.hidden = false;
  errorContent.textContent = msg;
  resultBox.hidden = true;
}

function hideError() {
  errorBox.hidden = true;
}

function showLoading() {
  resultBox.hidden = false;
  errorBox.hidden = true;
  resultContent.innerHTML =
    '<div class="loading"><span class="spinner"></span>공시가격을 조회하고 있습니다...</div>';
}

// =========================================
// API 호출
// =========================================
async function lookupPrice(parsed, type) {
  showLoading();
  // 이전 조회의 실거래가 상태는 초기화
  lastLookupData = null;
  tradesState = null;
  try {
    const res = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parsed, type })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '조회에 실패했습니다');
    }
    lastLookupData = data;
    renderResult(data);
  } catch (err) {
    console.error(err);
    showError(err.message || '조회 중 오류가 발생했습니다');
  }
}

// =========================================
// 이벤트 핸들러
// =========================================
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const handleInput = debounce(() => {
  const raw = addressInput.value.trim();
  if (!raw) {
    detectionBox.hidden = true;
    buildingSearchBox.hidden = true;
    resultBox.hidden = true;
    errorBox.hidden = true;
    return;
  }

  const parsed = parseAddress(raw);
  if (!parsed) {
    // 주소 파싱 실패 → 단지명으로 검색 시도 (2자 이상일 때만)
    detectionBox.hidden = true;
    if (raw.length >= 2) {
      hideError();
      triggerBuildingSearch(raw);
    } else {
      buildingSearchBox.hidden = true;
      showError(
        '주소 또는 단지명을 입력해주세요:\n' +
          '  • 지번: 서울특별시 관악구 봉천동 1529-16\n' +
          '  • 도로명: 서울특별시 강남구 테헤란로 123\n' +
          '  • 단지명: 쌍용 더플래티넘 용마산'
      );
    }
    return;
  }
  hideError();
  buildingSearchBox.hidden = true;
  currentParsed = parsed;
  const detection = detectType(parsed);
  showDetection(parsed, detection);
}, 250);

// =========================================
// 단지명 검색 (주소 파싱 실패시)
// =========================================
async function triggerBuildingSearch(query) {
  // 프로그래밍으로 input 바꾼 경우 재검색 막음
  if (isProgrammaticInput) return;

  // 동일 쿼리 연속 호출 방지
  if (query === lastBuildingQuery && !buildingSearchBox.hidden) return;
  lastBuildingQuery = query;

  buildingSearchBox.hidden = false;
  buildingSearchQuery.textContent = `"${query}"`;
  buildingSearchLoading.hidden = false;
  buildingSearchCandidates.innerHTML = '';
  buildingSearchEmpty.hidden = true;

  try {
    const res = await fetch('/api/search-building', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '단지명 검색 실패');
    }
    renderBuildingCandidates(data.candidates || []);
  } catch (err) {
    console.error('[building search]', err);
    buildingSearchCandidates.innerHTML =
      `<div class="building-search-empty">검색 실패: ${escapeHtml(err.message)}</div>`;
  } finally {
    buildingSearchLoading.hidden = true;
  }
}

function renderBuildingCandidates(candidates) {
  if (!candidates || candidates.length === 0) {
    buildingSearchEmpty.hidden = false;
    buildingSearchCandidates.innerHTML = '';
    return;
  }
  buildingSearchEmpty.hidden = true;

  const html = candidates
    .map((c, i) => {
      const sourceBadge = c.source === 'juso'
        ? '<span class="source-badge juso">juso</span>'
        : '<span class="source-badge vworld">VWorld</span>';
      const primary = escapeHtml(c.bldName || c.title || '(이름 없음)');
      // 표시용: 시/도 + 시/군/구 + 주소
      const addrText = c.roadAddress || c.jibunAddress || c.displayAddress || '';
      const addrDisplay = escapeHtml(addrText);
      return `
        <label class="radio-chip building-candidate">
          <input type="radio" name="buildingCandidate" value="${i}" />
          <span class="candidate-main">
            ${sourceBadge}
            <strong class="candidate-name">${primary}</strong>
          </span>
          <small class="candidate-addr">${addrDisplay}</small>
        </label>`;
    })
    .join('');
  buildingSearchCandidates.innerHTML = html;

  // 선택시 즉시 주소 입력란에 채우고 재파싱
  buildingSearchCandidates.querySelectorAll('input[name="buildingCandidate"]').forEach((r) => {
    r.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value, 10);
      const chosen = candidates[idx];
      if (!chosen) return;
      applyBuildingCandidate(chosen);
    });
  });
}

function applyBuildingCandidate(candidate) {
  // juso 결과는 지번주소를 우선 (우리 파서가 지번에 더 강함)
  // VWorld 결과는 parcel/road 중 먼저 있는 거 사용
  const addr = candidate.jibunAddress || candidate.roadAddress || candidate.displayAddress;
  if (!addr) {
    showError('선택한 단지의 주소 정보를 찾을 수 없습니다');
    return;
  }

  // 건물명이 있으면 주소 뒤에 붙여서 buildingName이 파싱되도록 함
  let combined = addr;
  if (candidate.bldName && !addr.includes(candidate.bldName)) {
    combined = `${addr} ${candidate.bldName}`;
  }

  // 프로그래밍 변경 플래그 세팅 — input 이벤트가 다시 triggerBuildingSearch 하지 않도록
  isProgrammaticInput = true;
  addressInput.value = combined;
  isProgrammaticInput = false;

  // 단지명 검색 박스 숨기기
  buildingSearchBox.hidden = true;
  lastBuildingQuery = null;

  // 직접 파싱해서 일반 흐름으로 태움
  const parsed = parseAddress(combined);
  if (!parsed) {
    showError(`선택한 주소를 해석하지 못했습니다: ${combined}`);
    return;
  }
  hideError();
  currentParsed = parsed;
  const detection = detectType(parsed);
  showDetection(parsed, detection);
  // 스크롤
  detectionBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

addressInput.addEventListener('input', handleInput);
addressInput.addEventListener('paste', () => {
  setTimeout(handleInput, 0);
});

lookupBtn.addEventListener('click', () => {
  if (currentParsed && currentType) {
    lookupPrice(currentParsed, currentType);
  }
});

changeTypeBtn.addEventListener('click', () => {
  detectionHigh.hidden = true;
  detectionLow.hidden = false;
  currentType = null;
  document.querySelectorAll('input[name="ptype"]').forEach((r) => (r.checked = false));
  lookupBtnManual.disabled = true;
});

document.querySelectorAll('input[name="ptype"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    currentType = e.target.value;
    lookupBtnManual.disabled = false;
  });
});

lookupBtnManual.addEventListener('click', () => {
  if (currentParsed && currentType) {
    lookupPrice(currentParsed, currentType);
  }
});

lookupBtnResolved.addEventListener('click', () => {
  if (selectedCandidateIdx === null) return;
  const c = currentCandidates[selectedCandidateIdx];
  if (c) applyCandidateResolution(c);
});
