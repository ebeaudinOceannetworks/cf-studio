#!/bin/bash
cd "$(dirname "$0")"

VENV_DIR=".venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
    source "$VENV_DIR/bin/activate"
    pip install --upgrade pip
    pip install -r requirements.txt
else
    source "$VENV_DIR/bin/activate"
    pip install -r requirements.txt
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to build the dashboard. Install Node.js from https://nodejs.org"
    exit 1
fi

echo "Building frontend..."
cd frontend
if [ ! -d node_modules ]; then
    npm install
fi
npm run build
cd ..

echo "Starting Community Fishers Plot Studio..."
(sleep 2 && open "http://127.0.0.1:8000") &
python -m uvicorn api:app --host 127.0.0.1 --port 8000
