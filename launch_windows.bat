@echo off
cd /d "%~dp0"
SET VENV_DIR=.venv

IF NOT EXIST %VENV_DIR% (
    echo Creating Python virtual environment...
    python -m venv %VENV_DIR%
    call %VENV_DIR%\Scripts\activate
    python -m pip install --upgrade pip
    pip install -r requirements.txt
) ELSE (
    call %VENV_DIR%\Scripts\activate
    pip install -r requirements.txt
)

where npm >nul 2>nul
IF ERRORLEVEL 1 (
    echo npm is required to build the dashboard. Install Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo Building frontend...
cd frontend
IF NOT EXIST node_modules (
    call npm install
)
call npm run build
cd ..

echo Starting Community Fishers Plot Studio...
start "" http://127.0.0.1:8000
python -m uvicorn api:app --host 127.0.0.1 --port 8000
pause
