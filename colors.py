import json
import os

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "src", "palette.json")

with open(_PATH, encoding="utf-8") as f:
    PALETTE = json.load(f)

STATION_COLOR = PALETTE["station"]
UNASSIGNED_COLOR = PALETTE["unassigned"]
VARIABLE_COLORS = PALETTE.get("variables") or {}


def variable_color(name: str) -> str:
    key = str(name or "").strip().lower()
    if key in VARIABLE_COLORS:
        return VARIABLE_COLORS[key]
    if "temperature" in key and "temperature" in VARIABLE_COLORS:
        return VARIABLE_COLORS["temperature"]
    if "salinity" in key and "practical salinity" in VARIABLE_COLORS:
        return VARIABLE_COLORS["practical salinity"]
    return STATION_COLOR
