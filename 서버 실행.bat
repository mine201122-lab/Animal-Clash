@echo off
rem 중계 서버를 띄우고 브라우저로 게임을 연다 (멀티플레이용)
cd /d "%~dp0server"
if not exist node_modules (
  echo 처음 실행이라 의존성을 설치합니다...
  call npm install
)
start "" http://localhost:3000
node server.js
pause
