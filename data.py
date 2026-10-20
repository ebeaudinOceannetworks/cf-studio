import glob
import os
from math import atan2, cos, radians, sin, sqrt

import numpy as np
import pandas as pd
import xarray as xr

ONC = "Ocean Networks Canada Society"
EXCLUDE = {ONC, "Fisheries and Oceans Canada"}
PRIORITY_COMMUNITIES = {"Nunatsiavut Government"}

UNITS = {
    "temperature": "°C",
    "potential temperature": "°C",
    "salinity": "psu",
    "practical salinity": "psu",
    "density": "kg m⁻³",
    "chlorophyll": "mg m⁻³",
    "nitrate": "µmol L⁻¹",
    "oxygen": "µL L⁻¹",
    "oxygen concentration": "µL L⁻¹",
    "oxygen concentration corrected": "µL L⁻¹",
    "oxygen saturation": "%",
    "sound speed": "m s⁻¹",
    "velocity": "m s⁻¹",
    "depth": "m",
    "dissolved oxygen": "mL L⁻¹",
    "turbidity": "NTU",
    "pressure": "dbar",
    "conductivity": "mS cm⁻¹",
    "cdom": "m⁻¹",
}

FIXED_CLIM = {
    "dissolved oxygen": (0.0, 10.0),
    "chlorophyll": (0.0, 10.0),
}


def extract_community_from_citation(citation):
    if not citation:
        return ONC

    attribution = citation.split(".", 1)[0]
    orgs = [o.strip() for o in attribution.split(",")]

    for org in orgs:
        if org in PRIORITY_COMMUNITIES:
            return org

    community = [o for o in orgs if o not in EXCLUDE]
    if not community:
        return ONC
    return community[0]


def get_units(var):
    return UNITS.get(str(var).lower(), "")


def get_cmap(var):
    import cmocean.cm as cmo
    from matplotlib.colors import LinearSegmentedColormap

    cmap_chl = LinearSegmentedColormap.from_list(
        "CHL_cmap", ["white", "yellowgreen", "green", "forestgreen"]
    )
    cmap_o2sat = LinearSegmentedColormap.from_list(
        "O2sat_cmap", ["darkred", "midnightblue", "blue", "yellow"]
    )
    cmap_o2conc = LinearSegmentedColormap.from_list(
        "O2conc_cmap", ["maroon", "red", "tomato", "c", "lightblue", "w"]
    )

    cmap_dict = {
        "temperature": cmo.thermal,
        "potential temperature": cmo.thermal,
        "salinity": cmo.haline,
        "practical salinity": cmo.haline,
        "density": cmo.dense,
        "chlorophyll": cmap_chl,
        "turbidity": cmo.turbid,
        "cdom": cmo.amp,
        "oxygen": cmap_o2conc,
        "dissolved oxygen": cmap_o2conc,
        "oxygen concentration": cmap_o2conc,
        "oxygen concentration corrected": cmap_o2conc,
        "oxygen saturation": cmap_o2sat,
        "sound speed": "jet",
    }
    return cmap_dict.get(str(var).lower(), "jet")


def resolve_cmap(name, var):
    if not name or name in ("auto", "Auto"):
        return get_cmap(var)
    import cmocean.cm as cmo

    if hasattr(cmo, name):
        return getattr(cmo, name)
    return name


def get_clim(var):
    return FIXED_CLIM.get(str(var).lower(), (None, None))


def resolve_clim(var, vmin=None, vmax=None):
    dmin, dmax = get_clim(var)
    return (dmin if vmin is None else vmin, dmax if vmax is None else vmax)


def matplotlib_to_plotly(cmap, n=64):
    import matplotlib.pyplot as plt

    if isinstance(cmap, str):
        cmap = plt.get_cmap(cmap)
    colors = []
    for i in range(n):
        t = i / (n - 1)
        r, g, b, _a = cmap(t)
        colors.append([round(t, 4), f"rgb({int(r * 255)},{int(g * 255)},{int(b * 255)})"])
    return colors


def get_plotly_colorscale(var, override=None):
    return matplotlib_to_plotly(resolve_cmap(override, var))


def compute_o2_mL_L(ds):
    import gsw

    try:
        o2sat = ds["Oxygen Saturation"]
        temp = ds["Temperature"]
        PS = ds["Practical Salinity"]
        p = ds["Pressure"]
        o2_frac = o2sat / 100
        lat, lon = ds.lat, ds.lon
        SA = gsw.SA_from_SP(PS, p, lon, lat)
        CT = gsw.CT_from_t(SA, temp, p)
        o2_sol = gsw.O2sol(SA, CT, p, lon, lat)
        o2_umol_kg = o2_frac * o2_sol
        return (o2_umol_kg * 0.022391) / 1.025
    except Exception:
        return ds.get("Dissolved Oxygen", None)


def as_scalar(val):
    if isinstance(val, np.ndarray):
        return val.flat[0] if val.size else val
    return val


def as_str(val):
    return str(as_scalar(val))


def is_station_cast(cast_ds) -> bool:
    st_name = as_str(cast_ds.station_name.values) if "station_name" in cast_ds else ""
    c_type = as_str(cast_ds.cast_type.values) if "cast_type" in cast_ds else ""
    return c_type == "station" and st_name not in ("nan", "Unassigned Cast Data", "")


DEFAULT_TZ = "America/Vancouver"

# Community name first; lon/lat is the fallback for unassigned / unknown orgs.
_COMMUNITY_TZ_NEEDLES = (
    ("iqaluit", "America/Iqaluit"),
    ("nunatsiavut", "America/Goose_Bay"),
    ("innu nation", "America/Goose_Bay"),
    ("maritime aboriginal", "America/Halifax"),
)


def timezone_for_location(lon=None, lat=None, community=None):
    if community:
        key = str(community).lower()
        for needle, zone in _COMMUNITY_TZ_NEEDLES:
            if needle in key:
                return zone
    try:
        lon_f = float(lon)
    except (TypeError, ValueError):
        lon_f = float("nan")
    try:
        lat_f = float(lat)
    except (TypeError, ValueError):
        lat_f = float("nan")
    if lon_f == lon_f:
        if lon_f <= -110:
            return "America/Vancouver"
        if lat_f == lat_f and lat_f >= 60:
            return "America/Iqaluit"
        if lat_f == lat_f and lat_f >= 51:
            return "America/Goose_Bay"
        if lon_f <= -55:
            return "America/Halifax"
        return "America/St_Johns"
    return DEFAULT_TZ


def local_timestamp(raw, lon=None, lat=None, community=None):
    ts = pd.to_datetime(raw, utc=True, errors="coerce")
    if pd.isna(ts):
        return ts
    return ts.tz_convert(timezone_for_location(lon, lat, community))


def sampling_day_counts(ds_sub):
    counts = {}
    for c in np.ravel(ds_sub.cast.values):
        cast_ds = ds_sub.sel(cast=c)
        day = cast_date(cast_ds)
        if day == "Unknown":
            continue
        bucket = counts.setdefault(day, [0, 0])
        if is_station_cast(cast_ds):
            bucket[0] += 1
        else:
            bucket[1] += 1
    dates = sorted(counts)
    return dates, [counts[d][0] for d in dates], [counts[d][1] for d in dates]


def as_float(val):
    raw = as_scalar(val)
    return float(raw)


def cast_date(cast_ds):
    try:
        raw = as_scalar(cast_ds.time.values)
        lon = as_float(cast_ds.lon.values) if "lon" in cast_ds else None
        lat = as_float(cast_ds.lat.values) if "lat" in cast_ds else None
        community = as_str(cast_ds.community.values) if "community" in cast_ds else None
        local = local_timestamp(raw, lon=lon, lat=lat, community=community)
        if pd.isna(local):
            return "Unknown"
        return str(local.date())
    except Exception:
        return "Unknown"


def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))


def date_matches(cast_day, date_filter):
    if not date_filter or date_filter == "All":
        return True
    if not cast_day or cast_day == "Unknown":
        return False
    return str(cast_day).startswith(str(date_filter))


def valid_depth_extent(ds, cast_ids, var, depth_min=None, depth_max=None):
    zs = []
    for c in cast_ids:
        c_ds = ds.sel(cast=c)
        if var not in c_ds:
            continue
        depths = np.ravel(c_ds.depth.values)
        vals = np.ravel(c_ds[var].values)
        mask = np.isfinite(vals) & np.isfinite(depths)
        if depth_min is not None:
            mask &= depths >= depth_min
        if depth_max is not None:
            mask &= depths <= depth_max
        if np.any(mask):
            zs.append(depths[mask])
    if zs:
        allz = np.concatenate(zs)
        data_lo = float(np.nanmin(allz))
        data_hi = float(np.nanmax(allz))
    else:
        data_lo = 0.0
        data_hi = float(np.nanmax(ds.depth.values)) if np.any(np.isfinite(ds.depth.values)) else 1.0
    lo = float(depth_min) if depth_min is not None else 0.0
    hi = float(depth_max) if depth_max is not None else data_hi
    if hi <= lo:
        hi = lo + 1.0
    return lo, hi


def match_casts(ds, selected_ids, date_filter="All"):
    matching = []
    for c in ds.cast.values:
        cast_ds = ds.sel(cast=c)
        st_name = as_str(cast_ds.station_name.values)
        if not date_matches(cast_date(cast_ds), date_filter):
            continue
        if not selected_ids or st_name in selected_ids or str(c) in selected_ids:
            matching.append(c)
    return matching


def casts_by_time(ds, cast_ids, var=None):
    rows = []
    for c in cast_ids:
        t = pd.to_datetime(as_scalar(ds.sel(cast=c).time.values), errors="coerce")
        if pd.isna(t):
            continue
        if var is not None and var in ds:
            vals = np.ravel(ds.sel(cast=c)[var].values)
            if not np.any(np.isfinite(vals)):
                continue
        rows.append((t, c))
    rows.sort(key=lambda item: item[0])
    return [c for _, c in rows]


def unique_station_labels(ds, cast_ids):
    names = []
    seen = set()
    for c in cast_ids:
        cast_ds = ds.sel(cast=c)
        if not is_station_cast(cast_ds):
            continue
        name = as_str(cast_ds.station_name.values)
        if name in seen:
            continue
        seen.add(name)
        names.append(name)
    return names


def resolve_transect_date(ds, selected_ids, var, date_filter):
    if date_filter != "All":
        return date_filter

    all_dates = []
    for c in ds.cast.values:
        cast_ds = ds.sel(cast=c)
        st_name = as_str(cast_ds.station_name.values)
        if selected_ids and st_name not in selected_ids and str(c) not in selected_ids:
            continue
        if var in cast_ds and np.any(~np.isnan(cast_ds[var].values)):
            d = cast_date(cast_ds)
            if d != "Unknown":
                all_dates.append(d)
    if not all_dates:
        return "Unknown"
    return str(pd.Series(all_dates).mode()[0])


def _cast_max_depth(ds, cast_id, var=None):
    cast_ds = ds.sel(cast=cast_id)
    depths = np.ravel(cast_ds.depth.values)
    if var is not None and var in cast_ds:
        vals = np.ravel(cast_ds[var].values)
        mask = np.isfinite(depths) & np.isfinite(vals)
    else:
        mask = np.isfinite(depths)
    if not np.any(mask):
        return float("-inf")
    return float(np.max(depths[mask]))


def transect_cast_order(ds, selected_ids, cast_ids, var=None):
    """One cast per selected station or cast, in selection order.

    A station id uses the deepest cast at that station. A cast id uses that cast.
    """
    by_id = {}
    by_station = {}
    for c in cast_ids:
        by_id[str(c)] = c
        name = as_str(ds.sel(cast=c).station_name.values)
        by_station.setdefault(name, []).append(c)

    ordered = []
    seen = set()
    for sid in selected_ids or []:
        key = str(sid)
        if key in by_id:
            chosen = by_id[key]
        else:
            pool = by_station.get(key) or []
            if not pool:
                continue
            chosen = max(pool, key=lambda c: _cast_max_depth(ds, c, var))
        chosen_key = str(chosen)
        if chosen_key in seen:
            continue
        seen.add(chosen_key)
        ordered.append(chosen)
    return ordered


def order_names_like_selection(names, selected_ids):
    rank = {str(sid): i for i, sid in enumerate(selected_ids or [])}
    return sorted(names, key=lambda name: (rank.get(str(name), len(rank)), str(name)))


def deepest_cast_per_station(ds, cast_ids, var=None):
    best = {}
    order = []
    for c in cast_ids:
        cast_ds = ds.sel(cast=c)
        st_name = as_str(cast_ds.station_name.values)
        depths = np.ravel(cast_ds.depth.values)
        if var is not None and var in cast_ds:
            vals = np.ravel(cast_ds[var].values)
            mask = np.isfinite(depths) & np.isfinite(vals)
        else:
            mask = np.isfinite(depths)
        max_z = float(np.max(depths[mask])) if np.any(mask) else float("-inf")
        if st_name not in best:
            order.append(st_name)
            best[st_name] = (c, max_z)
        elif max_z > best[st_name][1]:
            best[st_name] = (c, max_z)
    return [best[st][0] for st in order]


def transect_distances(lats, lons):
    dist = np.zeros(len(lats))
    for i in range(1, len(lats)):
        dist[i] = dist[i - 1] + haversine(lats[i - 1], lons[i - 1], lats[i], lons[i])
    return dist


_BLANK_META = {"", "nan", "none"}


def _blank_meta(val):
    return str(val or "").strip().lower() in _BLANK_META


def _fresh_file_meta():
    return {
        "station_name": "",
        "cast_name": "",
        "cast_type": "unassigned",
        "citation": "",
        "lat": np.nan,
        "lon": np.nan,
        "processing_time": pd.NaT,
        "start_header": "",
    }


def _reset_cast_fields(meta):
    meta["cast_name"] = ""
    meta["lat"] = np.nan
    meta["lon"] = np.nan
    meta["processing_time"] = pd.NaT
    meta["start_header"] = ""


def _consume_header_line(meta, line_str):
    """Apply one metadata line from the .cor body. Returns True if the line was a header."""
    if line_str.startswith("Deployment "):
        _reset_cast_fields(meta)
        return True
    if line_str.startswith("Station name:"):
        st_val = line_str.split(":", 1)[1].strip()
        meta["station_name"] = st_val
        meta["cast_type"] = "station" if st_val.startswith("CF") else "unassigned"
        return True
    if line_str.startswith("Cast name:"):
        meta["cast_name"] = line_str.split(":", 1)[1].strip()
        return True
    if line_str.startswith("Citation:"):
        meta["citation"] = line_str.split(":", 1)[1].strip()
        return True
    if line_str.startswith("LatitudeCastStart:"):
        try:
            meta["lat"] = float(line_str.split(":", 1)[1].split(";")[0].strip())
        except Exception:
            pass
        return True
    if line_str.startswith("LongitudeCastStart:"):
        try:
            meta["lon"] = float(line_str.split(":", 1)[1].split(";")[0].strip())
        except Exception:
            pass
        return True
    if line_str.startswith("ProcessingDate:"):
        raw = line_str.split(":", 1)[1].split(";")[0].strip()
        meta["processing_time"] = pd.to_datetime(raw, utc=True, errors="coerce")
        return True
    if line_str.startswith("StartDateCast:"):
        meta["start_header"] = line_str.split(":", 1)[1].split(";")[0].strip()
        return True
    return False


def cast_identity(meta, start_time=None):
    """Stable cast id from file metadata. The filename is never part of the id."""
    name = str(meta.get("cast_name") or "").strip()
    if not _blank_meta(name):
        return name
    parts = []
    station = str(meta.get("station_name") or "").strip()
    if not _blank_meta(station):
        parts.append(station)
    start = str(meta.get("start_header") or "").strip()
    if start:
        parts.append(start)
    elif start_time is not None and not pd.isna(start_time):
        parts.append(str(pd.to_datetime(start_time)))
    lat, lon = meta.get("lat"), meta.get("lon")
    if isinstance(lat, (int, float)) and lat == lat:
        parts.append(f"{float(lat):.5f}")
    if isinstance(lon, (int, float)) and lon == lon:
        parts.append(f"{float(lon):.5f}")
    return "|".join(parts)


def _file_mtime(path):
    try:
        return float(os.path.getmtime(path))
    except OSError:
        return 0.0


def _as_utc_timestamp(val):
    if val is None:
        return pd.NaT
    ts = pd.to_datetime(val, utc=True, errors="coerce")
    if isinstance(ts, pd.DatetimeIndex):
        ts = ts[0] if len(ts) else pd.NaT
    return ts


def _rank_key(processing_time, source_mtime, order):
    ts = _as_utc_timestamp(processing_time)
    proc = int(ts.value) if pd.notna(ts) else -1
    try:
        mtime = float(source_mtime)
    except (TypeError, ValueError):
        mtime = 0.0
    if mtime != mtime:
        mtime = 0.0
    return (proc, mtime, int(order))


def _processing_coord(val):
    ts = _as_utc_timestamp(val)
    if pd.isna(ts):
        return np.datetime64("NaT")
    return np.datetime64(ts.to_datetime64())


def dedupe_casts(ds):
    """Keep one row per cast id. A later processing date wins; file mtime breaks ties."""
    if ds is None:
        return ds
    n = int(ds.sizes.get("cast", 0))
    if n <= 1:
        return ds
    ids = [str(c) for c in np.ravel(ds.cast.values)]
    if len(ids) == len(set(ids)) and all(ids):
        return ds
    proc = np.ravel(ds.processing_time.values) if "processing_time" in ds.coords else None
    mtimes = np.ravel(ds.source_mtime.values) if "source_mtime" in ds.coords else None
    best = {}
    for i, cid in enumerate(ids):
        if not cid:
            continue
        rank = _rank_key(None if proc is None else proc[i], 0.0 if mtimes is None else mtimes[i], i)
        prev = best.get(cid)
        if prev is None or rank >= prev[0]:
            best[cid] = (rank, i)
    keep = []
    seen = set()
    for cid in ids:
        if not cid or cid in seen or cid not in best:
            continue
        seen.add(cid)
        keep.append(best[cid][1])
    if not keep:
        return ds.isel(cast=slice(0, 0))
    return ds.isel(cast=keep)


def combine_casts(ds_list):
    usable = [ds for ds in ds_list if ds is not None and int(ds.sizes.get("cast", 0)) > 0]
    if not usable:
        return None
    if len(usable) == 1:
        return dedupe_casts(usable[0])
    merged = xr.concat(usable, dim="cast", join="outer").sortby("depth")
    return dedupe_casts(merged)


def cor2xr(cor_file):
    base_name = os.path.basename(cor_file)
    source_mtime = _file_mtime(cor_file)
    with open(cor_file, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()

    ds_list = []
    current_meta = _fresh_file_meta()

    columns = []
    deployment_rows = []
    inside_data_block = False

    for line in lines:
        line_str = line.strip()
        if not line_str:
            continue

        if _consume_header_line(current_meta, line_str):
            continue

        if line_str.startswith("Column"):
            raw_cols = line_str.split(",")
            parsed_cols = []
            for c in raw_cols:
                col_name = c.split(":")[-1].split(";")[0].split("(")[0].strip()
                parsed_cols.append(col_name)
            if parsed_cols:
                columns = parsed_cols

        elif "------ BEGIN DATA ------" in line_str:
            inside_data_block = True
            deployment_rows = []

        elif "------ END DATA ------" in line_str:
            inside_data_block = False
            if not deployment_rows:
                _reset_cast_fields(current_meta)
                continue

            sample_row = deployment_rows[0]
            if not columns or len(columns) != len(sample_row):
                columns = [f"Col_{i}" for i in range(len(sample_row))]

            df = pd.DataFrame(deployment_rows, columns=columns)

            lat_col = next((c for c in df.columns if "lat" in c.lower()), None)
            lon_col = next((c for c in df.columns if "lon" in c.lower() or "long" in c.lower()), None)
            depth_col = next((c for c in df.columns if "depth" in c.lower()), None)
            time_col = next((c for c in df.columns if "time" in c.lower()), None)

            lat_val = current_meta["lat"]
            if lat_col:
                parsed_lat = pd.to_numeric(df[lat_col], errors="coerce").dropna().mean()
                if not np.isnan(parsed_lat):
                    lat_val = float(parsed_lat)

            lon_val = current_meta["lon"]
            if lon_col:
                parsed_lon = pd.to_numeric(df[lon_col], errors="coerce").dropna().mean()
                if not np.isnan(parsed_lon):
                    lon_val = float(parsed_lon)

            start_time = np.datetime64("NaT")
            start_time_raw = None
            if time_col:
                t_series = pd.to_datetime(
                    df[time_col], format="%Y%m%dT%H%M%S.%fZ", errors="coerce", utc=True
                ).dropna()
                if not t_series.empty:
                    start_time_raw = t_series.iloc[0]
                    start_time = np.datetime64(start_time_raw.tz_convert(None))

            data_vars = {}
            for col in df.columns:
                if col not in [time_col, depth_col, lat_col, lon_col]:
                    data_vars[col] = ("depth", pd.to_numeric(df[col], errors="coerce").values)

            depth_vals = (
                pd.to_numeric(df[depth_col], errors="coerce").values
                if depth_col
                else np.arange(len(df))
            )
            community = extract_community_from_citation(current_meta["citation"])

            unique_cast_id = cast_identity(current_meta, start_time_raw)
            if not unique_cast_id:
                _reset_cast_fields(current_meta)
                continue

            ds = xr.Dataset(
                data_vars=data_vars,
                coords={
                    "depth": depth_vals,
                    "cast": [unique_cast_id],
                    "station_name": ("cast", [str(current_meta["station_name"])]),
                    "station": ("cast", [str(current_meta["station_name"])]),
                    "cast_type": ("cast", [str(current_meta["cast_type"])]),
                    "cast_name": ("cast", [str(current_meta["cast_name"] or unique_cast_id)]),
                    "community": ("cast", [str(community)]),
                    "time": ("cast", [start_time]),
                    "lat": ("cast", [lat_val]),
                    "lon": ("cast", [lon_val]),
                    "processing_time": ("cast", [_processing_coord(current_meta["processing_time"])]),
                    "source_mtime": ("cast", [source_mtime]),
                },
            )

            _, unique_idx = np.unique(ds.depth.values, return_index=True)
            ds = ds.isel(depth=unique_idx).sortby("depth")
            ds_list.append(ds)
            _reset_cast_fields(current_meta)

        elif inside_data_block:
            items = [i.strip() for i in line_str.split(",")] if "," in line_str else line_str.split()
            row = []
            for item in items:
                try:
                    row.append(float(item))
                except ValueError:
                    row.append(item)
            deployment_rows.append(row)

    if not ds_list:
        raise ValueError(f"No valid data blocks parsed from {base_name}")

    for i in range(len(ds_list)):
        _, u_idx = np.unique(ds_list[i].depth.values, return_index=True)
        ds_list[i] = ds_list[i].isel(depth=u_idx).sortby("depth")

    merged = xr.concat(ds_list, dim="cast", data_vars="all", join="outer")
    return dedupe_casts(merged)


def parse_cor(cor_file):
    cast = cor2xr(cor_file)
    o2_calc = compute_o2_mL_L(cast)
    if o2_calc is not None:
        cast["Dissolved Oxygen"] = o2_calc
    _, index = np.unique(cast["depth"].values, return_index=True)
    return cast.isel(depth=index).sortby("depth")


def concatenate_casts(cor_files):
    ds_list = []
    print(f"Loading {len(cor_files)} selected file(s)...")
    for i, cor_file in enumerate(cor_files):
        try:
            ds_list.append(parse_cor(cor_file))
        except Exception as file_err:
            print(
                f"Skipped unparseable file [{i + 1}/{len(cor_files)}] "
                f"{os.path.basename(cor_file)}: {file_err}"
            )
            continue
    if not ds_list:
        raise ValueError("No valid .cor files could be loaded.")
    combined = combine_casts(ds_list)
    if combined is None or int(combined.sizes.get("cast", 0)) == 0:
        raise ValueError("No valid .cor files could be loaded.")
    return combined


def _parse_data_items(line_str):
    items = [i.strip() for i in line_str.split(",")] if "," in line_str else line_str.split()
    row = []
    for item in items:
        try:
            row.append(float(item))
        except ValueError:
            row.append(item)
    return row


def _row_time_lat_lon(columns, row, lat_val, lon_val):
    start_time = None
    if not columns or not row:
        return lat_val, lon_val, start_time
    for name, val in zip(columns, row):
        low = str(name).lower()
        if "time" in low:
            ts = pd.to_datetime(val, format="%Y%m%dT%H%M%S.%fZ", errors="coerce", utc=True)
            if pd.notna(ts):
                start_time = ts
        elif "lat" in low:
            try:
                parsed = float(val)
                if parsed == parsed:
                    lat_val = parsed
            except (TypeError, ValueError):
                pass
        elif "lon" in low or "long" in low:
            try:
                parsed = float(val)
                if parsed == parsed:
                    lon_val = parsed
            except (TypeError, ValueError):
                pass
    return lat_val, lon_val, start_time


def index_cor_file(cor_file):
    base_name = os.path.basename(cor_file)
    source_mtime = _file_mtime(cor_file)
    current_meta = _fresh_file_meta()
    columns = []
    entries = []
    inside_data_block = False
    first_row = None

    with open(cor_file, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line_str = line.strip()
            if not line_str:
                continue
            if _consume_header_line(current_meta, line_str):
                continue
            if line_str.startswith("Column"):
                raw_cols = line_str.split(",")
                parsed_cols = []
                for c in raw_cols:
                    col_name = c.split(":")[-1].split(";")[0].split("(")[0].strip()
                    parsed_cols.append(col_name)
                if parsed_cols:
                    columns = parsed_cols
            elif "------ BEGIN DATA ------" in line_str:
                inside_data_block = True
                first_row = None
            elif "------ END DATA ------" in line_str:
                inside_data_block = False
                lat_val, lon_val, start_time = _row_time_lat_lon(
                    columns, first_row, current_meta["lat"], current_meta["lon"]
                )
                cast_id = cast_identity(current_meta, start_time)
                community = extract_community_from_citation(current_meta["citation"])
                day = "Unknown"
                if start_time is not None:
                    local = local_timestamp(start_time, lon=lon_val, lat=lat_val, community=community)
                    if not pd.isna(local):
                        day = str(local.date())
                proc = current_meta["processing_time"]
                if cast_id:
                    entries.append({
                        "path": cor_file,
                        "cast_id": cast_id,
                        "station_name": str(current_meta["station_name"]),
                        "cast_name": str(current_meta["cast_name"] or cast_id),
                        "cast_type": str(current_meta["cast_type"]),
                        "community": str(community),
                        "lat": lat_val,
                        "lon": lon_val,
                        "date": day,
                        "columns": list(columns),
                        "processing_time": None if pd.isna(proc) else proc,
                        "source_mtime": source_mtime,
                    })
                _reset_cast_fields(current_meta)
            elif inside_data_block and first_row is None:
                first_row = _parse_data_items(line_str)

    if not entries:
        raise ValueError(f"No data blocks in {base_name}")
    return entries


INDEX_SKIP_COLS = {"lat", "lon", "long", "longitude", "latitude", "depth", "time", "datetime"}


def list_cor_files(path_dir):
    return sorted(
        path
        for path in glob.glob(os.path.join(path_dir, "**", "*.cor"), recursive=True)
        if os.path.basename(path).endswith(".cor")
    )


def index_folder(path_dir):
    if not os.path.exists(path_dir):
        raise ValueError(f"Directory path does not exist: {path_dir}")
    cor_files = list_cor_files(path_dir)
    if not cor_files:
        raise ValueError(f"No .cor files found in {path_dir}")

    by_id = {}
    order = []
    seen_n = 0
    seq = 0
    print(f"Indexing {len(cor_files)} files...")
    for i, cor_file in enumerate(cor_files):
        try:
            file_entries = index_cor_file(cor_file)
        except Exception as file_err:
            print(
                f"Skipped unreadable file [{i + 1}/{len(cor_files)}] "
                f"{os.path.basename(cor_file)}: {file_err}"
            )
            continue
        for entry in file_entries:
            seen_n += 1
            cast_id = entry.get("cast_id") or ""
            if not cast_id:
                continue
            seq += 1
            rank = _rank_key(entry.get("processing_time"), entry.get("source_mtime"), seq)
            prev = by_id.get(cast_id)
            if prev is None:
                by_id[cast_id] = (rank, entry)
                order.append(cast_id)
            elif rank >= prev[0]:
                by_id[cast_id] = (rank, entry)
    catalog = [by_id[cast_id][1] for cast_id in order]
    if not catalog:
        raise ValueError("No valid .cor files could be indexed from the folder.")
    variables = set()
    for entry in catalog:
        for col in entry.get("columns") or []:
            if col and col.lower() not in INDEX_SKIP_COLS:
                variables.add(col)
    if {"Oxygen Saturation", "Temperature", "Practical Salinity", "Pressure"} <= variables:
        variables.add("Dissolved Oxygen")
    dropped = seen_n - len(catalog)
    print(f"Indexed {len(catalog)} unique casts in {len({e['path'] for e in catalog})} files.")
    if dropped:
        print(f"Ignored {dropped} duplicate cast(s) that share a cast id.")
    return catalog, sorted(variables)


def files_for_selection(catalog, selected_ids):
    if not selected_ids:
        return []
    wanted = set(selected_ids)
    paths = []
    seen = set()
    for entry in catalog:
        if entry["station_name"] in wanted or entry["cast_id"] in wanted:
            path = entry["path"]
            if path not in seen:
                seen.add(path)
                paths.append(path)
    return paths


def load_folder(path_dir):
    catalog, _variables = index_folder(path_dir)
    return catalog, len({e["path"] for e in catalog})
