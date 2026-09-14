import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from colors import STATION_COLOR, UNASSIGNED_COLOR, variable_color
from data import (
    as_scalar,
    as_str,
    deepest_cast_per_station,
    get_units,
    match_casts,
    resolve_clim,
    valid_depth_extent,
    resolve_cmap,
    resolve_transect_date,
    transect_distances,
    sampling_day_counts,
)


def station_top_label(name: str) -> str:
    parts = str(name or "").split()
    if len(parts) >= 2:
        return f"{parts[0]}\n{parts[1]}"
    return parts[0] if parts else ""


def apply_export_chrome(
    fig,
    title=None,
    xlabel=None,
    ylabel=None,
    attribution=None,
    attribution_position="footer",
    attribution_fontsize=8,
    fontsize=11,
    paper="light",
):
    bg = "#ffffff"
    fg = "#143028"
    fs = float(fontsize or 11)
    title_fs = fs + 2
    fig.patch.set_facecolor(bg)
    for ax in fig.axes:
        ax.set_facecolor("#ffffff")
        ax.tick_params(colors=fg, labelsize=fs)
        ax.xaxis.label.set_color(fg)
        ax.yaxis.label.set_color(fg)
        ax.title.set_color(fg)
        ax.xaxis.label.set_fontsize(fs)
        ax.yaxis.label.set_fontsize(fs)
        ax.title.set_fontsize(title_fs)
        ax.xaxis.offsetText.set_fontsize(fs)
        ax.yaxis.offsetText.set_fontsize(fs)
        for spine in ax.spines.values():
            spine.set_color(fg)
        legend = ax.get_legend()
        if legend:
            for text in legend.get_texts():
                text.set_color(fg)
                text.set_fontsize(fs)
            if legend.get_title():
                legend.get_title().set_fontsize(fs)
        for txt in ax.texts:
            txt.set_fontsize(fs)

    for txt in fig.texts:
        txt.set_fontsize(fs)

    if title and fig.axes:
        fig.axes[0].set_title(title, fontsize=title_fs)
    if xlabel and fig.axes:
        fig.axes[0].set_xlabel(xlabel, fontsize=fs)
    if ylabel and fig.axes:
        fig.axes[0].set_ylabel(ylabel, fontsize=fs)

    if attribution and fig.axes:
        ha = "center"
        x = 0.5
        if attribution_position == "bottom-left":
            ha, x = "left", 0.0
        elif attribution_position == "bottom-right":
            ha, x = "right", 1.0
        fig.axes[0].annotate(
            attribution,
            xy=(x, 0),
            xycoords="axes fraction",
            xytext=(0, -28),
            textcoords="offset points",
            ha=ha,
            va="top",
            fontsize=attribution_fontsize,
            color=fg,
            style="italic",
            annotation_clip=False,
        )
        fig.tight_layout()
        fig.subplots_adjust(bottom=0.16)
    else:
        fig.tight_layout()
    has_top_labels = any(
        abs(float(t.get_position()[1]) - 1.02) < 1e-6
        for ax in fig.axes
        for t in ax.texts
    )
    if has_top_labels:
        fig.subplots_adjust(top=min(fig.subplotpars.top, 0.82))
    return fig


def _new_axes(figsize, ax=None):
    if ax is not None:
        return ax.figure, ax
    fig, new_ax = plt.subplots(figsize=figsize)
    return fig, new_ax


def latest_cast_id(ds, cast_ids):
    latest_c = None
    latest_t = None
    for c in cast_ids:
        try:
            t = pd.to_datetime(as_scalar(ds.sel(cast=c).time.values), errors="coerce")
        except Exception:
            continue
        if pd.isna(t):
            continue
        if latest_t is None or t > latest_t:
            latest_t = t
            latest_c = c
    return latest_c, latest_t


def overview_casts_plot(
    ds,
    selected_ids,
    var="Temperature",
    ax=None,
    date_filter="All",
    depth_min=0,
    depth_max=None,
    vmin=None,
    vmax=None,
    line_width=2.5,
    figsize=(4, 6),
):
    fig, ax = _new_axes(figsize, ax)
    matching = match_casts(ds, selected_ids, date_filter)
    if not matching:
        ax.text(0.5, 0.5, "No casts to display.", ha="center", va="center")
        return fig

    latest_c, latest_t = latest_cast_id(ds, matching)
    lo, max_d = valid_depth_extent(ds, matching, var, depth_min, depth_max)
    latest_label = None

    for c in matching:
        c_ds = ds.sel(cast=c)
        if var not in c_ds:
            continue
        depths = np.ravel(c_ds.depth.values)
        vals = np.ravel(c_ds[var].values)
        mask = ~np.isnan(vals) & ~np.isnan(depths)
        if np.sum(mask) < 2:
            continue
        is_latest = c == latest_c
        color = variable_color(var)
        if is_latest:
            latest_label = str(pd.to_datetime(latest_t).date()) if latest_t is not None else str(c)
            ax.plot(
                vals[mask],
                depths[mask],
                color=color,
                linewidth=line_width,
                zorder=3,
                label=f"Most recent ({latest_label})",
            )
        else:
            ax.plot(vals[mask], depths[mask], color=color, linewidth=0.9, alpha=0.35, zorder=1)

    ax.invert_yaxis()
    ax.set_ylabel("Depth (m)")
    ax.set_xlabel(f"{var} ({get_units(var)})")
    ax.set_title(f"All casts: {var}")
    if vmin is not None or vmax is not None:
        ax.set_xlim(vmin, vmax)
    ax.set_ylim(max_d, lo)
    ax.grid(True, linestyle="--", alpha=0.5)
    if latest_label:
        ax.legend(loc="lower right", frameon=False)
    return fig


def depth_profile_plot(
    ds,
    selected_ids,
    var="Temperature",
    ax=None,
    num_std=1,
    date_filter="All",
    depth_min=0,
    depth_max=None,
    vmin=None,
    vmax=None,
    line_width=2.5,
    figsize=(4, 6),
):
    fig, ax = _new_axes(figsize, ax)
    matching_casts = match_casts(ds, selected_ids, date_filter)

    if not matching_casts:
        ax.text(0.5, 0.5, f"No casts found for date: {date_filter}", ha="center", va="center")
        return fig

    profile_matrix = []
    lo, max_d = valid_depth_extent(ds, matching_casts, var, depth_min, depth_max)
    common_depths = np.linspace(lo, max_d, 100)

    for c in matching_casts:
        c_ds = ds.sel(cast=c)
        if var not in c_ds:
            continue
        depths = np.ravel(c_ds.depth.values)
        vals = np.ravel(c_ds[var].values)
        mask = ~np.isnan(vals) & ~np.isnan(depths)
        if np.sum(mask) > 1:
            ax.plot(vals[mask], depths[mask], alpha=0.3, linewidth=1, color="gray",
                    label="All profiles" if not profile_matrix else None)
            interp_vals = np.interp(common_depths, depths[mask], vals[mask], left=np.nan, right=np.nan)
            profile_matrix.append(interp_vals)

    if profile_matrix:
        profile_arr = np.array(profile_matrix)
        mean_profile = np.nanmean(profile_arr, axis=0)
        std_profile = np.nanstd(profile_arr, axis=0)
        if num_std and num_std > 0:
            std_label = f"±{num_std:g} std"
            ax.fill_betweenx(
                common_depths,
                mean_profile - (num_std * std_profile),
                mean_profile + (num_std * std_profile),
                color="#1d7a8c",
                alpha=0.25,
                label=std_label,
            )
        ax.plot(mean_profile, common_depths, color="#1b4332", linewidth=line_width, label="Mean profile")

    ax.invert_yaxis()
    ax.set_ylabel("Depth (m)")
    ax.set_xlabel(f"{var} ({get_units(var)})")
    ax.set_title(f"Profile: {', '.join(selected_ids)} ({var})")
    if vmin is not None or vmax is not None:
        ax.set_xlim(vmin, vmax)
    ax.set_ylim(max_d, lo)
    ax.grid(True, linestyle="--", alpha=0.5)
    if ax.get_legend_handles_labels()[0]:
        ax.legend(loc="lower right", frameon=False)
    return fig


def transect_plot(
    ds,
    selected_ids,
    var="Temperature",
    ax=None,
    contour_type="contourf",
    date_filter="All",
    num_contour_lines=15,
    num_density_lines=5,
    secondary_variable=None,
    overlay_color="black",
    overlay_labels=True,
    depth_min=0,
    depth_max=None,
    vmin=None,
    vmax=None,
    colormap=None,
    figsize=(12, 4),
):
    fig, ax = _new_axes(figsize, ax)
    date_filter = resolve_transect_date(ds, selected_ids, var, date_filter)

    selected_casts = match_casts(ds, selected_ids, date_filter)
    if len(selected_casts) < 2:
        ax.text(
            0.5,
            0.5,
            f"Transect requires at least 2 casts with valid '{var}' data.\n"
            f"Found {len(selected_casts)} cast(s) on date: {date_filter}",
            ha="center",
            va="center",
            fontsize=11,
            color="#b91c1c",
        )
        return fig

    deepest_casts = deepest_cast_per_station(ds, selected_casts)
    if len(deepest_casts) < 2:
        ax.text(
            0.5,
            0.5,
            "Transect needs at least 2 selected stations.",
            ha="center",
            va="center",
            fontsize=11,
            color="#b91c1c",
        )
        return fig
    data_transect = ds.sel(cast=deepest_casts).transpose("depth", "cast")
    Z = data_transect[var].values
    if np.all(np.isnan(Z)):
        ax.text(
            0.5,
            0.5,
            f"Variable '{var}' contains only NaN values for the selected stations on {date_filter}.",
            ha="center",
            va="center",
            fontsize=11,
            color="#b91c1c",
        )
        return fig

    lats = np.ravel(data_transect.lat.values)
    lons = np.ravel(data_transect.lon.values)
    cast_dist = transect_distances(lats, lons)
    cmap = resolve_cmap(colormap, var)
    clim_min, clim_max = resolve_clim(var, vmin, vmax)
    val_min = clim_min if clim_min is not None else float(np.nanmin(Z))
    val_max = clim_max if clim_max is not None else float(np.nanmax(Z))
    if val_min == val_max:
        val_min -= 0.1
        val_max += 0.1

    n_levels = max(2, int(num_contour_lines or 15))
    levels = np.linspace(val_min, val_max, n_levels + 1)

    if contour_type == "contourf":
        mesh = ax.contourf(cast_dist, data_transect.depth.values, Z, cmap=cmap, levels=levels, extend="both")
    else:
        mesh = ax.pcolormesh(
            cast_dist, data_transect.depth.values, Z, cmap=cmap, vmin=val_min, vmax=val_max
        )

    overlay_var = secondary_variable if secondary_variable and secondary_variable != "None" else None
    if (
        overlay_var
        and overlay_var in data_transect
        and num_density_lines
        and num_density_lines > 0
        and not np.all(np.isnan(data_transect[overlay_var].values))
    ):
        try:
            line_color = "w" if str(overlay_color).lower() == "white" else "k"
            cs = ax.contour(
                cast_dist,
                data_transect.depth.values,
                data_transect[overlay_var].values,
                colors=line_color,
                linewidths=1,
                levels=int(num_density_lines),
            )
            if overlay_labels:
                ax.clabel(cs, inline=True, fontsize=8, fmt="%g", colors=line_color)
        except Exception:
            pass

    for i, d in enumerate(cast_dist):
        st_type = as_str(data_transect.cast_type[i].values)
        marker = "H" if st_type == "station" else "v"
        ax.axvline(d, lw=0.4, c="k", zorder=101)
        ax.scatter(d, 0, marker=marker, s=50, c="k", clip_on=False, zorder=101)

    if "station_name" in data_transect:
        for i, d in enumerate(cast_dist):
            if as_str(data_transect.cast_type[i].values) != "station":
                continue
            st_name = as_str(data_transect.station_name[i].values)
            if st_name in ("", "nan"):
                continue
            ax.text(
                d,
                1.02,
                station_top_label(st_name),
                transform=ax.get_xaxis_transform(),
                ha="center",
                va="bottom",
                fontsize=12,
                clip_on=False,
                zorder=101,
            )

    lo, max_d = valid_depth_extent(ds, deepest_casts, var, depth_min, depth_max)
    ax.set_xlim(0, cast_dist[-1] if len(cast_dist) else 1)
    ax.set_ylim(max_d, lo)
    ax.set_xlabel("Distance along transect (km)")
    ax.set_ylabel("Depth (m)")
    ax.set_title(f"Transect: {date_filter} ({var})")
    cbar = fig.colorbar(mesh, ax=ax)
    cbar.set_label(f"{var} ({get_units(var)})")
    return fig


SEASON_STYLE = {
    "DJF": {"name": "Winter", "color": "#3366e6"},
    "MAM": {"name": "Spring", "color": "#4db34d"},
    "JJA": {"name": "Summer", "color": "#e64d4d"},
    "SON": {"name": "Fall", "color": "#f29933"},
}


def ts_diagram_plot(
    ds,
    selected_ids,
    ax=None,
    size=10,
    date_filter="All",
    color_by="Season",
    colormap=None,
    vmin=None,
    vmax=None,
    figsize=(6, 6),
):
    import xarray as xr

    fig, ax = _new_axes(figsize, ax)
    selected_casts = match_casts(ds, selected_ids, date_filter)
    if not selected_casts:
        ax.text(0.5, 0.5, "No casts selected for T–S diagram.", ha="center", va="center")
        return fig

    ds_sub = ds.sel(cast=selected_casts)
    if "Practical Salinity" not in ds_sub or "Temperature" not in ds_sub:
        ax.text(0.5, 0.5, "T–S diagram needs Practical Salinity and Temperature.", ha="center", va="center")
        return fig

    sal_da = ds_sub["Practical Salinity"]
    temp_da = ds_sub["Temperature"]
    color_by = color_by or "Season"

    if color_by == "Season":
        s, t, season = xr.broadcast(sal_da, temp_da, ds_sub.time.dt.season)
        mask = np.isfinite(s.values) & np.isfinite(t.values)
        seasons = season.values[mask]
        sal = s.values[mask]
        temp = t.values[mask]
        for code, info in SEASON_STYLE.items():
            keep = seasons == code
            if not np.any(keep):
                continue
            ax.scatter(sal[keep], temp[keep], c=info["color"], s=size, alpha=0.7, edgecolors="none", label=info["name"])
        ax.legend(frameon=False, title="Season")
    elif color_by.lower() == "depth":
        s, t, z = xr.broadcast(sal_da, temp_da, ds_sub.depth)
        mask = np.isfinite(s.values) & np.isfinite(t.values)
        sc = ax.scatter(s.values[mask], t.values[mask], c=z.values[mask], s=size, cmap="jet", alpha=0.75, edgecolors="none")
        fig.colorbar(sc, ax=ax, label="Depth (m)")
    elif color_by in ds_sub:
        s, t, c = xr.broadcast(sal_da, temp_da, ds_sub[color_by])
        mask = np.isfinite(s.values) & np.isfinite(t.values) & np.isfinite(c.values)
        clim_min, clim_max = resolve_clim(color_by, vmin, vmax)
        sc = ax.scatter(
            s.values[mask],
            t.values[mask],
            c=c.values[mask],
            s=size,
            cmap=resolve_cmap(colormap, color_by),
            vmin=clim_min,
            vmax=clim_max,
            alpha=0.75,
            edgecolors="none",
        )
        fig.colorbar(sc, ax=ax, label=f"{color_by} ({get_units(color_by)})")
    else:
        s, t = xr.broadcast(sal_da, temp_da)
        mask = np.isfinite(s.values) & np.isfinite(t.values)
        ax.scatter(s.values[mask], t.values[mask], c="#0077b6", s=size, alpha=0.7, edgecolors="none")

    ax.set_xlabel("Practical Salinity (psu)")
    ax.set_ylabel("Temperature (°C)")
    ax.set_title("T–S Diagram")
    ax.set_box_aspect(1)
    ax.grid(alpha=0.3)
    return fig


def seasonal_profiles_plot(
    ds,
    selected_ids,
    var="Temperature",
    ax=None,
    depth_min=0,
    depth_max=None,
    date_filter="All",
    line_width=2.0,
    figsize=(4, 6),
):
    fig, ax = _new_axes(figsize, ax)
    season_dict = {
        "DJF": {"name": "Winter", "color": (0.2, 0.4, 0.9)},
        "MAM": {"name": "Spring", "color": (0.3, 0.7, 0.3)},
        "JJA": {"name": "Summer", "color": (0.9, 0.3, 0.3)},
        "SON": {"name": "Fall", "color": (0.95, 0.6, 0.2)},
    }

    selected_casts = match_casts(ds, selected_ids, date_filter)
    if not selected_casts:
        ax.text(0.5, 0.5, "No casts selected for seasonal profiles.", ha="center", va="center")
        return fig

    ds_sub = ds.sel(cast=selected_casts)
    if var not in ds_sub:
        ax.text(0.5, 0.5, f"Variable '{var}' not available.", ha="center", va="center")
        return fig

    for season, info in season_dict.items():
        valid = ds_sub.where(ds_sub.time.dt.season == season, drop=True)[var]
        if valid.cast.size == 0:
            continue
        mean = valid.mean(dim="cast")
        std = valid.std(dim="cast", ddof=0)
        ax.plot(mean, valid.depth, color=info["color"], linewidth=line_width, label=f"{info['name']} ({season})")
        ax.fill_betweenx(valid.depth, mean - std, mean + std, facecolor=info["color"], alpha=0.15, label="_nolegend_")

    lo, max_d = valid_depth_extent(ds, selected_casts, var, depth_min, depth_max)
    ax.invert_yaxis()
    ax.set_ylim(max_d, lo)
    ax.set_ylabel("Depth (m)")
    ax.set_xlabel(f"{var} ({get_units(var)})")
    ax.set_title(f"Seasonal Profiles: {var}")
    ax.legend()
    ax.grid(alpha=0.3)
    return fig


def sampling_days_plot(ds, selected_ids=None, date_filter="All", figsize=(12, 4)):
    fig, ax = plt.subplots(figsize=figsize)
    ids = selected_ids or []
    if ids:
        selected = match_casts(ds, ids, date_filter)
        ds_sub = ds.sel(cast=selected) if selected else ds.isel(cast=slice(0, 0))
    else:
        ds_sub = ds

    if ds_sub.cast.size == 0:
        ax.text(0.5, 0.5, "No casts available for sampling timeline.", ha="center", va="center")
        return fig

    dates, station_counts, unassigned_counts = sampling_day_counts(ds_sub)
    x = pd.to_datetime(dates)
    ax.bar(x, station_counts, color=STATION_COLOR, edgecolor="#143028", width=2, label="Stations")
    ax.bar(x, unassigned_counts, bottom=station_counts, color=UNASSIGNED_COLOR, edgecolor="#143028", width=2, label="Unassigned")
    ax.set_ylabel("# of Casts")
    ax.set_title(f"Sampling Frequency across {len(dates)} Days")
    ax.legend(frameon=False)
    ax.grid(alpha=0.3)
    return fig


def data_distribution_plot(ds, selected_ids=None, date_filter="All", figsize=(10, 8)):
    ids = selected_ids or []
    if ids:
        selected = match_casts(ds, ids, date_filter)
        ds_sub = ds.sel(cast=selected) if selected else ds.isel(cast=slice(0, 0))
    else:
        ds_sub = ds

    fig, axes = plt.subplots(3, 3, figsize=figsize)
    vars_to_plot = [
        v
        for v in ds_sub.data_vars
        if v not in ["lat", "lon", "depth", "time", "cast", "cast_type", "station_name", "community"]
    ]
    ax_flat = axes.flatten()

    for i, ax in enumerate(ax_flat):
        if i >= len(vars_to_plot):
            ax.axis("off")
            continue
        var = vars_to_plot[i]
        vals = np.ravel(ds_sub[var].values)
        valid_vals = vals[np.isfinite(vals)]
        units = get_units(var)
        xlabel = f"{var} ({units})" if units else var
        if valid_vals.size > 0:
            ax.hist(valid_vals, bins=20, facecolor=variable_color(var), edgecolor="w", linewidth=1)
        else:
            ax.text(0.5, 0.5, "No Data", ha="center", va="center")
        ax.set_xlabel(xlabel)
        ax.set_ylabel("Count")

    fig.tight_layout()
    return fig


def render_plot(ds, plot_type, selected_ids, variable, style):
    """Dispatch a matplotlib figure from UI plot-type labels and style dict."""
    figsize = (style.get("fig_width") or 10, style.get("fig_height") or 6)
    date_filter = style.get("date_filter") or "All"
    depth_min = style.get("depth_min")
    depth_max = style.get("depth_max")
    vmin = style.get("vmin")
    vmax = style.get("vmax")

    if "Overview" in plot_type:
        fig = overview_casts_plot(
            ds,
            selected_ids,
            var=variable,
            date_filter=date_filter,
            depth_min=depth_min if depth_min is not None else 0,
            depth_max=depth_max,
            vmin=vmin,
            vmax=vmax,
            line_width=style.get("line_width", 2.5),
            figsize=figsize,
        )
    elif "Transect" in plot_type:
        contour_type = "pcolormesh" if "Pixel" in plot_type else "contourf"
        fig = transect_plot(
            ds,
            selected_ids,
            var=variable,
            contour_type=contour_type,
            date_filter=date_filter,
            num_contour_lines=style.get("num_contour_lines", 15),
            num_density_lines=style.get("num_density_lines", 5),
            secondary_variable=style.get("secondary_variable"),
            overlay_color=style.get("overlay_color", "black"),
            overlay_labels=style.get("overlay_labels", True),
            depth_min=depth_min if depth_min is not None else 0,
            depth_max=depth_max,
            vmin=vmin,
            vmax=vmax,
            colormap=style.get("colormap"),
            figsize=figsize,
        )
        if style.get("colorbar_label") and fig.axes:
            for ax in fig.axes:
                if getattr(ax, "colorbar", None):
                    ax.colorbar.set_label(style["colorbar_label"])
            if len(fig.axes) > 1:
                try:
                    fig.axes[-1].set_ylabel(style["colorbar_label"])
                except Exception:
                    pass
    elif "Profile" in plot_type and "Season" not in plot_type:
        fig = depth_profile_plot(
            ds,
            selected_ids,
            var=variable,
            num_std=style.get("num_std", 1),
            date_filter=date_filter,
            depth_min=depth_min if depth_min is not None else 0,
            depth_max=depth_max,
            vmin=vmin,
            vmax=vmax,
            line_width=style.get("line_width", 2.5),
            figsize=figsize,
        )
    elif "T-S" in plot_type or "T–S" in plot_type:
        fig = ts_diagram_plot(
            ds,
            selected_ids,
            size=style.get("marker_size", 10),
            date_filter=date_filter,
            color_by=style.get("color_by") or "Season",
            colormap=style.get("colormap"),
            vmin=vmin,
            vmax=vmax,
            figsize=figsize,
        )
    elif "Season" in plot_type:
        fig = seasonal_profiles_plot(
            ds,
            selected_ids,
            var=variable,
            depth_min=depth_min if depth_min is not None else 0,
            depth_max=depth_max,
            date_filter=date_filter,
            line_width=style.get("line_width", 2.0),
            figsize=figsize,
        )
    elif "Sampling" in plot_type:
        fig = sampling_days_plot(ds, selected_ids, date_filter=date_filter, figsize=figsize)
    elif "Distribution" in plot_type:
        fig = data_distribution_plot(ds, selected_ids, date_filter=date_filter, figsize=figsize)
    else:
        fig, ax = plt.subplots(figsize=figsize)
        ax.text(0.5, 0.5, f"Unsupported plot type: {plot_type}", ha="center", va="center")

    apply_export_chrome(
        fig,
        title=style.get("title"),
        xlabel=style.get("xlabel"),
        ylabel=style.get("ylabel"),
        attribution=style.get("attribution") if style.get("show_attribution") else None,
        attribution_position=style.get("attribution_position", "footer"),
        attribution_fontsize=style.get("attribution_fontsize", 8),
        fontsize=style.get("fontsize", 11),
        paper=style.get("paper", "light"),
    )
    return fig
