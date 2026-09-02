@echo off
chcp 65001 >nul
title ANIMAL CLASH - 인터넷 공개
setlocal

set "CF=%USERPROFILE%\cloudflared\cloudflared.exe"
if not exist "%CF%" (
  echo.
  echo  [!] cloudflared 를 찾을 수 없습니다.
  echo      %CF%
  echo.
  echo      PowerShell 에서 아래를 실행해 설치하세요:
  echo      winget install --id Cloudflare.cloudflared --source winget
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0server"
if not exist node_modules (
  echo 처음 실행이라 의존성을 설치합니다...
  call npm install
)

rem 중계 서버를 별도 창으로 띄운다
start "ANIMAL CLASH 서버" cmd /k node server.js

rem 서버가 뜰 때까지 잠깐 기다린다
timeout /t 3 /nobreak >nul

echo.
echo  ================================================
echo   아래에 나오는 https://... 주소를 친구에게 보내세요
echo   이 창을 닫으면 접속이 끊깁니다
echo  ================================================
echo.

"%CF%" tunnel --url http://localhost:3000
pause
