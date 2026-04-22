# 공시가격 간편 조회

경매 물건 주소를 붙여넣기만 하면 공시가격(공동주택가격 / 개별주택가격 / 개별공시지가)을 자동으로 조회해주는 웹사이트입니다.

## 특징

- **붙여넣기 UX**: 경매 사이트에서 주소를 복사해 붙여넣으면 즉시 파싱·조회
- **신뢰도 기반 하이브리드 감지**: 호수 정보가 있으면 공동주택으로 자동 판단, 애매하면 사용자에게 확인
- **서버리스 아키텍처**: Vercel 함수로 API 키를 안전하게 보관
- **MOCK 모드**: API 키 없이도 UI 테스트 가능

## 기술 스택

- Frontend: Vanilla HTML/CSS/JS (프레임워크 없음)
- Backend: Node.js 18 (Vercel Serverless Functions)
- APIs:
  - 국토교통부 공공데이터포털 (개별주택가격 / 공동주택가격 / 개별공시지가)
  - VWorld Geocoder (법정동코드 조회)

## 폴더 구조

```
gongsi-lookup/
├── public/              # 정적 파일 (프론트엔드)
│   ├── index.html
│   ├── style.css
│   └── script.js
├── api/                 # Vercel 서버리스 함수
│   └── lookup.js
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
├── README.md
└── 가이드.md            # 한글 단계별 가이드
```

## 빠른 시작 (로컬)

```bash
# 1. 설치
npm install

# 2. 환경변수 복사
cp .env.example .env.local

# 3. (선택) API 키 입력 또는 MOCK_MODE=true로 유지

# 4. 로컬 서버 실행
npx vercel dev
# → http://localhost:3000 접속
```

실제 공시가격을 조회하려면 두 개의 API 키가 필요합니다. 발급 방법은 [가이드.md](./가이드.md)를 참고하세요.

## API 명세

### POST /api/lookup

**Request:**
```json
{
  "parsed": {
    "sido": "서울특별시",
    "sigungu": "금천구",
    "dong": "독산동",
    "bonbun": "378",
    "bubun": "33",
    "buildingName": "문정파크",
    "buildingDong": "2",
    "ho": "203"
  },
  "type": "apt"
}
```

**Response (성공):**
```json
{
  "success": true,
  "type": "apt",
  "address": "서울특별시 금천구 독산동 378-33 문정파크 제2동 제203호",
  "pnu": "1154510300103780033",
  "price": {
    "label": "공동주택가격",
    "value": 210000000,
    "year": 2025
  },
  "history": [...],
  "details": [...]
}
```

## 배포

Vercel로 배포:
```bash
npx vercel --prod
```

환경변수는 Vercel 대시보드 → Project Settings → Environment Variables에서 설정하세요.

## 라이선스

개인 사용 및 학습 목적용. 국토교통부 공공데이터 이용약관 및 VWorld 이용약관을 준수하세요.
