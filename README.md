# Community Fishers Plot Studio

Local app for Community Fishers CTD casts: load a folder of `.cor` files, pick stations on a map, filter by local sampling day, inspect figures, and export PNG, SVG, or PDF.

## Requirements

- Python 3.11+
- Node.js (npm) to build the dashboard

## Launch

**Mac:** double-click `launch_mac.command` (or run it from Terminal).

**Windows:** double-click `launch_windows.bat`.

The script creates `.venv` if needed, installs Python deps, builds `frontend/`, and starts the API at [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Use

1. Enter a folder that contains `.cor` files and click **Load folder**.
2. **Remember path** writes that folder to `data_folder.txt` (local only; not committed) so the next start opens it again.
3. **Explore** is the map and sampling calendar. Click a station; Shift-click to add more.
4. **Studio** is an interactive Plotly figure (hover, zoom, pan). **Customize** edits title, size, and style on that same figure.
5. **Save figure** downloads the Plotly figure as you see it (PNG, SVG, or PDF).

## Develop

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd frontend && npm install && npm run dev
```

In another terminal, from the repo root:

```bash
source .venv/bin/activate
python -m uvicorn api:app --host 127.0.0.1 --port 8000
```

Vite (`http://127.0.0.1:5173`) proxies `/api` to port 8000.
