import json
import os

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "src", "palette.json")

with open(_PATH, encoding="utf-8") as f:
    PALETTE = json.load(f)

STATION_COLOR = PALETTE["station"]
UNASSIGNED_COLOR = PALETTE["unassigned"]
