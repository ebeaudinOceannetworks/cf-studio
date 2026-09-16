"""Windowed 10 m bathymetry pathfinding for studio transects.

The GeoTIFF is never loaded whole. A padded lon/lat window is clipped,
reprojected to WGS84, coarsened by 3, and cached as (coarse_mask, graph_A).
"""

from __future__ import annotations

import io
import math
import os
import threading
from typing import Optional

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
import rioxarray as rxr
import xarray as xr
from rasterio.crs import CRS
from rasterio.warp import transform as transform_xy
from rasterio.warp import transform_bounds
from scipy.ndimage import distance_transform_edt
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

WGS84 = CRS.from_epsg(4326)
COARSEN = 3
PAD_DEG = 0.08
QUANTIZE_DEG = 0.05
MAX_COARSE_CELLS = 1_800_000
SHORELINE_COST = "spicy"
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "bathy_cache")
BATHY_FOLDER_FILE = os.path.join(ROOT, "bathymetry_folder.txt")
RASTER_EXTS = {".tif", ".tiff", ".TIF", ".TIFF"}
MAX_BATHY_BYTES = 100 * 1024 * 1024
MAX_BATHY_MB = MAX_BATHY_BYTES / (1024 * 1024)

_mem_cache: dict = {}
_cache_lock = threading.Lock()
_catalog_lock = threading.Lock()
_coverage_catalog = None
_coverage_skipped = None


def read_bathy_folder() -> Optional[str]:
    try:
        with open(BATHY_FOLDER_FILE, encoding="utf-8") as f:
            path = f.read().strip()
        if path:
            return os.path.expanduser(path)
    except OSError:
        pass
    return None


def write_bathy_folder(path: str) -> str:
    path = os.path.abspath(os.path.expanduser(path.strip()))
    with open(BATHY_FOLDER_FILE, "w", encoding="utf-8") as f:
        f.write(path + "\n")
    return path


def bathy_search_dirs(data_folder: Optional[str] = None) -> list:
    dirs = []
    saved = read_bathy_folder()
    if saved:
        dirs.append(saved)
    dirs.append(os.path.join(ROOT, "bathymetry"))
    if data_folder:
        dirs.append(os.path.join(data_folder, "bathymetry"))
    seen = set()
    out = []
    for d in dirs:
        d = os.path.abspath(os.path.expanduser(d))
        if d in seen or not os.path.isdir(d):
            continue
        seen.add(d)
        out.append(d)
    return out


def _iter_rasters(data_folder: Optional[str] = None):
    dirs = list(bathy_search_dirs(data_folder))
    if data_folder:
        data_folder = os.path.abspath(os.path.expanduser(data_folder))
        if os.path.isdir(data_folder) and data_folder not in dirs:
            dirs.append(data_folder)
    seen = set()
    for folder in dirs:
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for name in names:
            ext = os.path.splitext(name)[1]
            if ext not in RASTER_EXTS:
                continue
            path = os.path.join(folder, name)
            if path in seen:
                continue
            seen.add(path)
            yield path


def _file_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def raster_too_large(path: str) -> bool:
    return _file_size(path) > MAX_BATHY_BYTES


def _size_mb(nbytes: int) -> float:
    return round(nbytes / (1024 * 1024), 1)


def _wgs84_bounds(path: str):
    with rasterio.open(path) as src:
        west, south, east, north = src.bounds
        if _needs_reproject(src.crs):
            west, south, east, north = transform_bounds(src.crs, WGS84, west, south, east, north, densify_pts=21)
        return float(south), float(west), float(north), float(east)


def list_coverages(data_folder: Optional[str] = None, refresh: bool = False) -> list:
    items, _skipped = _scan_coverages(data_folder, refresh=refresh)
    return items


def list_skipped(data_folder: Optional[str] = None, refresh: bool = False) -> list:
    _items, skipped = _scan_coverages(data_folder, refresh=refresh)
    return skipped


def _scan_coverages(data_folder: Optional[str] = None, refresh: bool = False):
    global _coverage_catalog, _coverage_skipped
    with _catalog_lock:
        if _coverage_catalog is not None and _coverage_skipped is not None and not refresh:
            return _coverage_catalog, _coverage_skipped
        catalog = []
        skipped = []
        for path in _iter_rasters(data_folder):
            nbytes = _file_size(path)
            if nbytes > MAX_BATHY_BYTES:
                skipped.append({
                    "name": os.path.basename(path),
                    "size_mb": _size_mb(nbytes),
                    "max_mb": int(MAX_BATHY_MB),
                    "reason": f"{_size_mb(nbytes)} MB exceeds the {int(MAX_BATHY_MB)} MB bathymetry limit",
                })
                print(f"Skipped bathymetry {os.path.basename(path)}: {skipped[-1]['reason']}")
                continue
            try:
                south, west, north, east = _wgs84_bounds(path)
            except Exception as err:
                print(f"Skipped bathymetry {os.path.basename(path)}: {err}")
                continue
            catalog.append({
                "name": os.path.basename(path),
                "path": path,
                "south": south,
                "west": west,
                "north": north,
                "east": east,
                "bounds": [[south, west], [north, east]],
                "size_mb": _size_mb(nbytes),
            })
        _coverage_catalog = catalog
        _coverage_skipped = skipped
        return catalog, skipped


def invalidate_coverages():
    global _coverage_catalog, _coverage_skipped
    with _catalog_lock:
        _coverage_catalog = None
        _coverage_skipped = None


def resolve_tif(tif_file: Optional[str], data_folder: Optional[str] = None) -> Optional[str]:
    if tif_file:
        path = os.path.abspath(os.path.expanduser(str(tif_file).strip()))
        if os.path.isfile(path) and os.path.splitext(path)[1] in RASTER_EXTS:
            if raster_too_large(path):
                return None
            return path
        want = os.path.basename(str(tif_file).strip())
        for item in list_coverages(data_folder):
            if item["name"] == want:
                return item["path"]
        return None
    return None


def covering_raster(stations, tif_file: Optional[str] = None, data_folder: Optional[str] = None) -> Optional[dict]:
    if tif_file:
        path = resolve_tif(tif_file, data_folder)
        if path:
            for item in list_coverages(data_folder):
                if item["path"] == path:
                    return item
            try:
                south, west, north, east = _wgs84_bounds(path)
            except Exception:
                return None
            return {
                "name": os.path.basename(path),
                "path": path,
                "south": south,
                "west": west,
                "north": north,
                "east": east,
                "bounds": [[south, west], [north, east]],
            }
        return None

    lats = [float(p[0]) for p in stations]
    lons = [float(p[1]) for p in stations]
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)
    matches = []
    for item in list_coverages(data_folder):
        if (
            lat_min >= item["south"]
            and lat_max <= item["north"]
            and lon_min >= item["west"]
            and lon_max <= item["east"]
        ):
            area = (item["north"] - item["south"]) * (item["east"] - item["west"])
            matches.append((area, item))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0])
    return matches[0][1]


def haversine(lon1, lat1, lon2, lat2):
    r = 6371.0
    lon1, lat1, lon2, lat2 = map(np.radians, [lon1, lat1, lon2, lat2])
    a = np.sin((lat2 - lat1) / 2.0) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2.0) ** 2
    return float(r * 2 * np.arcsin(np.sqrt(a)))


def _ocean_from_values(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    finite = np.isfinite(arr) & (np.abs(arr) < 1.0e6)
    pos = (arr > 0.05) & finite
    neg = (arr < -0.05) & finite
    n_pos = int(np.count_nonzero(pos))
    n_neg = int(np.count_nonzero(neg))
    # Mixed signs are elevation models (ocean negative, land positive).
    if n_neg and n_pos:
        return neg
    if n_neg > n_pos:
        return neg
    return pos


def _needs_reproject(crs) -> bool:
    if crs is None:
        return False
    try:
        return crs.to_epsg() != 4326
    except Exception:
        return True


def get_landmask_from_tif(tif_path, lonmin, lonmax, latmin, latmax):
    da = rxr.open_rasterio(tif_path, masked=True).squeeze()
    src_crs = da.rio.crs
    if _needs_reproject(src_crs):
        minx, miny, maxx, maxy = transform_bounds(WGS84, src_crs, lonmin, latmin, lonmax, latmax, densify_pts=21)
    else:
        minx, miny, maxx, maxy = lonmin, latmin, lonmax, latmax
    clipped = da.rio.clip_box(minx=minx, miny=miny, maxx=maxx, maxy=maxy, auto_expand=True)
    if _needs_reproject(clipped.rio.crs):
        clipped = clipped.rio.reproject("EPSG:4326")
    clipped = clipped.sortby("x").sortby("y")
    subset = clipped.sel(x=slice(lonmin, lonmax), y=slice(latmin, latmax))
    if subset.size == 0:
        raise ValueError("Bathymetry window is empty for this transect.")
    ocean = _ocean_from_values(subset.values)
    landmask = (~ocean).astype(np.int8)
    return xr.DataArray(
        landmask,
        dims=["y", "x"],
        coords={"x": np.asarray(subset.x.values), "y": np.asarray(subset.y.values)},
    )


def build_ocean_graph_weighted(mask, alpha=10, sigma=3, shoreline_cost="mild"):
    mask_bool = np.asarray(mask).astype(bool)
    ny, nx = mask_bool.shape
    dist_to_land = distance_transform_edt(mask_bool)
    if shoreline_cost == "mild":
        weights = 1 + alpha * np.exp(-(dist_to_land ** 2) / (2 * sigma ** 2))
    elif shoreline_cost == "medium":
        weights = 1 + alpha / (dist_to_land + 1)
    else:
        weights = 1 + alpha / (dist_to_land + 1) ** 2

    def neighbor_edges(di, dj, scale):
        m1 = mask_bool[max(0, -di) : ny - max(0, di), max(0, -dj) : nx - max(0, dj)]
        m2 = mask_bool[max(0, di) : ny - max(0, -di), max(0, dj) : nx - max(0, -dj)]
        both = m1 & m2
        i, j = np.nonzero(both)
        i1 = i + max(0, -di)
        j1 = j + max(0, -dj)
        i2 = i + max(0, di)
        j2 = j + max(0, dj)
        n1 = i1 * nx + j1
        n2 = i2 * nx + j2
        cost = scale * 0.5 * (weights[i1, j1] + weights[i2, j2])
        return n1, n2, cost

    parts = [
        neighbor_edges(0, 1, 1.0),
        neighbor_edges(1, 0, 1.0),
        neighbor_edges(1, 1, math.sqrt(2)),
        neighbor_edges(1, -1, math.sqrt(2)),
    ]
    n1 = np.concatenate([p[0] for p in parts])
    n2 = np.concatenate([p[1] for p in parts])
    cost = np.concatenate([p[2] for p in parts])
    rows = np.concatenate([n1, n2])
    cols = np.concatenate([n2, n1])
    data = np.concatenate([cost, cost])
    return coo_matrix((data, (rows, cols)), shape=(ny * nx, ny * nx)).tocsr()


def latlon_to_ij(lats, lons, lat, lon):
    i = int(np.abs(np.asarray(lats) - lat).argmin())
    j = int(np.abs(np.asarray(lons) - lon).argmin())
    return i, j


def _snap_ocean(ocean, i, j):
    ny, nx = ocean.shape
    i = min(max(int(i), 0), ny - 1)
    j = min(max(int(j), 0), nx - 1)
    if ocean[i, j]:
        return i, j
    inds = distance_transform_edt(~ocean, return_distances=False, return_indices=True)
    return int(inds[0, i, j]), int(inds[1, i, j])


def shortest_path_ij(A, nx, start, end):
    start_idx = start[0] * nx + start[1]
    end_idx = end[0] * nx + end[1]
    dist, pred = dijkstra(A, directed=True, indices=start_idx, return_predecessors=True)
    pred = np.asarray(pred, dtype=np.int64)
    if not np.isfinite(dist[end_idx]) or pred[end_idx] == -9999:
        return None
    path_nodes = []
    cur = int(end_idx)
    seen = set()
    while cur != -9999:
        if cur in seen or cur < 0:
            return None
        seen.add(cur)
        path_nodes.append(cur)
        if cur == start_idx:
            break
        cur = int(pred[cur])
    else:
        return None
    path_nodes.reverse()
    return [(n // nx, n % nx) for n in path_nodes]


def shortest_path_latlon(A, lat1, lon1, lat2, lon2, mask, plot_path=False):
    ocean = np.asarray(mask.values if hasattr(mask, "values") else mask)
    if ocean.dtype != bool:
        ocean = ocean == 0
    lats = np.asarray(mask.y.values if hasattr(mask, "y") else mask.coords["y"])
    lons = np.asarray(mask.x.values if hasattr(mask, "x") else mask.coords["x"])
    i1, j1 = _snap_ocean(ocean, *latlon_to_ij(lats, lons, lat1, lon1))
    i2, j2 = _snap_ocean(ocean, *latlon_to_ij(lats, lons, lat2, lon2))
    path = shortest_path_ij(A, len(lons), (i1, j1), (i2, j2))
    if plot_path:
        fig, ax = plt.subplots(figsize=(6, 8))
        ax.contourf(lons, lats, ocean.astype(float), origin="lower", cmap="Blues", alpha=0.5)
        if path:
            ax.plot([lons[j] for i, j in path], [lats[i] for i, j in path], "-o", color="b", markersize=3)
        ax.scatter([lon1, lon2], [lat1, lat2], c=["limegreen", "yellow"], edgecolors="k", marker="*", s=200, zorder=10)
        ax.set_xlabel("Longitude")
        ax.set_ylabel("Latitude")
        plt.close(fig)
    return path


def _quantize_bbox(lonmin, latmin, lonmax, latmax):
    pad = PAD_DEG
    step = QUANTIZE_DEG
    lonmin = math.floor((lonmin - pad) / step) * step
    latmin = math.floor((latmin - pad) / step) * step
    lonmax = math.ceil((lonmax + pad) / step) * step
    latmax = math.ceil((latmax + pad) / step) * step
    return lonmin, latmin, lonmax, latmax


def _cache_path(tif_path, lonmin, latmin, lonmax, latmax) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    stem = os.path.splitext(os.path.basename(tif_path))[0]
    key = f"{lonmin:.2f}_{latmin:.2f}_{lonmax:.2f}_{latmax:.2f}".replace("-", "m")
    return os.path.join(CACHE_DIR, f"cache_{stem}_{key}.joblib")


def _coarsen_landmask(mask: xr.DataArray, factor: int = COARSEN) -> xr.DataArray:
    ny, nx = mask.shape
    if ny < factor or nx < factor:
        return mask
    extra_y = ny % factor
    extra_x = nx % factor
    if extra_y or extra_x:
        y_stop = ny - extra_y if extra_y else ny
        x_stop = nx - extra_x if extra_x else nx
        mask = mask.isel(y=slice(0, y_stop), x=slice(0, x_stop))
    return mask.coarsen(x=factor, y=factor, boundary="trim").min()


def get_cached_graph(tif_path, lonmin, lonmax, latmin, latmax, coarsen: int = COARSEN):
    if raster_too_large(tif_path):
        raise ValueError(
            f"{os.path.basename(tif_path)} is larger than {int(MAX_BATHY_MB)} MB. "
            "Clip a regional GeoTIFF (Prince Rupert is ~35 MB) and try again."
        )
    lonmin, latmin, lonmax, latmax = _quantize_bbox(lonmin, latmin, lonmax, latmax)
    cache_file = _cache_path(tif_path, lonmin, latmin, lonmax, latmax)
    with _cache_lock:
        packed = _mem_cache.get(cache_file)
        if packed is None and os.path.isfile(cache_file):
            packed = joblib.load(cache_file)
            _mem_cache[cache_file] = packed
        if packed is not None:
            coarse_mask = xr.DataArray(
                packed["landmask"],
                dims=["y", "x"],
                coords={"x": packed["x"], "y": packed["y"]},
            )
            return coarse_mask, packed["graph_A"], True

        landmask = get_landmask_from_tif(tif_path, lonmin, lonmax, latmin, latmax)
        coarse_mask = _coarsen_landmask(landmask, coarsen)
        if coarse_mask.size > MAX_COARSE_CELLS:
            raise ValueError("Transect window is too large for 10 m pathfinding.")
        ocean = np.asarray(coarse_mask.values) == 0
        graph_A = build_ocean_graph_weighted(ocean, shoreline_cost=SHORELINE_COST)
        packed = {
            "landmask": np.asarray(coarse_mask.values),
            "x": np.asarray(coarse_mask.x.values),
            "y": np.asarray(coarse_mask.y.values),
            "graph_A": graph_A,
        }
        joblib.dump(packed, cache_file)
        _mem_cache[cache_file] = packed
        return coarse_mask, graph_A, False


def _sample_seabed(tif_path, lons, lats) -> np.ndarray:
    with rasterio.open(tif_path) as src:
        if _needs_reproject(src.crs):
            xs, ys = transform_xy(WGS84, src.crs, lons, lats)
            pts = list(zip(xs, ys))
        else:
            pts = list(zip(lons, lats))
        vals = np.array([v[0] for v in src.sample(pts)], dtype=float)
        nodata = src.nodata
        if nodata is not None:
            vals = np.where(vals == nodata, np.nan, vals)
    return np.abs(vals)


def calculate_transect_data(stations, coarse_mask, graph_A, tif_path):
    combined_path = []
    station_indices = [0]
    for i in range(len(stations) - 1):
        lat1, lon1 = stations[i]
        lat2, lon2 = stations[i + 1]
        segment = shortest_path_latlon(graph_A, lat1, lon1, lat2, lon2, coarse_mask)
        if not segment:
            return None
        if i > 0:
            segment = segment[1:]
        combined_path.extend(segment)
        station_indices.append(len(combined_path) - 1)

    path_lats = [float(coarse_mask.y[r].item()) for r, c in combined_path]
    path_lons = [float(coarse_mask.x[c].item()) for r, c in combined_path]
    seabed_values = _sample_seabed(tif_path, path_lons, path_lats)
    distances = [0.0]
    for k in range(1, len(path_lats)):
        distances.append(distances[-1] + haversine(path_lons[k - 1], path_lats[k - 1], path_lons[k], path_lats[k]))
    return (
        np.asarray(distances, dtype=float),
        np.asarray(seabed_values, dtype=float),
        station_indices,
        path_lats,
        path_lons,
    )


def _decimate_path(lats, lons, max_pts=1800):
    n = len(lats)
    if n <= max_pts:
        return [[float(lat), float(lon)] for lat, lon in zip(lats, lons)]
    step = int(math.ceil(n / max_pts))
    pts = [[float(lats[i]), float(lons[i])] for i in range(0, n, step)]
    last = [float(lats[-1]), float(lons[-1])]
    if pts[-1] != last:
        pts.append(last)
    return pts


def draw_transect(stations, tif_file: Optional[str] = None, data_folder: Optional[str] = None) -> dict:
    stations = [(float(lat), float(lon)) for lat, lon in stations]
    if len(stations) < 2:
        return {"error": "Transect needs at least 2 stations.", "used_mask": False}

    coverage = covering_raster(stations, tif_file=tif_file, data_folder=data_folder)
    if coverage is None:
        return {
            "used_mask": False,
            "path": [[lat, lon] for lat, lon in stations],
            "coverage": None,
        }

    lats = [p[0] for p in stations]
    lons = [p[1] for p in stations]
    try:
        coarse_mask, graph_A, cached = get_cached_graph(
            coverage["path"], min(lons), max(lons), min(lats), max(lats)
        )
        result = calculate_transect_data(stations, coarse_mask, graph_A, coverage["path"])
    except Exception as err:
        return {
            "used_mask": False,
            "path": [[lat, lon] for lat, lon in stations],
            "coverage": coverage["bounds"],
            "name": coverage["name"],
            "error": str(err),
        }

    if result is None:
        return {
            "used_mask": False,
            "path": [[lat, lon] for lat, lon in stations],
            "coverage": coverage["bounds"],
            "name": coverage["name"],
            "error": "No water path between the selected stations.",
        }

    distances, seabed, station_indices, path_lats, path_lons = result
    station_distances = [float(distances[i]) for i in station_indices]
    return {
        "used_mask": True,
        "cached": cached,
        "name": coverage["name"],
        "coverage": coverage["bounds"],
        "path": _decimate_path(path_lats, path_lons),
        "bathy_dist": [None if not np.isfinite(v) else float(v) for v in distances],
        "bathy_depth": [None if not np.isfinite(v) else float(v) for v in seabed],
        "station_distances": station_distances,
        "station_indices": station_indices,
    }


def overlay_bathymetry(ax, distances, seabed, style="filled"):
    if distances is None or seabed is None or len(distances) < 2:
        return
    dist = np.asarray(distances, dtype=float)
    depth = np.asarray(seabed, dtype=float)
    finite = np.isfinite(dist) & np.isfinite(depth)
    if np.count_nonzero(finite) < 2:
        return
    dist, depth = dist[finite], depth[finite]
    y_bottom = float(np.nanmax(depth))
    if style == "outline":
        ax.plot(dist, depth, color="k", lw=1.4, zorder=102)
    else:
        ax.fill_between(dist, depth, y_bottom, edgecolor="k", facecolor="grey", zorder=102)
    return y_bottom


def transect_profile_png(distances, seabed, station_distances=None, style="filled", figsize=(12, 4)):
    fig, ax = plt.subplots(figsize=figsize)
    y_bottom = overlay_bathymetry(ax, distances, seabed, style=style) or float(np.nanmax(seabed))
    if station_distances:
        for d in station_distances:
            ax.axvline(d, linestyle="--", lw=1, c="k", alpha=0.7, zorder=101)
            ax.scatter(d, 0, marker="v", s=50, c="k", clip_on=False, zorder=110)
    ax.set_xlim(0, float(np.nanmax(distances)))
    ax.set_ylim(y_bottom, 0)
    ax.set_xlabel("Distance along transect (km)")
    ax.set_ylabel("Depth (m)")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return buf
