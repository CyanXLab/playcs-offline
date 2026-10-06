@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   PLAYCS.CC 离线版
echo ============================================
echo.
where py >nul 2>nul
if %errorlevel%==0 (
    py playcs_server.py
    goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
    python playcs_server.py
    goto :end
)
echo [错误] 未找到 Python。请先安装 Python 3: https://www.python.org/downloads/
echo 安装时勾选 "Add Python to PATH"。
pause
:end
pause
