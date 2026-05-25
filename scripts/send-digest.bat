@echo off
cd /d "C:\Users\Knight\.claude\skills\follow-builders\scripts"

echo [%date% %time%] Starting digest >> "%TEMP%\fb-digest-log.txt"

REM Step 1: Generate digest with AI (retry up to 3 times on failure)
set RETRIES=0
:generate
node format-digest.js > "%TEMP%\fb-digest-email.txt" 2>>"%TEMP%\fb-digest-log.txt"
if %ERRORLEVEL% EQU 0 goto :send

set /a RETRIES=%RETRIES%+1
if %RETRIES% LSS 3 (
  echo [%date% %time%] Generation failed, retry %RETRIES%/3 >> "%TEMP%\fb-digest-log.txt"
  timeout /t 10 /nobreak >nul
  goto :generate
)
echo [%date% %time%] Generation failed after 3 retries >> "%TEMP%\fb-digest-log.txt"
exit /b 1

REM Step 2: Send email (retry up to 3 times on failure)
:send
set RETRIES=0
:deliver
echo [%date% %time%] Sending email... >> "%TEMP%\fb-digest-log.txt"
node deliver.js --file "%TEMP%\fb-digest-email.txt" >>"%TEMP%\fb-digest-log.txt" 2>&1

REM Check if deliver.js reported success
type "%TEMP%\fb-digest-log.txt" | findstr /C:"\"status\":\"ok\"" >nul
if %ERRORLEVEL% EQU 0 goto :done

set /a RETRIES=%RETRIES%+1
if %RETRIES% LSS 3 (
  echo [%date% %time%] Delivery failed, retry %RETRIES%/3 >> "%TEMP%\fb-digest-log.txt"
  timeout /t 30 /nobreak >nul
  goto :deliver
)
echo [%date% %time%] Delivery failed after 3 retries >> "%TEMP%\fb-digest-log.txt"
exit /b 1

:done
echo [%date% %time%] Done >> "%TEMP%\fb-digest-log.txt"
