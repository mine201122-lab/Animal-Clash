'use strict';
// ANIMAL CLASH 중계 서버
//
// 하는 일: 방을 만들고, 방 안의 메시지를 대신 전달한다. 그게 전부다.
// 플레이어끼리 직접 연결하지 않으므로 서로의 IP 주소가 보이지 않는다.
//
// 하지 않는 일: 게임 판정. 위치·명중·피해는 여전히 클라이언트가 정하고,
// 서버는 그 말을 그대로 옮긴다. 즉 이것은 치팅 방어가 아니다.
// 치팅을 막으려면 서버가 물리와 판정을 직접 굴려야 한다(서버 권위 구조).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT       = Number(process.env.PORT || 3000);
const MAX_ROOMS  = Number(process.env.MAX_ROOMS || 200);
const MAX_PEERS  = Number(process.env.MAX_PEERS || 8);
const MAX_MSG    = 4 * 1024;   // 한 메시지 최대 바이트
const RATE_MSGS  = 200;        // 창(窓)당 허용 메시지 수
const RATE_WIN   = 1000;       // 창 길이(ms)
const DMG_CAP    = 250;        // 터무니없는 피해값 차단 (치팅 방어 아님 — 상한선일 뿐)
const ROOM_RE    = /^[a-z0-9]{1,12}$/;

const rooms = new Map();       // code -> Map(id -> ws)
let seq = 0;

const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── HTTP: 게임 파일 서빙 + 상태 확인 ──
// 게임을 같은 서버에서 내려주면 좋은 점이 둘 있다.
//   ① 접속 주소를 따로 입력할 필요가 없다 (페이지와 같은 출처를 쓰면 된다)
//   ② file:// 로 열 때 생기는 브라우저 제약(마우스 잠금 등)이 사라진다
const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',   '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  if (url === '/health') {
    let peers = 0;
    for (const r of rooms.values()) peers += r.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers, uptime: Math.round(process.uptime()) }));
    return;
  }

  // 경로 탈출 차단 — ROOT 밖은 절대 내주지 않는다
  const file = path.resolve(ROOT, '.' + (url === '/' ? '/index.html' : url));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  if (file.startsWith(path.join(ROOT, 'server'))) { res.writeHead(403).end(); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 파일입니다'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

// 방 안의 나머지에게 전달
function relay(room, msg, exceptId) {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const [id, ws] of peers) if (id !== exceptId) send(ws, msg);
}

function leave(ws) {
  const peers = rooms.get(ws.room);
  if (!peers) return;
  peers.delete(ws.id);
  relay(ws.room, { t: 'bye', id: ws.id });
  if (peers.size === 0) {
    rooms.delete(ws.room);
    log('방 삭제', ws.room);
  } else {
    log('퇴장', ws.room, ws.id, '남은 인원', peers.size);
  }
}

wss.on('connection', (ws, req) => {
  ws.id = null;
  ws.room = null;
  ws.alive = true;
  ws.winStart = now();
  ws.winCount = 0;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', raw => {
    // ── 속도 제한 — 한 명이 서버를 독차지하지 못하게 ──
    const t = now();
    if (t - ws.winStart > RATE_WIN) { ws.winStart = t; ws.winCount = 0; }
    if (++ws.winCount > RATE_MSGS) return;      // 조용히 버린다

    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    // ── 첫 메시지는 반드시 입장 ──
    if (!ws.room) {
      if (msg.t !== 'join') return;
      const room = String(msg.room || '').toLowerCase();
      if (!ROOM_RE.test(room)) { send(ws, { t: 'denied', why: '방 코드는 영문·숫자 1~12자입니다' }); return; }

      let peers = rooms.get(room);
      if (!peers) {
        if (rooms.size >= MAX_ROOMS) { send(ws, { t: 'denied', why: '서버가 가득 찼습니다' }); return; }
        peers = new Map();
        rooms.set(room, peers);
        log('방 생성', room);
      }
      if (peers.size >= MAX_PEERS) { send(ws, { t: 'denied', why: '방이 가득 찼습니다 (' + MAX_PEERS + '명)' }); return; }

      ws.id   = 'p' + (++seq).toString(36);
      ws.room = room;
      ws.ch   = Number(msg.ch) || 0;
      ws.name = String(msg.name || '').slice(0, 16) || ws.id;

      // 나에게: 내 id + 이미 있던 사람들
      send(ws, { t: 'welcome', id: ws.id, room });
      for (const [id, other] of peers) {
        send(ws, { t: 'hello', id, ch: other.ch, name: other.name });
      }
      // 남들에게: 새로 온 사람
      relay(room, { t: 'hello', id: ws.id, ch: ws.ch, name: ws.name });

      peers.set(ws.id, ws);
      log('입장', room, ws.id, ws.name, '· 인원', peers.size);
      return;
    }

    if (msg.t === 'join') return;                       // 두 번 입장은 무시

    // ── 신원 위조 차단 ──
    // 보낸 사람을 서버가 알고 있으니, 클라이언트가 주장하는 값은 덮어쓴다.
    // 이것 하나만으로 "남인 척하기"는 막힌다.
    if ('id'   in msg) msg.id   = ws.id;
    if ('from' in msg) msg.from = ws.id;
    if (msg.t === 'hit' && typeof msg.dmg === 'number') {
      msg.dmg = Math.max(0, Math.min(DMG_CAP, msg.dmg));
    }
    if (msg.t === 'hello') { ws.ch = Number(msg.ch) || ws.ch; }

    // ── 전달 ──
    // 받는 사람이 정해진 메시지는 그 사람에게만 (hit·st 등)
    const peers = rooms.get(ws.room);
    if (typeof msg.to === 'string') {
      const target = peers && peers.get(msg.to);
      if (target) send(target, msg);
      return;
    }
    relay(ws.room, msg, ws.id);
  });

  const bye = () => { if (ws.room) leave(ws); };
  ws.on('close', bye);
  ws.on('error', bye);
});

// ── 죽은 연결 청소 ──
const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);
wss.on('close', () => clearInterval(beat));

server.listen(PORT, () => {
  log('중계 서버 시작 — 포트 ' + PORT);
  log('게임 열기:  http://localhost:' + PORT);
  log('서버 주소:  ws://localhost:' + PORT + '  (같은 주소로 열면 자동으로 잡힙니다)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log('종료 중…'); server.close(() => process.exit(0)); });
}
