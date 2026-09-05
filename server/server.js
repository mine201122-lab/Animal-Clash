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
const DUEL_RE    = /^duel[a-z0-9]+$/;   // 서버가 만든 1대1 방

const CODE_RE    = /^[A-Za-z0-9가-힣_]{1,12}#[0-9A-F]{4}$/;   // 친구 코드: 이름#A1B2

const rooms  = new Map();      // 방 코드 -> Map(id -> ws)
const online = new Map();      // 친구 코드 -> ws   (게임 밖에서도 유지되는 접속)
const queue  = [];             // 1대1 매칭 대기줄 (먼저 온 순서)
let seq = 0;
let matchSeq = 0;

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
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers, online: online.size, queue: queue.length, uptime: Math.round(process.uptime()) }));
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

// 방장 — 가장 먼저 들어온 사람. 캐릭터 선택을 시작시킬 권한만 갖는다.
// Map 은 넣은 순서를 지키므로 첫 항목이 곧 최고참이다.
function hostOf(peers) {
  for (const id of peers.keys()) return id;
  return null;
}

function leave(ws) {
  const peers = rooms.get(ws.room);
  if (!peers) return;
  const wasHost = hostOf(peers) === ws.id;
  peers.delete(ws.id);
  relay(ws.room, { t: 'bye', id: ws.id });
  if (peers.size === 0) {
    rooms.delete(ws.room);
    stopGame(ws.room);
    log('방 삭제', ws.room);
    return;
  }
  // 사람이 빠지면 남은 사람만으로 라운드를 이어 판정한다
  onDeath(ws.room, ws.id);
  log('퇴장', ws.room, ws.id, '남은 인원', peers.size);
  // 방장이 나가면 다음 최고참에게 넘긴다. 안 그러면 아무도 시작을 못 시킨다.
  if (wasHost) {
    const next = hostOf(peers);
    relay(ws.room, { t: 'host', id: next });
    log('방장 위임', ws.room, '→', next);
  }
}

// ── 라운드 진행 ─────────────────────────────────
// 누가 이겼는지, 다음 라운드를 언제 여는지는 서버가 정한다.
// 방장 클라이언트에게 맡겼더니 누가 먼저 들어왔느냐에 따라 판이 멈췄다.
const ROUNDS   = 3;      // 총 라운드 수
const WIN_NEED = 2;      // 먼저 이 수만큼 이기면 끝 (3판 2선승)
const NEXT_MS  = 5000;   // 라운드 사이 간격

const games = new Map(); // 방 코드 -> { round, scores:{id:승수}, alive:Set, timer, over }

function startMatch(room) {
  const peers = rooms.get(room);
  if (!peers || peers.size < 2) return;
  const scores = {};
  for (const id of peers.keys()) scores[id] = 0;
  games.set(room, { round: 0, scores, alive: new Set(), timer: null, over: false });
  nextRound(room);
}

function nextRound(room) {
  const g = games.get(room), peers = rooms.get(room);
  if (!g || !peers) return;
  clearTimeout(g.timer); g.timer = null;
  g.round++;
  g.alive = new Set(peers.keys());
  for (const id of peers.keys()) if (!(id in g.scores)) g.scores[id] = 0;
  relay(room, { t: 'round', n: g.round, of: ROUNDS, scores: g.scores });
  log('라운드 시작', room, g.round + '/' + ROUNDS);
}

// 한 명이 쓰러졌다 — 남은 사람이 하나뿐이면 라운드가 끝난다
function onDeath(room, id) {
  const g = games.get(room);
  if (!g || g.over) return;
  g.alive.delete(id);
  if (g.alive.size > 1) return;

  const winner = g.alive.size === 1 ? [...g.alive][0] : null;   // 동시에 죽으면 무승부
  if (winner) g.scores[winner] = (g.scores[winner] || 0) + 1;

  const best = Math.max(0, ...Object.values(g.scores));
  const done = best >= WIN_NEED || g.round >= ROUNDS;

  relay(room, {
    t: 'roundEnd', n: g.round, of: ROUNDS, winner, scores: g.scores,
    last: done, next: done ? 0 : NEXT_MS,
  });
  log('라운드 종료', room, g.round, '승자', winner || '무승부', JSON.stringify(g.scores));

  if (done) {
    g.over = true;
    // 최다 승자(동률이면 여럿)
    const top = Object.keys(g.scores).filter(k => g.scores[k] === best && best > 0);
    relay(room, { t: 'matchEnd', scores: g.scores, winners: top });
    log('경기 종료', room, '우승', top.join(',') || '없음');
    games.delete(room);
  } else {
    g.timer = setTimeout(() => nextRound(room), NEXT_MS);
  }
}

function stopGame(room) {
  const g = games.get(room);
  if (!g) return;
  clearTimeout(g.timer);
  games.delete(room);
}

// ── 친구·매칭 ───────────────────────────────────
// 친구 목록이 성립하려면 접속을 끊어도 유지되는 신원이 필요하다.
// 그래서 클라이언트가 만든 고정 코드(이름#A1B2)를 접속마다 등록한다.
// 서버는 그 코드를 저장하지 않는다 — 지금 누가 붙어 있는지만 안다.
function stateOf(ws) { return ws && ws.room ? 'ingame' : (ws ? 'online' : 'offline'); }

// 친구 목록에 나를 담아 둔 사람들에게 내 상태 변화를 알린다
function notifyWatchers(code) {
  if (!code) return;
  const st = stateOf(online.get(code));
  for (const other of online.values()) {
    if (other.watch && other.watch.has(code)) send(other, { t: 'presence1', code, state: st });
  }
}

function dequeue(ws) {
  const i = queue.indexOf(ws);
  if (i >= 0) { queue.splice(i, 1); return true; }
  return false;
}

// 대기줄에 둘 이상 모이면 짝지어 방을 내준다
function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift(), b = queue.shift();
    if (a.readyState !== a.OPEN) { if (b.readyState === b.OPEN) queue.unshift(b); continue; }
    if (b.readyState !== b.OPEN) { queue.unshift(a); continue; }
    const room = 'duel' + (++matchSeq).toString(36) + Math.floor(Math.random() * 1296).toString(36);
    send(a, { t: 'match', room, mode: 'duel', opponent: { code: b.code, name: b.pname } });
    send(b, { t: 'match', room, mode: 'duel', opponent: { code: a.code, name: a.pname } });
    log('매칭 성사', room, a.code, 'vs', b.code);
  }
  for (const w of queue) send(w, { t: 'queued', n: queue.length });
}

// 게임 밖에서 오가는 메시지 (방에 들어가기 전에도 쓴다)
// 처리했으면 true 를 돌려준다.
function handleLobby(ws, msg) {
  switch (msg.t) {
    case 'auth': {
      const code = String(msg.code || '');
      if (!CODE_RE.test(code)) { send(ws, { t: 'denied', why: '친구 코드 형식이 아닙니다' }); return true; }
      const old = online.get(code);
      if (old && old !== ws) { try { old.close(); } catch (_) {} }   // 같은 코드는 한 접속만
      ws.code  = code;
      ws.pname = String(msg.name || '').slice(0, 16) || code.split('#')[0];
      ws.watch = ws.watch || new Set();
      online.set(code, ws);
      send(ws, { t: 'authed', code });
      notifyWatchers(code);
      log('로그인', code, ws.pname, '· 접속자', online.size);
      return true;
    }
    case 'watch': {                       // 친구 목록의 상태를 구독한다
      if (!ws.code) return true;
      ws.watch = new Set((Array.isArray(msg.codes) ? msg.codes : []).slice(0, 100).map(String));
      const list = {};
      for (const c of ws.watch) list[c] = stateOf(online.get(c));
      send(ws, { t: 'presence', list });
      return true;
    }
    case 'invite': {                      // 친구에게 1대1 초대
      if (!ws.code) return true;
      const target = online.get(String(msg.to || ''));
      if (!target) { send(ws, { t: 'inviteFail', to: msg.to, why: '접속해 있지 않습니다' }); return true; }
      send(target, { t: 'invited', from: ws.code, name: ws.pname });
      send(ws, { t: 'inviteSent', to: msg.to });
      log('초대', ws.code, '→', msg.to);
      return true;
    }
    case 'inviteNo': {                    // 거절
      const target = online.get(String(msg.to || ''));
      if (target) send(target, { t: 'inviteNo', from: ws.code });
      return true;
    }
    case 'accept': {                      // 초대 수락 → 둘만의 방을 만든다
      if (!ws.code) return true;
      const target = online.get(String(msg.to || ''));
      if (!target) { send(ws, { t: 'inviteFail', to: msg.to, why: '상대가 나갔습니다' }); return true; }
      dequeue(ws); dequeue(target);
      const room = 'duel' + (++matchSeq).toString(36) + Math.floor(Math.random() * 1296).toString(36);
      send(ws,     { t: 'match', room, mode: 'duel', opponent: { code: target.code, name: target.pname } });
      send(target, { t: 'match', room, mode: 'duel', opponent: { code: ws.code, name: ws.pname } });
      log('친구전 성사', room, ws.code, 'vs', target.code);
      return true;
    }
    case 'queue': {
      if (!ws.code) { send(ws, { t: 'denied', why: '먼저 이름을 정해 주세요' }); return true; }
      if (!queue.includes(ws)) queue.push(ws);
      send(ws, { t: 'queued', n: queue.length });
      tryMatch();
      return true;
    }
    case 'unqueue': {
      dequeue(ws);
      send(ws, { t: 'unqueued' });
      tryMatch();
      return true;
    }
    case 'leaveRoom': {                   // 방에서만 빠지고 접속은 유지한다
      if (ws.room) leave(ws);
      ws.room = null; ws.id = null;
      send(ws, { t: 'leftRoom' });
      notifyWatchers(ws.code);
      return true;
    }
  }
  return false;
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

    // 친구·매칭 메시지는 방 밖에서도 오간다
    if (handleLobby(ws, msg)) return;

    // ── 방에 들어가기 ──
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

      // 나에게: 내 id + 이미 있던 사람들. 방이 비어 있었으면 내가 방장이다.
      // 방장이 누구인지도 알려 준다 — 명단에 표시해야 누구를 기다리는지 안다.
      const hostId = peers.size === 0 ? ws.id : hostOf(peers);
      send(ws, { t: 'welcome', id: ws.id, room, host: hostId === ws.id, hostId });
      for (const [id, other] of peers) {
        send(ws, { t: 'hello', id, ch: other.ch, name: other.name });
      }
      // 남들에게: 새로 온 사람
      relay(room, { t: 'hello', id: ws.id, ch: ws.ch, name: ws.name });

      peers.set(ws.id, ws);
      log('입장', room, ws.id, ws.name, '· 인원', peers.size);
      dequeue(ws);                 // 방에 들어갔으면 대기줄에서 뺀다
      notifyWatchers(ws.code);     // 친구들에게 "게임 중"으로 보인다

      // 1대1 방은 둘이 모이는 즉시 서버가 시작시킨다.
      // 방장에게 맡기면 누가 먼저 들어왔느냐에 따라 아무도 시작을 못 한다.
      if (DUEL_RE.test(room) && peers.size === 2) {
        for (const p of peers.values()) p.ready = false;
        relay(room, { t: 'start', dur: 60 });
        log('1대1 시작', room);
      }
      return;
    }

    if (msg.t === 'join') return;                       // 두 번 입장은 무시

    // ── 신원 위조 차단 ──
    // 보낸 사람을 서버가 알고 있으니, 클라이언트가 주장하는 값은 덮어쓴다.
    // 이것 하나만으로 "남인 척하기"는 막힌다.
    // 있을 때만 덮어쓰면 안 된다 — id 를 안 실어 보낸 메시지는 받는 쪽에서
    // 누가 보냈는지 알 수 없게 된다(pick·ready 가 그랬다). 항상 붙인다.
    msg.id = ws.id;
    if ('from' in msg) msg.from = ws.id;

    // 판을 시작시키는 권한은 방장에게만 있다.
    // 아무나 보내면 남이 캐릭터를 고르는 중에 판이 넘어간다.
    const peers0 = rooms.get(ws.room);
    if ((msg.t === 'start' || msg.t === 'go') && hostOf(peers0) !== ws.id) {
      log('거절: 방장이 아닌', ws.id, '가', msg.t, '시도');
      return;
    }
    if (msg.t === 'hit' && typeof msg.dmg === 'number') {
      msg.dmg = Math.max(0, Math.min(DMG_CAP, msg.dmg));
    }
    if (msg.t === 'hello') { ws.ch = Number(msg.ch) || ws.ch; }

    // 입장(go)은 서버가 정한다 — 전원이 캐릭터를 확정했을 때.
    // 방장 클라이언트에게 맡기면 누가 먼저 들어왔느냐에 좌우된다.
    if (msg.t === 'ready') {
      ws.ready = true;
      const ps = rooms.get(ws.room);
      if (ps && ps.size >= 2 && [...ps.values()].every(p => p.ready)) {
        relay(ws.room, msg);                  // 준비 표시는 먼저 보여 주고
        for (const p of ps.values()) p.ready = false;
        relay(ws.room, { t: 'go' });
        log('전원 입장', ws.room);
        startMatch(ws.room);                  // 1라운드 시작
        return;
      }
    }

    // 사망은 라운드 판정으로 이어진다
    if (msg.t === 'died') {
      relay(ws.room, msg, ws.id);
      onDeath(ws.room, ws.id);
      return;
    }

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

  const bye = () => {
    if (ws.room) leave(ws);
    dequeue(ws);
    if (ws.code && online.get(ws.code) === ws){
      online.delete(ws.code);
      ws.room = null;
      notifyWatchers(ws.code);     // 친구 목록에서 "오프라인"으로 바뀐다
      log('로그아웃', ws.code, '· 접속자', online.size);
    }
  };
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
