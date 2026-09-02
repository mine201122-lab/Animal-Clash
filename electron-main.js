'use strict';
// ANIMAL CLASH 데스크톱 앱
//
// 브라우저에서 겪던 제약이 여기서는 없다.
//   · 마우스 잠금이 거부되지 않는다 (data: 문서도, iframe 도 아니다)
//   · 전체화면이 ESC 한 번에 풀리지 않는다 (창을 우리가 만든다)
//   · 주소창·탭이 없어 게임 화면만 남는다
//
// 게임 코드(index.html)는 그대로 쓴다. 여기서 고치는 건 껍데기뿐이다.

const { app, BrowserWindow, Menu, globalShortcut, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let win = null;
let relay = null;          // 내 컴퓨터에서 돌리는 중계 서버 (선택)
let relayPort = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0d12',
    show: false,
    autoHideMenuBar: true,
    title: 'ANIMAL CLASH',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,          // 게임 코드에 Node 를 열어 줄 이유가 없다
      backgroundThrottling: false,     // 창이 뒤로 가도 프레임을 죽이지 않는다
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));

  // 게임 안에서 여는 바깥 링크는 기본 브라우저로 보낸다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

// ── 중계 서버를 앱 안에서 띄운다 ──
// 친구를 내 컴퓨터로 부르고 싶을 때 쓴다. 밖에서 접속하려면 여전히 터널이나 VPS 가 필요하다.
function startRelay(port) {
  if (relay) return;
  const script = path.join(__dirname, 'server', 'server.js');
  relay = fork(script, [], { env: { ...process.env, PORT: String(port) }, silent: true });
  relayPort = port;
  relay.on('exit', () => { relay = null; relayPort = 0; buildMenu(); });
  if (relay.stdout) relay.stdout.on('data', d => process.stdout.write('[relay] ' + d));
  if (relay.stderr) relay.stderr.on('data', d => process.stderr.write('[relay] ' + d));
  buildMenu();
}
function stopRelay() {
  if (!relay) return;
  relay.kill();
  relay = null; relayPort = 0;
  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: '게임',
      submenu: [
        { label: '전체화면', accelerator: 'F11',
          click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { label: '새로 고침', accelerator: 'F5', click: () => win && win.reload() },
        { type: 'separator' },
        { label: '끝내기', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '멀티플레이',
      submenu: [
        relay
          ? { label: '내 서버 끄기 (포트 ' + relayPort + ')', click: stopRelay }
          : { label: '내 컴퓨터에서 서버 열기', click: () => startRelay(3000) },
        { type: 'separator' },
        {
          label: '서버 주소 안내',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: '중계 서버 주소',
            message: '친구와 하려면 서버 주소가 필요합니다',
            detail:
              '같은 집(공유기) 안이라면\n' +
              '  · 내 컴퓨터에서 서버를 열고\n' +
              '  · 친구는 설정 → 고급 → 중계 서버 주소에 ws://<내 IP>:3000 입력\n\n' +
              '밖에 있는 친구와 하려면 터널이나 VPS 가 필요합니다.\n' +
              '터널 실행.bat 을 켜면 나오는 https 주소를\n' +
              '설정 → 고급 → 중계 서버 주소에 붙여넣으면 됩니다.',
          }),
        },
      ],
    },
    {
      label: '도움말',
      submenu: [
        { label: '개발자 도구', accelerator: 'F12',
          click: () => win && win.webContents.toggleDevTools() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 한 번에 하나만 돈다 (두 번 켜면 서버 포트가 겹친다)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    // F11 은 메뉴에도 있지만 전체화면 중에는 메뉴가 안 보이므로 전역으로도 잡는다
    globalShortcut.register('F11', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
  });

  app.on('window-all-closed', () => { stopRelay(); app.quit(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopRelay(); });
}
