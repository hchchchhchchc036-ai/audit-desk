@echo off
cd /d "%~dp0"
if exist "release\0.1.10\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.10\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.9\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.9\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.8\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.8\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.7\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.7\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.6\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.6\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.5\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.5\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.4\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.4\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.3\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.3\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\0.1.2\win-unpacked\Audit Desk.exe" (
  start "" "release\0.1.2\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\updated\win-unpacked\Audit Desk.exe" (
  start "" "release\updated\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if exist "release\win-unpacked\Audit Desk.exe" (
  start "" "release\win-unpacked\Audit Desk.exe"
  exit /b 0
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Please run npm.cmd install first.
  pause
  exit /b 1
)
call npm.cmd run start
if errorlevel 1 pause
