/**
 * 간단한 로컬 개발 서버
 *
 * 사용법:
 *   node server.js
 *
 * 브라우저에서 http://localhost:3000 접속
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ---- .env.local 직접 파싱 (dotenv 패키지 없이) ----
function loadEnv(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    data.split(/\r?\n/).forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = val;
    });
  } catch (e) {
    // .env.local 없으면 무시 (MOCK 모드로 동작)
  }
}
loadEnv(path.join(__dirname, '.env.local'));

// ---- API 핸들러 ----
const lookupHandler = require('./api/lookup.js');
const searchAddressHandler = require('./api/search-address.js');

// POST 바디 읽기 + Vercel 스타일 res 헬퍼 부착 + 핸들러 실행 공용 함수
function handleApiPost(handler, req, res) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    try {
      req.body = body ? JSON.parse(body) : {};
    } catch (e) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, error: '잘못된 요청 형식입니다' }));
      return;
    }
    res.status = function (code) { this.statusCode = code; return this; };
    res.json = function (data) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
      this.end(JSON.stringify(data));
    };
    res.send = function (data) {
      this.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[API 오류]', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    }
  });
}

// ---- MIME 타입 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // ---- API 라우트 ----
  if (parsed.pathname === '/api/lookup' && req.method === 'POST') {
    handleApiPost(lookupHandler, req, res);
    return;
  }
  if (parsed.pathname === '/api/search-address' && req.method === 'POST') {
    handleApiPost(searchAddressHandler, req, res);
    return;
  }

  // ---- 정적 파일 ----
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname === '/') pathname = '/index.html';

  // 디렉토리 탈출 방지
  if (pathname.includes('..')) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  const filePath = path.join(__dirname, 'public', pathname);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(data);
  });
});

server.listen(PORT, () => {
  const mockNote = process.env.MOCK_MODE === 'true' ? ' (MOCK 모드)' : '';
  console.log('');
  console.log('==========================================');
  console.log(`  공시가격 간편 조회 서버 시작!${mockNote}`);
  console.log('==========================================');
  console.log('');
  console.log(`  브라우저에서 http://localhost:${PORT} 접속`);
  console.log(`  (종료하려면 Ctrl + C)`);
  console.log('');
});
