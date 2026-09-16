import io
import os
import threading
from typing import List, Optional

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import xarray as xr
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import data
import plotting
import transect_dijkstra as bathy
from attributions import data_attributions
from colors import STATION_COLOR, UNASSIGNED_COLOR, variable_color

app = FastAPI(title="Community Fishers Plot Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT = os.path.dirname(os.path.abspath(__file__))
FOLDER_FILE = os.path.join(ROOT, "data_folder.txt")
FALLBACK_DATA_DIR = os.path.normpath(os.path.join(ROOT, "..", "data-test"))
FRONTEND_DIST = os.path.join(ROOT, "frontend", "dist")

PLOT_TYPES = [
    "Overview (Selected vs Depth)",
    "Transect (Filled Contour)",
    "Transect (Pixel Mesh)",
    "Timeseries at Station",
    "Depth Profile (Mean + 1 Std)",
    "T-S Diagram",
    "Seasonal Profiles",
    "Sampling Days Timeline",
    "Sampling History",
    "Data Distribution",
]

ds_all = None
catalog = []
catalog_vars = []
file_cache = {}
data_lock = threading.Lock()


def read_saved_folder() -> str:
    try:
        with open(FOLDER_FILE, encoding="utf-8") as f:
            path = f.read().strip()
        if path:
            return os.path.expanduser(path)
    except OSError:
        pass
    return FALLBACK_DATA_DIR


def write_saved_folder(path: str) -> str:
    path = os.path.abspath(os.path.expanduser(path.strip()))
    with open(FOLDER_FILE, "w", encoding="utf-8") as f:
        f.write(path + "\n")
    return path


current_folder = read_saved_folder()


def load_data_from_path(path_dir: str):
    global ds_all, catalog, catalog_vars, file_cache, current_folder
    indexed, variables = data.index_folder(path_dir)
    with data_lock:
        catalog = indexed
        catalog_vars = variables
        file_cache = {}
        ds_all = None
        current_folder = path_dir
    bathy.invalidate_coverages()
    return len({e["path"] for e in indexed})


def files_for_selection(selected_ids):
    return data.files_for_selection(catalog, selected_ids)


def ensure_selection(selected_ids):
    global ds_all
    paths = files_for_selection(selected_ids)
    with data_lock:
        if not paths:
            ds_all = None
            return None
        for path in paths:
            if path in file_cache:
                continue
            try:
                file_cache[path] = data.parse_cor(path)
            except Exception as err:
                print(f"Skipped {os.path.basename(path)}: {err}")
        ds_list = [file_cache[p] for p in paths if p in file_cache]
        if not ds_list:
            ds_all = None
            return None
        if len(ds_list) == 1:
            ds_all = ds_list[0]
        else:
            ds_all = xr.concat(ds_list, dim="cast", join="outer").sortby("depth")
        return ds_all


try:
    load_data_from_path(current_folder)
except Exception as e:
    print(f"Startup warning: {e}")


class FolderRequest(BaseModel):
    folder_path: str


class PlotStyle(BaseModel):
    selected_ids: List[str] = []
    variable: str = "Temperature"
    secondary_variable: Optional[str] = "None"
    plot_type: str = "Transect (Filled Contour)"
    date_filter: str = "All"
    nation_filter: str = "All"
    title: Optional[str] = None
    xlabel: Optional[str] = None
    ylabel: Optional[str] = None
    colorbar_label: Optional[str] = None
    depth_min: Optional[float] = 0
    depth_max: Optional[float] = None
    vmin: Optional[float] = None
    vmax: Optional[float] = None
    colormap: Optional[str] = None
    color_by: Optional[str] = "Season"
    num_contour_lines: int = 15
    num_density_lines: int = 5
    overlay_color: str = "black"
    overlay_labels: bool = True
    add_bathymetry: bool = True
    bathymetry_style: str = "filled"
    num_std: float = 1
    marker_size: float = 8
    line_width: float = 2.5
    paper: str = "light"
    show_attribution: bool = False
    attribution_position: str = "footer"
    attribution_fontsize: float = 8
    fontsize: float = 11
    fig_width: float = 10
    fig_height: float = 6
    dpi: int = 300
    format: str = "png"


def build_attribution_string(community_name, station_code=None):
    attr_info = None
    for k, v in data_attributions.items():
        if k == community_name or community_name in k:
            attr_info = v
            break
        if station_code and "code" in v:
            codes = v["code"] if isinstance(v["code"], list) else [v["code"]]
            if any(c in station_code for c in codes):
                attr_info = v
                break

    if attr_info:
        c_attr = f" ({attr_info['community_attr']})" if attr_info.get("community_attr") else ""
        onc_attr = f" ({attr_info['onc_attr']})" if attr_info.get("onc_attr") else ""
        return f"Data Attribution: {community_name}{c_attr}, Ocean Networks Canada Society{onc_attr}"
    return f"Data Attribution: {community_name}, Ocean Networks Canada Society"


def community_for_selection(selected_ids):
    if not selected_ids:
        return "Ocean Networks Canada Society"
    wanted = set(selected_ids)
    for entry in catalog:
        if entry["station_name"] in wanted or entry["cast_id"] in wanted:
            community = entry.get("community")
            if community and community != "Unknown":
                return community
    return "Ocean Networks Canada Society"


def clean_list(arr):
    arr = np.asarray(arr, dtype=float)
    if arr.ndim == 1:
        return [None if not np.isfinite(x) else float(x) for x in arr]
    return [[None if not np.isfinite(x) else float(x) for x in row] for row in arr]


def style_dict(req: PlotStyle, attribution_text: str):
    return {
        "date_filter": req.date_filter,
        "title": req.title,
        "xlabel": req.xlabel,
        "ylabel": req.ylabel,
        "colorbar_label": req.colorbar_label,
        "depth_min": req.depth_min,
        "depth_max": req.depth_max,
        "vmin": req.vmin,
        "vmax": req.vmax,
        "colormap": req.colormap,
        "color_by": req.color_by,
        "secondary_variable": req.secondary_variable,
        "num_contour_lines": req.num_contour_lines,
        "num_density_lines": req.num_density_lines,
        "overlay_color": req.overlay_color,
        "overlay_labels": req.overlay_labels,
        "add_bathymetry": req.add_bathymetry,
        "bathymetry_style": req.bathymetry_style,
        "num_std": req.num_std,
        "marker_size": req.marker_size,
        "line_width": req.line_width,
        "paper": req.paper,
        "show_attribution": req.show_attribution,
        "attribution_position": req.attribution_position,
        "attribution_fontsize": req.attribution_fontsize,
        "fontsize": req.fontsize,
        "fig_width": req.fig_width,
        "fig_height": req.fig_height,
        "attribution": attribution_text,
    }


@app.post("/api/load_folder")
def set_folder(req: FolderRequest):
    try:
        count = load_data_from_path(req.folder_path)
        return {"status": "success", "file_count": count, "folder_path": current_folder}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class DrawTransectRequest(BaseModel):
    stations: List[List[float]]
    tif_file: Optional[str] = None


@app.post("/api/draw-transect")
def draw_transect_path(req: DrawTransectRequest):
    stations = []
    for pair in req.stations or []:
        if not pair or len(pair) < 2:
            continue
        stations.append((float(pair[0]), float(pair[1])))
    if len(stations) < 2:
        raise HTTPException(status_code=400, detail="Transect needs at least 2 stations.")
    try:
        return bathy.draw_transect(stations, tif_file=req.tif_file, data_folder=current_folder)
    except Exception as e:
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/remember_folder")
def remember_folder(req: FolderRequest):
    path = os.path.abspath(os.path.expanduser((req.folder_path or "").strip()))
    if not path:
        raise HTTPException(status_code=400, detail="Folder path is empty")
    if not os.path.isdir(path):
        raise HTTPException(status_code=400, detail=f"Folder does not exist: {path}")
    saved = write_saved_folder(path)
    return {"status": "success", "folder_path": saved}


@app.get("/api/summary")
def get_summary():
    if not catalog:
        return {
            "total_casts": 0,
            "stations": [],
            "available_dates": [],
            "variables": [],
            "plot_types": PLOT_TYPES,
            "nations": [],
            "palette": {"station": STATION_COLOR, "unassigned": UNASSIGNED_COLOR},
            "default_folder": current_folder,
            "bathy_coverages": bathy.list_coverages(current_folder),
            "bathy_skipped": bathy.list_skipped(current_folder),
            "max_bathy_mb": int(bathy.MAX_BATHY_MB),
        }

    unique_markers, date_counts = {}, {}
    unassigned_n = 0
    total_valid_casts = 0
    all_nations = set()
    detected_vars = list(catalog_vars)

    for entry in catalog:
        try:
            lat = float(entry["lat"])
            lon = float(entry["lon"])
        except Exception:
            continue
        if np.isnan(lat) or np.isnan(lon):
            continue

        total_valid_casts += 1
        st_name = entry["station_name"]
        c_type = entry["cast_type"]
        community = entry.get("community") or "Unknown"
        cast_name = entry.get("cast_name") or ""
        if community != "Unknown":
            all_nations.add(community)

        this_date = entry.get("date") or "Unknown"
        if this_date != "Unknown":
            date_counts[this_date] = date_counts.get(this_date, 0) + 1

        if c_type == "station" and st_name not in ("nan", "Unassigned Cast Data"):
            marker_key = st_name
            color = STATION_COLOR
            kind = "station"
            short_label = st_name
            cast_number = None
            label = st_name
        else:
            marker_key = entry["cast_id"]
            color = UNASSIGNED_COLOR
            kind = "unassigned"
            unassigned_n += 1
            cast_number = unassigned_n
            date_bit = f" ({this_date})" if this_date and this_date != "Unknown" else ""
            if cast_name and cast_name not in ("nan", "Unassigned Cast Data"):
                name = cast_name
            else:
                name = f"CAST-{cast_number}"
            short_label = f"{name}{date_bit}"
            label = short_label

        if marker_key not in unique_markers:
            unique_markers[marker_key] = {
                "id": marker_key,
                "label": label,
                "short_label": short_label,
                "kind": kind,
                "cast_number": cast_number,
                "preview_date": this_date if this_date != "Unknown" else "",
                "lat": lat,
                "lon": lon,
                "color": color,
                "community": community,
                "dates": [this_date] if this_date != "Unknown" else [],
                "cast_dates": [this_date] if this_date != "Unknown" else [],
                "time_points": [],
            }
        else:
            if this_date != "Unknown":
                unique_markers[marker_key]["cast_dates"].append(this_date)
                if this_date not in unique_markers[marker_key]["dates"]:
                    unique_markers[marker_key]["dates"].append(this_date)

    for marker in unique_markers.values():
        points = []
        for d in marker["dates"]:
            try:
                dt = pd.to_datetime(d)
                points.append({"date": d, "month": int(dt.month), "year": int(dt.year)})
            except Exception:
                pass
        marker["time_points"] = points
        if marker["dates"]:
            marker["preview_date"] = max(marker["dates"])

    formatted_dates = [{"date": d, "label": f"{d} ({date_counts[d]} casts)"} for d in sorted(date_counts.keys())]

    return {
        "total_casts": total_valid_casts,
        "stations": list(unique_markers.values()),
        "available_dates": formatted_dates,
        "variables": sorted(detected_vars),
        "plot_types": PLOT_TYPES,
        "nations": sorted(list(all_nations)),
        "palette": {"station": STATION_COLOR, "unassigned": UNASSIGNED_COLOR},
        "default_folder": current_folder,
        "bathy_coverages": bathy.list_coverages(current_folder),
        "bathy_skipped": bathy.list_skipped(current_folder),
        "max_bathy_mb": int(bathy.MAX_BATHY_MB),
    }


def plot_transect_payload(req: PlotStyle, attribution_text: str):
    date_filter = data.resolve_transect_date(ds_all, req.selected_ids, req.variable, req.date_filter)
    selected_casts = data.match_casts(ds_all, req.selected_ids, date_filter)
    if len(selected_casts) < 2:
        return {"error": f"Transect requires at least 2 casts on date: {date_filter}. Found {len(selected_casts)}."}

    deepest = data.deepest_cast_per_station(ds_all, selected_casts, req.variable)
    if len(deepest) < 2:
        return {"error": "Transect needs at least 2 selected stations."}
    data_transect = ds_all.sel(cast=deepest).transpose("depth", "cast")
    lats = np.ravel(data_transect.lat.values)
    lons = np.ravel(data_transect.lon.values)
    stations = list(zip(lats.tolist(), lons.tolist()))
    bathy_info = bathy.draw_transect(stations, data_folder=current_folder)
    if bathy_info.get("used_mask") and bathy_info.get("station_distances"):
        cast_dist = np.asarray(bathy_info["station_distances"], dtype=float)
    else:
        cast_dist = data.transect_distances(lats, lons)

    z_primary = clean_list(data_transect[req.variable].values)
    z_secondary = None
    if req.secondary_variable and req.secondary_variable != "None" and req.secondary_variable in data_transect:
        z_secondary = clean_list(data_transect[req.secondary_variable].values)

    depths = data_transect.depth.values
    lo, hi = data.valid_depth_extent(ds_all, deepest, req.variable, req.depth_min, req.depth_max)
    mask = (depths >= lo) & (depths <= hi)
    depths = depths[mask]
    z_primary = [row for row, keep in zip(z_primary, mask) if keep]
    if z_secondary:
        z_secondary = [row for row, keep in zip(z_secondary, mask) if keep]

    clim_min, clim_max = data.resolve_clim(req.variable, req.vmin, req.vmax)
    bathy_depth = bathy_info.get("bathy_depth") or []
    finite_bathy = [v for v in bathy_depth if v is not None]
    if finite_bathy:
        hi = max(float(hi), float(np.nanmax(finite_bathy)))
    return {
        "plot_type": "transect",
        "x_dist": cast_dist.tolist(),
        "y_depth": depths.tolist(),
        "z_primary": z_primary,
        "z_secondary": z_secondary,
        "primary_var": req.variable,
        "secondary_var": req.secondary_variable,
        "stations": [data.as_str(s) for s in data_transect.station_name.values],
        "cast_types": [data.as_str(t) for t in data_transect.cast_type.values],
        "units_primary": data.get_units(req.variable),
        "units_secondary": data.get_units(req.secondary_variable or ""),
        "colorscale": data.get_plotly_colorscale(req.variable, req.colormap),
        "depth_min": lo,
        "depth_max": hi,
        "vmin": clim_min,
        "vmax": clim_max,
        "date": date_filter,
        "title": f"Transect: {date_filter} ({req.variable})",
        "attribution": attribution_text,
        "used_mask": bool(bathy_info.get("used_mask")),
        "bathy_dist": bathy_info.get("bathy_dist"),
        "bathy_depth": bathy_info.get("bathy_depth"),
        "bathy_name": bathy_info.get("name"),
    }


def _iso_time(val):
    t = pd.to_datetime(data.as_scalar(val), errors="coerce")
    if pd.isna(t):
        return None
    return pd.Timestamp(t).isoformat()


def plot_timeseries_payload(req: PlotStyle, attribution_text: str):
    station_ids = list(req.selected_ids[-1:]) if req.selected_ids else []
    matching = data.match_casts(ds_all, station_ids, "All")
    ordered = data.casts_by_time(ds_all, matching, req.variable)
    if len(ordered) < 2:
        return {"error": "Timeseries needs at least 2 casts at the selected station."}
    if req.variable not in ds_all:
        return {"error": f"Variable '{req.variable}' not available."}

    data_ts = ds_all.sel(cast=ordered).transpose("depth", "cast")
    z_primary = clean_list(data_ts[req.variable].values)
    z_secondary = None
    if req.secondary_variable and req.secondary_variable != "None" and req.secondary_variable in data_ts:
        z_secondary = clean_list(data_ts[req.secondary_variable].values)

    depths = data_ts.depth.values
    lo, hi = data.valid_depth_extent(ds_all, ordered, req.variable, req.depth_min, req.depth_max)
    mask = (depths >= lo) & (depths <= hi)
    depths = depths[mask]
    z_primary = [row for row, keep in zip(z_primary, mask) if keep]
    if z_secondary:
        z_secondary = [row for row, keep in zip(z_secondary, mask) if keep]

    times = [_iso_time(t) for t in data_ts.time.values]
    names = data.unique_station_labels(ds_all, ordered)
    title = names[0] if len(names) == 1 else (", ".join(names) if names else "Selected casts")
    clim_min, clim_max = data.resolve_clim(req.variable, req.vmin, req.vmax)
    return {
        "plot_type": "timeseries",
        "x_time": times,
        "y_depth": depths.tolist(),
        "z_primary": z_primary,
        "z_secondary": z_secondary,
        "primary_var": req.variable,
        "secondary_var": req.secondary_variable,
        "stations": [data.as_str(s) for s in data_ts.station_name.values],
        "cast_types": [data.as_str(t) for t in data_ts.cast_type.values],
        "title": title,
        "units_primary": data.get_units(req.variable),
        "units_secondary": data.get_units(req.secondary_variable or ""),
        "colorscale": data.get_plotly_colorscale(req.variable, req.colormap),
        "depth_min": lo,
        "depth_max": hi,
        "vmin": clim_min,
        "vmax": clim_max,
        "attribution": attribution_text,
    }


def plot_history_payload(req: PlotStyle, attribution_text: str):
    matching = data.match_casts(ds_all, req.selected_ids, req.date_filter)
    if not matching:
        return {"error": "No casts available for sampling history."}

    rows = {}
    unassigned = []
    for c in matching:
        cast_ds = ds_all.sel(cast=c)
        t = _iso_time(cast_ds.time.values)
        if t is None:
            continue
        if data.is_station_cast(cast_ds):
            name = data.as_str(cast_ds.station_name.values)
            rows.setdefault(name, []).append(t)
        else:
            unassigned.append(t)

    labels = sorted(rows)
    series = [{"name": name, "times": rows[name], "kind": "station"} for name in labels]
    if unassigned:
        series.append({"name": "Unassigned", "times": unassigned, "kind": "unassigned"})
    if not series:
        return {"error": "No casts available for sampling history."}
    return {
        "plot_type": "history",
        "series": series,
        "n_casts": len(matching),
        "station_color": STATION_COLOR,
        "unassigned_color": UNASSIGNED_COLOR,
        "attribution": attribution_text,
    }


def plot_overview_payload(req: PlotStyle, attribution_text: str):
    if not req.selected_ids:
        return {"error": "No casts to display."}
    matching = data.match_casts(ds_all, req.selected_ids, req.date_filter)
    if not matching:
        return {"error": "No casts to display."}

    latest_c, _latest_t = plotting.latest_cast_id(ds_all, matching)
    traces = []
    for c in matching:
        c_ds = ds_all.sel(cast=c)
        if req.variable not in c_ds:
            continue
        depths = np.ravel(c_ds.depth.values)
        vals = np.ravel(c_ds[req.variable].values)
        mask = ~np.isnan(vals) & ~np.isnan(depths)
        if np.sum(mask) < 2:
            continue
        day = data.cast_date(c_ds)
        traces.append({
            "cast": str(c),
            "date": day,
            "x": vals[mask].tolist(),
            "y": depths[mask].tolist(),
            "latest": c == latest_c,
        })

    latest_date = data.cast_date(ds_all.sel(cast=latest_c)) if latest_c is not None else None
    if latest_date == "Unknown":
        latest_date = None
    lo, hi = data.valid_depth_extent(ds_all, matching, req.variable, req.depth_min, req.depth_max)
    return {
        "plot_type": "overview",
        "traces": traces,
        "latest_date": latest_date,
        "depth_min": lo,
        "depth_max": hi,
        "variable": req.variable,
        "units": data.get_units(req.variable),
        "color": variable_color(req.variable),
        "attribution": attribution_text,
    }


def plot_profile_payload(req: PlotStyle, attribution_text: str):
    matching = data.match_casts(ds_all, req.selected_ids, req.date_filter)
    if not matching:
        return {"error": f"No casts found for date: {req.date_filter}"}

    lo, max_d = data.valid_depth_extent(ds_all, matching, req.variable, req.depth_min, req.depth_max)
    common_depths = np.linspace(lo, max_d, 100)
    profile_matrix = []
    cast_traces = []

    for c in matching:
        c_ds = ds_all.sel(cast=c)
        if req.variable not in c_ds:
            continue
        depths = np.ravel(c_ds.depth.values)
        vals = np.ravel(c_ds[req.variable].values)
        mask = ~np.isnan(vals) & ~np.isnan(depths)
        if np.sum(mask) > 1:
            cast_traces.append({"cast": str(c), "x": vals[mask].tolist(), "y": depths[mask].tolist()})
            interp_vals = np.interp(common_depths, depths[mask], vals[mask], left=np.nan, right=np.nan)
            profile_matrix.append(interp_vals)

    mean_vals, std_vals = [], []
    if profile_matrix:
        p_arr = np.array(profile_matrix)
        mean_vals = clean_list(np.nanmean(p_arr, axis=0))
        std_vals = clean_list(np.nanstd(p_arr, axis=0))

    return {
        "plot_type": "profile",
        "common_depths": common_depths.tolist(),
        "mean_vals": mean_vals,
        "std_vals": std_vals,
        "num_std": req.num_std,
        "traces": cast_traces,
        "depth_min": lo,
        "depth_max": max_d,
        "variable": req.variable,
        "units": data.get_units(req.variable),
        "attribution": attribution_text,
    }


def plot_ts_payload(req: PlotStyle, attribution_text: str):
    matching = data.match_casts(ds_all, req.selected_ids, req.date_filter)
    if not matching:
        return {"error": "No casts selected for T–S diagram."}
    ds_sub = ds_all.sel(cast=matching)
    if "Practical Salinity" not in ds_sub or "Temperature" not in ds_sub:
        return {"error": "T–S diagram needs Practical Salinity and Temperature."}

    color_by = req.color_by or "Season"
    sal_da = ds_sub["Practical Salinity"]
    temp_da = ds_sub["Temperature"]

    if color_by == "Season":
        s, t, season = xr.broadcast(sal_da, temp_da, ds_sub.time.dt.season)
        mask = np.isfinite(s.values) & np.isfinite(t.values)
        return {
            "plot_type": "ts",
            "color_mode": "season",
            "salinity": s.values[mask].tolist(),
            "temperature": t.values[mask].tolist(),
            "season": [str(x) for x in season.values[mask]],
            "attribution": attribution_text,
        }

    if color_by.lower() == "depth":
        s, t, z = xr.broadcast(sal_da, temp_da, ds_sub.depth)
        mask = np.isfinite(s.values) & np.isfinite(t.values)
        return {
            "plot_type": "ts",
            "color_mode": "depth",
            "salinity": s.values[mask].tolist(),
            "temperature": t.values[mask].tolist(),
            "color": clean_list(z.values[mask]),
            "colorscale": "Jet",
            "colorbar_title": "Depth (m)",
            "attribution": attribution_text,
        }

    if color_by not in ds_sub:
        return {"error": f"Variable '{color_by}' is not available for T–S coloring."}

    s, t, c = xr.broadcast(sal_da, temp_da, ds_sub[color_by])
    mask = np.isfinite(s.values) & np.isfinite(t.values) & np.isfinite(c.values)
    clim_min, clim_max = data.resolve_clim(color_by, req.vmin, req.vmax)
    return {
        "plot_type": "ts",
        "color_mode": "variable",
        "salinity": s.values[mask].tolist(),
        "temperature": t.values[mask].tolist(),
        "color": clean_list(c.values[mask]),
        "colorscale": data.get_plotly_colorscale(color_by, req.colormap),
        "vmin": clim_min,
        "vmax": clim_max,
        "colorbar_title": f"{color_by} ({data.get_units(color_by)})",
        "attribution": attribution_text,
    }


def plot_seasonal_payload(req: PlotStyle, attribution_text: str):
    matching = data.match_casts(ds_all, req.selected_ids, req.date_filter)
    if not matching:
        return {"error": "No casts selected for seasonal profiles."}
    ds_sub = ds_all.sel(cast=matching)
    if req.variable not in ds_sub:
        return {"error": f"Variable '{req.variable}' not available."}

    seasons = [
        ("DJF", "Winter", "rgb(51, 102, 230)"),
        ("MAM", "Spring", "rgb(77, 179, 77)"),
        ("JJA", "Summer", "rgb(230, 77, 77)"),
        ("SON", "Fall", "rgb(242, 153, 51)"),
    ]
    series = []
    for code, name, color in seasons:
        valid = ds_sub.where(ds_sub.time.dt.season == code, drop=True)[req.variable]
        if valid.cast.size == 0:
            continue
        mean = np.ravel(valid.mean(dim="cast").values)
        std = np.ravel(valid.std(dim="cast", ddof=0).values)
        depths = np.ravel(valid.depth.values)
        series.append(
            {
                "name": f"{name} ({code})",
                "color": color,
                "mean": clean_list(mean),
                "std": clean_list(std),
                "depth": clean_list(depths),
            }
        )
    lo, hi = data.valid_depth_extent(ds_all, matching, req.variable, req.depth_min, req.depth_max)
    return {
        "plot_type": "seasonal",
        "series": series,
        "variable": req.variable,
        "units": data.get_units(req.variable),
        "depth_min": lo,
        "depth_max": hi,
        "attribution": attribution_text,
    }


def plot_sampling_payload(req: PlotStyle, attribution_text: str):
    wanted = set(req.selected_ids or [])
    counts = {}
    for entry in catalog:
        if wanted and entry["station_name"] not in wanted and entry["cast_id"] not in wanted:
            continue
        day = entry.get("date") or "Unknown"
        if not data.date_matches(day, req.date_filter) or day == "Unknown":
            continue
        bucket = counts.setdefault(day, [0, 0])
        if entry["cast_type"] == "station" and entry["station_name"] not in ("nan", "Unassigned Cast Data", ""):
            bucket[0] += 1
        else:
            bucket[1] += 1
    if not counts:
        return {"error": "No casts available for sampling timeline."}
    dates = sorted(counts)
    return {
        "plot_type": "sampling",
        "dates": dates,
        "station_counts": [counts[d][0] for d in dates],
        "unassigned_counts": [counts[d][1] for d in dates],
        "station_color": STATION_COLOR,
        "unassigned_color": UNASSIGNED_COLOR,
        "attribution": attribution_text,
    }


def plot_distribution_payload(req: PlotStyle, attribution_text: str):
    if ds_all is None:
        return {"error": "Select stations to load profiles."}
    matching = data.match_casts(ds_all, req.selected_ids, req.date_filter) if req.selected_ids else list(ds_all.cast.values)
    if not matching:
        return {"error": "No casts available for data distribution."}
    ds_sub = ds_all.sel(cast=matching)
    excluded = {"lat", "lon", "depth", "time", "cast", "station_name", "cast_type", "community"}
    panels = []
    for var in list(ds_sub.data_vars.keys()):
        if var in excluded:
            continue
        vals = np.ravel(ds_sub[var].values)
        valid = vals[np.isfinite(vals)]
        units = data.get_units(var)
        panels.append({
            "variable": var,
            "units": units,
            "xlabel": f"{var} ({units})" if units else var,
            "values": valid.tolist() if valid.size else [],
            "color": variable_color(var),
        })
        if len(panels) >= 9:
            break
    return {"plot_type": "distribution", "panels": panels, "attribution": attribution_text}


@app.post("/api/plot_data")
def get_plot_data(req: PlotStyle):
    if not catalog:
        raise HTTPException(status_code=400, detail="No data loaded.")

    try:
        kind = req.plot_type
        if "Sampling Days" not in kind:
            loaded = ensure_selection(req.selected_ids)
            if loaded is None:
                if not req.selected_ids:
                    return {"error": "Select stations to load profiles."}
                return {"error": "Could not load profiles for the selected stations."}
        attribution_text = build_attribution_string(community_for_selection(req.selected_ids))
        if "Overview" in kind:
            return plot_overview_payload(req, attribution_text)
        if "Transect" in kind:
            return plot_transect_payload(req, attribution_text)
        if "Timeseries" in kind or "Time Series" in kind:
            return plot_timeseries_payload(req, attribution_text)
        if "Profile" in kind and "Season" not in kind:
            return plot_profile_payload(req, attribution_text)
        if "T-S" in kind or "T–S" in kind:
            return plot_ts_payload(req, attribution_text)
        if "Season" in kind:
            return plot_seasonal_payload(req, attribution_text)
        if "History" in kind:
            return plot_history_payload(req, attribution_text)
        if "Sampling" in kind:
            return plot_sampling_payload(req, attribution_text)
        if "Distribution" in kind:
            return plot_distribution_payload(req, attribution_text)
        return {"error": "Unsupported plot type"}
    except Exception as e:
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/export")
def export_plot(req: PlotStyle):
    if not catalog:
        raise HTTPException(status_code=400, detail="No data loaded.")
    if "Sampling Days" not in (req.plot_type or ""):
        if ensure_selection(req.selected_ids) is None:
            raise HTTPException(status_code=400, detail="Select stations to load profiles.")

    fmt = (req.format or "png").lower()
    if fmt not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="Format must be png, svg, or pdf.")

    try:
        attribution_text = build_attribution_string(community_for_selection(req.selected_ids))
        style = style_dict(req, attribution_text)
        fig = plotting.render_plot(ds_all, req.plot_type, req.selected_ids, req.variable, style)
        buf = io.BytesIO()
        fig.savefig(buf, format=fmt, dpi=int(req.dpi or 300), facecolor=fig.get_facecolor())
        plt.close(fig)
        buf.seek(0)
        media = {"png": "image/png", "svg": "image/svg+xml", "pdf": "application/pdf"}[fmt]
        return Response(
            content=buf.read(),
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="cf-plot.{fmt}"'},
        )
    except Exception as e:
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


if os.path.isdir(FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
else:

    @app.get("/")
    def root_status():
        return {"status": "ok", "message": "API running. Build frontend/dist to serve the UI."}
