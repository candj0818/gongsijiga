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

// --- State ---
let currentParsed = null;
let currentType = null;

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
  if (!sido) return null;

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

  // --- 도로명 vs 지번 판별 ---
  const roadHeadMatch = rest.match(/^(\S+?(?:대로|로|길))(\s|$)/);
  const lotHeadMatch = rest.match(/^(\S+?(?:동|리|가))(\s|$)/);

  if (roadHeadMatch) {
    return parseRoadTail({ sido, sigungu, sigungu2 }, rest, text);
  }
  if (lotHeadMatch) {
    return parseLotTail({ sido, sigungu, sigungu2 }, rest, text);
  }

  return null;
}

// --- 도로명주소 꼬리 파싱 ---
function parseRoadTail(head, rest, raw) {
  const roadMatch = rest.match(/^(\S+?(?:대로|로|길))/);
  if (!roadMatch) return null;
  const roadName = roadMatch[1];
  rest = rest.slice(roadName.length).trim();

  // 번길 (선택): 예) "123번길"
  let subRoad = null;
  const subRoadMatch = rest.match(/^(\d+)번길(\s|$)/);
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

  lines.push(`<div><span class="label">시/도</span><span class="value">${parsed.sido}</span></div>`);
  lines.push(`<div><span class="label">시/군/구</span><span class="value">${parsed.sigungu}${parsed.sigungu2 ? ' ' + parsed.sigungu2 : ''}</span></div>`);

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

  resultContent.innerHTML = html;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

// 시세 추정 비율 (공시가격 / 시세)
const MARKET_RATIO = {
  apt: 0.70,    // 공동주택 ≈ 시세의 70%
  house: 0.50,  // 개별주택 ≈ 시세의 50%
  land: 0.70    // 공시지가 ≈ 시세의 70%
};

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

  // 2) 시세 추정
  const ratio = MARKET_RATIO[type];
  if (ratio) {
    const marketPrice =
      type === 'land'
        ? Math.floor((price / ratio)) // 토지: 공시지가 기준 (원/㎡)
        : Math.floor(price / ratio);  // 주택: 총액 기준
    const ratioLabel =
      type === 'land'
        ? `공시지가 ÷ ${Math.round(ratio * 100)}% (㎡당)`
        : `공시가격 ÷ ${Math.round(ratio * 100)}%`;
    items.push(`
      <div class="analysis-item">
        <div class="analysis-label">💹 시세 추정</div>
        <div class="analysis-value">${formatKRW(marketPrice)}${type === 'land' ? ' /㎡' : ''}</div>
        <div class="analysis-formula">${ratioLabel}</div>
      </div>
    `);
  }

  // 3) 평당 가격
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
    resultBox.hidden = true;
    errorBox.hidden = true;
    return;
  }

  const parsed = parseAddress(raw);
  if (!parsed) {
    detectionBox.hidden = true;
    showError(
      '주소 형식을 인식하지 못했습니다. 아래 예시처럼 입력해주세요:\n' +
        '  • 지번: 서울특별시 관악구 봉천동 1529-16\n' +
        '  • 도로명: 서울특별시 강남구 테헤란로 123'
    );
    return;
  }
  hideError();
  currentParsed = parsed;
  const detection = detectType(parsed);
  showDetection(parsed, detection);
}, 250);

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
