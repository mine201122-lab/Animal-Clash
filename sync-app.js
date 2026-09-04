'use strict';
// 이미 만들어진 dist/win-unpacked 안의 게임 파일만 갈아 끼운다.
//
// 왜 필요한가: electron-builder 는 빌드 전에 코드서명 도구 압축을 푸는데,
// 그 안에 macOS 심볼릭 링크가 들어 있어 윈도우 개발자 모드가 꺼져 있으면 실패한다.
// 실패하면 파일 복사까지 가지도 못해, 코드를 고쳐도 앱에는 반영되지 않는다.
// 게임 코드만 바뀐 경우라면 통째로 다시 빌드할 이유가 없다 — 그 파일들만 덮어쓴다.
//
// 처음 한 번은 `npm run build:dir` 로 win-unpacked 를 만들어 둬야 한다.

const fs = require('fs');
const path = require('path');

// dist/ 안에서 resources/app 을 가진 폴더를 모두 찾아 전부 갈아 끼운다.
// 한 곳만 갱신하면 사용자가 다른 폴더의 exe 를 실행했을 때 옛 코드가 돌아간다.
// 실제로 그 일이 있었다 — 고친 줄 알았는데 옛 빌드를 실행하고 있었다.
const DIST = path.join(__dirname, 'dist');
function appDirs(){
  if (!fs.existsSync(DIST)) return [];
  return fs.readdirSync(DIST)
    .map(d => path.join(DIST, d, 'resources', 'app'))
    .filter(d => fs.existsSync(d));
}
const FILES = [
  'index.html',
  'three.min.js',
  'GLTFLoader.js',
  'electron-main.js',
  ['server/server.js', 'server'],
];

const APPS = appDirs();
if (!APPS.length) {
  console.error('dist 안에 앱 폴더가 없습니다. 먼저 npm run build:dir 를 실행하세요.');
  process.exit(1);
}

let n = 0;
for (const APP of APPS) {
  console.log('→ ' + path.relative(__dirname, APP));
  for (const item of FILES) {
    const rel = Array.isArray(item) ? item[0] : item;
    const sub = Array.isArray(item) ? item[1] : '';
    const src = path.join(__dirname, rel);
    if (!fs.existsSync(src)) { console.log('   건너뜀 (없음):', rel); continue; }
    const dstDir = sub ? path.join(APP, sub) : APP;
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, path.join(dstDir, path.basename(rel)));
    console.log('   갱신:', rel);
    n++;
  }
}
console.log('완료 — 앱 ' + APPS.length + '곳에 파일 ' + n + '개를 반영했습니다.');
