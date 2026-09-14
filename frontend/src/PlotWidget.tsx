import { useEffect, useMemo, useRef, useState } from 'react';
import Plot from 'react-plotly.js';
import { STATION_COLOR, UNASSIGNED_COLOR, variableColor, variableXLabel } from './colors';

interface WidgetProps {
  id: string;
  availableVars: string[];
  availablePlotTypes: string[];
  availableDates: { date: string; label: string }[];
  selectedStations: string[];
  globalDate: string;
  visible: boolean;
}

function dateApplies(filter: string, dates: { date: string }[]) {
  if (!filter || filter === 'All') return true;
  return dates.some((d) => d.date === filter || d.date.startsWith(filter));
}

const COLORMAPS = ['auto', 'thermal', 'haline', 'dense', 'viridis', 'plasma', 'turbo', 'jet', 'YlGnBu', 'RdYlBu_r'];

const SEASON_COLORS: Record<string, { name: string; color: string }> = {
  DJF: { name: 'Winter', color: '#3366e6' },
  MAM: { name: 'Spring', color: '#4db34d' },
  JJA: { name: 'Summer', color: '#e64d4d' },
  SON: { name: 'Fall', color: '#f29933' },
};

const PRESETS: Record<string, { w: string; h: string; canvas: string }> = {
  overview: { w: '6', h: '8', canvas: 'portrait' },
  profile: { w: '6', h: '8', canvas: 'portrait' },
  seasonal: { w: '6', h: '8', canvas: 'portrait' },
  transect: { w: '12', h: '5', canvas: 'landscape' },
  ts: { w: '7', h: '7', canvas: 'square' },
  sampling: { w: '10', h: '4', canvas: 'wide' },
  distribution: { w: '10', h: '8', canvas: 'square' },
};

function stationTopLabel(name: string) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}<br>${parts[1]}`;
  return parts[0] || '';
}

function withAlpha(color: string, a: number) {
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return color;
}

function plotKind(plotType: string) {
  if (plotType.includes('Overview')) return 'overview';
  if (plotType.includes('Transect')) return 'transect';
  if (plotType.includes('Season')) return 'seasonal';
  if (plotType.includes('Profile')) return 'profile';
  if (plotType.includes('T-S') || plotType.includes('T–S')) return 'ts';
  if (plotType.includes('Sampling')) return 'sampling';
  if (plotType.includes('Distribution')) return 'distribution';
  return 'other';
}

function controlsFor(kind: string, colorBy: string) {
  const colored = kind === 'ts' && colorBy !== 'Season';
  return {
    variable: ['overview', 'transect', 'profile', 'seasonal'].includes(kind),
    overlay: kind === 'transect',
    date: kind !== 'distribution',
    colorBy: kind === 'ts',
    colorbar: kind === 'transect' || colored,
    depth: ['overview', 'transect', 'profile', 'seasonal'].includes(kind),
    vlim: kind === 'transect' || (kind === 'ts' && colorBy !== 'Season' && colorBy.toLowerCase() !== 'depth'),
    colormap: kind === 'transect' || colored,
    contours: kind === 'transect',
    std: kind === 'profile',
    marker: kind === 'ts',
    line: ['overview', 'profile', 'seasonal'].includes(kind),
  };
}

export default function PlotWidget({
  id,
  availableVars,
  availablePlotTypes,
  availableDates,
  selectedStations,
  globalDate,
  visible,
}: WidgetProps) {
  const [activeVar, setActiveVar] = useState<string>(
    availableVars.includes('Temperature') ? 'Temperature' : (availableVars[0] || 'Temperature')
  );
  const [secondaryVar, setSecondaryVar] = useState<string>('None');
  const [plotType, setPlotType] = useState<string>(
    availablePlotTypes.find((t) => t.includes('Overview'))
    || availablePlotTypes[0]
    || 'Overview (Selected vs Depth)'
  );
  const [selectedDate, setSelectedDate] = useState<string>(globalDate);
  const [showAttribution, setShowAttribution] = useState<boolean>(false);
  const [studioOpen, setStudioOpen] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [colorBy, setColorBy] = useState<string>('Season');

  const [title, setTitle] = useState('');
  const [xlabel, setXlabel] = useState('');
  const [ylabel, setYlabel] = useState('');
  const [colorbarLabel, setColorbarLabel] = useState('');
  const [depthMin, setDepthMin] = useState('0');
  const [depthMax, setDepthMax] = useState('');
  const [vmin, setVmin] = useState('');
  const [vmax, setVmax] = useState('');
  const [colormap, setColormap] = useState('auto');
  const [numContours, setNumContours] = useState('50');
  const [numDensity, setNumDensity] = useState('5');
  const [overlayColor, setOverlayColor] = useState<'black' | 'white'>('black');
  const [overlayLabels, setOverlayLabels] = useState(true);
  const [numStd, setNumStd] = useState('1');
  const [markerSize, setMarkerSize] = useState('8');
  const [lineWidth, setLineWidth] = useState('2.5');
  const [figWidth, setFigWidth] = useState('6');
  const [figHeight, setFigHeight] = useState('8');
  const [dpi, setDpi] = useState('300');
  const [exportFormat, setExportFormat] = useState('png');
  const [fileName, setFileName] = useState('');
  const [attrPosition, setAttrPosition] = useState('footer');
  const [attrFontSize, setAttrFontSize] = useState('8');

  const [plotData, setPlotData] = useState<any>(null);
  const [plotRev, setPlotRev] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const kind = plotKind(plotType);
  const preset = PRESETS[kind] || PRESETS.overview;
  const show = controlsFor(kind, colorBy);
  const needsSelection = kind !== 'sampling' && kind !== 'distribution';
  const plotIds = selectedStations;
  const plotFrameRef = useRef<HTMLDivElement | null>(null);
  const fetchGen = useRef(0);

  const effectiveDate = dateApplies(selectedDate, availableDates) ? selectedDate : 'All';
  const dateOptions = useMemo(() => {
    if (effectiveDate === 'All' || availableDates.some((d) => d.date === effectiveDate)) return availableDates;
    return [{ date: effectiveDate, label: effectiveDate }, ...availableDates];
  }, [availableDates, effectiveDate]);

  useEffect(() => { setSelectedDate(globalDate); }, [globalDate]);
  useEffect(() => {
    if (availableVars.length && !availableVars.includes(activeVar)) setActiveVar(availableVars[0]);
  }, [availableVars, activeVar]);
  useEffect(() => {
    setFigWidth(preset.w);
    setFigHeight(preset.h);
  }, [plotType]);

  const stylePayload = () => ({
    selected_ids: plotIds,
    variable: activeVar,
    secondary_variable: secondaryVar,
    plot_type: plotType,
    date_filter: effectiveDate,
    color_by: colorBy,
    title: title || null,
    xlabel: xlabel || null,
    ylabel: ylabel || null,
    colorbar_label: colorbarLabel || null,
    depth_min: depthMin === '' ? null : Number(depthMin),
    depth_max: depthMax === '' ? null : Number(depthMax),
    vmin: vmin === '' ? null : Number(vmin),
    vmax: vmax === '' ? null : Number(vmax),
    colormap,
    num_contour_lines: Number(numContours) || 20,
    num_density_lines: Number(numDensity) || 5,
    overlay_color: overlayColor,
    overlay_labels: overlayLabels,
    num_std: Number(numStd) || 1,
    marker_size: Number(markerSize) || 8,
    line_width: Number(lineWidth) || 2.5,
    paper: 'light',
    show_attribution: showAttribution,
    attribution_position: attrPosition,
    attribution_fontsize: Number(attrFontSize) || 8,
    fig_width: Number(figWidth) || 10,
    fig_height: Number(figHeight) || 6,
    dpi: Number(dpi) || 300,
    format: exportFormat,
  });

  useEffect(() => {
    if (needsSelection && plotIds.length === 0) {
      fetchGen.current += 1;
      setPlotData(null);
      setErrorMsg(null);
      setLoading(false);
      return;
    }
    const gen = ++fetchGen.current;
    const ac = new AbortController();
    setLoading(true);
    fetch('/api/plot_data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stylePayload()),
      signal: ac.signal,
    })
      .then((res) => res.json())
      .then((json) => {
        if (gen !== fetchGen.current) return;
        if (json.error) {
          setErrorMsg(json.error);
          setPlotData(null);
        } else {
          setErrorMsg(null);
          setPlotData(json);
          setPlotRev((n) => n + 1);
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError' || gen !== fetchGen.current) return;
        setErrorMsg(err.message);
        setPlotData(null);
      })
      .finally(() => {
        if (gen === fetchGen.current) setLoading(false);
      });
    return () => ac.abort();
  }, [plotIds.join('|'), activeVar, secondaryVar, plotType, effectiveDate, colorBy, depthMin, depthMax, vmin, vmax, colormap, numStd, needsSelection]);

  useEffect(() => {
    if (!visible) return;
    const frame = plotFrameRef.current;
    const resize = () => {
      const gd = frame?.querySelector('.js-plotly-plot') as any;
      const Plotly = (window as any).Plotly;
      if (gd && Plotly?.Plots?.resize) Plotly.Plots.resize(gd);
    };
    const t1 = window.setTimeout(resize, 40);
    const t2 = window.setTimeout(resize, 220);
    const ro = frame ? new ResizeObserver(resize) : null;
    if (frame && ro) ro.observe(frame);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      ro?.disconnect();
    };
  }, [visible, plotData]);

  const generatePlotlyTraces = () => {
    if (!plotData) return [];
    const lineW = Number(lineWidth) || 2.5;
    const mSize = Number(markerSize) || 8;

    if (plotData.plot_type === 'transect') {
      const isPixelMesh = plotType.includes('Pixel Mesh');
      const traces: any[] = [{
        z: plotData.z_primary,
        x: plotData.x_dist,
        y: plotData.y_depth,
        type: isPixelMesh ? 'heatmap' : 'contour',
        colorscale: plotData.colorscale || 'Viridis',
        zmin: plotData.vmin ?? undefined,
        zmax: plotData.vmax ?? undefined,
        colorbar: {
          title: { text: colorbarLabel || `${plotData.primary_var} (${plotData.units_primary})` },
          tickfont: { color: '#143028' },
          titlefont: { color: '#143028' },
          len: 0.8,
          thickness: 16,
          outlinewidth: 0,
          x: 1.02,
          xpad: 8,
        },
      }];
      if (plotData.z_secondary && secondaryVar !== 'None') {
        const overlayStroke = overlayColor === 'white' ? '#ffffff' : '#000000';
        traces.push({
          z: plotData.z_secondary,
          x: plotData.x_dist,
          y: plotData.y_depth,
          type: 'contour',
          name: plotData.secondary_var || secondaryVar,
          showscale: false,
          hoverinfo: 'skip',
          autocontour: true,
          ncontours: Number(numDensity) || 5,
          colorscale: [[0, overlayStroke], [1, overlayStroke]],
          contours: {
            coloring: 'lines',
            showlabels: overlayLabels,
            labelfont: { color: overlayStroke, size: 11 },
          },
          line: { color: overlayStroke, width: 1.6 },
        });
      }
      const xs: number[] = plotData.x_dist || [];
      const types: string[] = plotData.cast_types || [];
      if (xs.length) {
        traces.push({
          x: xs,
          y: xs.map(() => 0),
          mode: 'markers',
          marker: {
            symbol: xs.map((_, i) => (types[i] === 'station' ? 'hexagon' : 'triangle-down')),
            size: 10,
            color: '#000000',
            line: { width: 0 },
          },
          cliponaxis: false,
          hoverinfo: 'skip',
          showlegend: false,
        });
      }
      return traces;
    }

    if (plotData.plot_type === 'overview') {
      return (plotData.traces || []).map((t: any) => ({
        x: t.x,
        y: t.y,
        mode: 'lines',
        name: t.latest ? `Most recent (${t.date})` : t.date,
        showlegend: !!t.latest,
        hoverinfo: 'name',
        line: t.latest
          ? { color: '#1b4332', width: lineW }
          : { color: '#9bb0a8', width: 1 },
        opacity: t.latest ? 1 : 0.35,
      }));
    }

    if (plotData.plot_type === 'profile') {
      const traces: any[] = (plotData.traces || []).map((t: any, i: number) => ({
        x: t.x, y: t.y, mode: 'lines',
        line: { color: '#8aa8a0', width: 1 },
        opacity: 0.35,
        name: 'All profiles',
        legendgroup: 'profiles',
        showlegend: i === 0,
        hoverinfo: 'skip',
      }));
      const nStd = Number(plotData.num_std) || 1;
      if (plotData.mean_vals?.length && plotData.std_vals?.length && nStd > 0) {
        const upper = plotData.mean_vals.map((m: number, i: number) => (m == null || plotData.std_vals[i] == null) ? null : m + nStd * plotData.std_vals[i]);
        const lower = plotData.mean_vals.map((m: number, i: number) => (m == null || plotData.std_vals[i] == null) ? null : m - nStd * plotData.std_vals[i]);
        traces.push({
          x: upper, y: plotData.common_depths, mode: 'lines', line: { width: 0 },
          showlegend: false, hoverinfo: 'skip', legendgroup: 'std', name: 'std+',
        });
        traces.push({
          x: lower, y: plotData.common_depths, mode: 'lines', line: { width: 0 },
          fill: 'tonexty', fillcolor: 'rgba(29, 122, 140, 0.25)',
          showlegend: true, hoverinfo: 'skip', legendgroup: 'std',
          name: `±${nStd} std`,
        });
      }
      traces.push({
        x: plotData.mean_vals, y: plotData.common_depths,
        mode: 'lines', line: { color: '#1b4332', width: lineW }, name: 'Mean profile',
      });
      return traces;
    }

    if (plotData.plot_type === 'ts') {
      if (plotData.color_mode === 'season') {
        return Object.entries(SEASON_COLORS).map(([code, info]) => {
          const xs: number[] = [];
          const ys: number[] = [];
          (plotData.season || []).forEach((s: string, i: number) => {
            if (s === code) {
              xs.push(plotData.salinity[i]);
              ys.push(plotData.temperature[i]);
            }
          });
          return {
            x: xs, y: ys, mode: 'markers', name: info.name,
            marker: { color: info.color, size: mSize, opacity: 0.75 },
          };
        }).filter((t) => t.x.length);
      }
      return [{
        x: plotData.salinity, y: plotData.temperature, mode: 'markers',
        marker: {
          color: plotData.color,
          colorscale: plotData.colorscale || 'Jet',
          cmin: plotData.vmin ?? undefined,
          cmax: plotData.vmax ?? undefined,
          size: mSize,
          opacity: 0.75,
          colorbar: {
            title: { text: colorbarLabel || plotData.colorbar_title || '' },
            tickfont: { color: '#143028' },
            thickness: 16,
            outlinewidth: 0,
            x: 1.02,
            xpad: 8,
          },
        },
        name: 'T–S',
      }];
    }

    if (plotData.plot_type === 'seasonal') {
      const traces: any[] = [];
      for (const s of plotData.series || []) {
        if (s.std?.length) {
          const upper = s.mean.map((m: number, i: number) => (m == null || s.std[i] == null) ? null : m + s.std[i]);
          const lower = s.mean.map((m: number, i: number) => (m == null || s.std[i] == null) ? null : m - s.std[i]);
          traces.push({
            x: upper, y: s.depth, mode: 'lines', line: { width: 0 },
            showlegend: false, hoverinfo: 'skip', legendgroup: s.name, name: `${s.name} std+`,
          });
          traces.push({
            x: lower, y: s.depth, mode: 'lines', line: { width: 0 },
            fill: 'tonexty', fillcolor: withAlpha(s.color, 0.15),
            showlegend: false, hoverinfo: 'skip', legendgroup: s.name, name: `${s.name} std`,
          });
        }
        traces.push({
          x: s.mean, y: s.depth, mode: 'lines',
          line: { color: s.color, width: lineW }, name: s.name, legendgroup: s.name,
        });
      }
      return traces;
    }

    if (plotData.plot_type === 'sampling') {
      return [
        {
          x: plotData.dates, y: plotData.station_counts || [], type: 'bar',
          marker: { color: plotData.station_color || STATION_COLOR }, name: 'Stations',
        },
        {
          x: plotData.dates, y: plotData.unassigned_counts || [], type: 'bar',
          marker: { color: plotData.unassigned_color || UNASSIGNED_COLOR }, name: 'Unassigned',
        },
      ];
    }

    if (plotData.plot_type === 'distribution') {
      return (plotData.panels || []).map((p: any, i: number) => ({
        x: p.values,
        type: 'histogram',
        name: p.variable,
        showlegend: false,
        marker: { color: p.color || variableColor(p.variable), line: { color: '#ffffff', width: 1 } },
        xaxis: i === 0 ? 'x' : `x${i + 1}`,
        yaxis: i === 0 ? 'y' : `y${i + 1}`,
      }));
    }

    return [];
  };

  const generateLayout = () => {
    const axis = { color: '#143028', gridcolor: '#e2ebe7', zerolinecolor: '#c5d4cc', linecolor: '#143028' };
    const viewKey = `${id}|${plotType}|${plotIds.join('|')}|${effectiveDate}|${activeVar}`;
    const depthRange = (plotData?.depth_max != null)
      ? [plotData.depth_max, plotData.depth_min ?? 0]
      : undefined;
    const base: any = {
      autosize: true,
      margin: { t: 40, b: showAttribution ? 56 : 40, l: 56, r: show.colorbar ? 88 : 30 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      font: { color: '#143028', size: 11 },
      uirevision: viewKey,
      xaxis: { ...axis },
      yaxis: { ...axis },
      title: title ? { text: title, font: { size: 14 } } : undefined,
    };

    if (plotData?.plot_type === 'transect') {
      const xs: number[] = plotData.x_dist || [];
      const types: string[] = plotData.cast_types || [];
      const names: string[] = plotData.stations || [];
      const lastX = xs.length ? xs[xs.length - 1] : 1;
      const hasStationLabels = types.some((t, i) => t === 'station' && stationTopLabel(names[i]));
      return {
        ...base,
        margin: {
          ...base.margin,
          t: title ? (hasStationLabels ? 88 : 48) : (hasStationLabels ? 56 : 40),
        },
        xaxis: {
          ...axis,
          title: { text: xlabel || 'Distance along transect (km)' },
          range: [0, lastX],
        },
        yaxis: {
          ...axis,
          title: { text: ylabel || 'Depth (m)' },
          autorange: depthRange ? false : 'reversed',
          range: depthRange,
        },
        shapes: xs.map((d) => ({
          type: 'line',
          x0: d,
          x1: d,
          xref: 'x',
          y0: 0,
          y1: 1,
          yref: 'paper',
          layer: 'above',
          line: { color: 'rgba(0,0,0,0.85)', width: 1 },
        })),
        annotations: xs.flatMap((d, i) => {
          if (types[i] !== 'station') return [];
          const text = stationTopLabel(names[i]);
          if (!text) return [];
          return [{
            x: d,
            y: 1.02,
            xref: 'x',
            yref: 'paper',
            text,
            showarrow: false,
            yanchor: 'bottom',
            xanchor: 'center',
            font: { size: 11, color: '#143028' },
          }];
        }),
      };
    }
    if (plotData?.plot_type === 'overview' || plotData?.plot_type === 'profile' || plotData?.plot_type === 'seasonal') {
      return {
        ...base,
        showlegend: plotData.plot_type !== 'overview',
        legend: plotData.plot_type === 'profile'
          ? { x: 0.98, y: 0.02, xanchor: 'right', yanchor: 'bottom', bgcolor: 'rgba(255,255,255,0.85)', borderwidth: 0 }
          : { bgcolor: 'rgba(255,255,255,0.85)', borderwidth: 0 },
        xaxis: { ...axis, title: { text: xlabel || `${plotData.variable} (${plotData.units})` } },
        yaxis: {
          ...axis,
          title: { text: ylabel || 'Depth (m)' },
          autorange: depthRange ? false : 'reversed',
          range: depthRange,
        },
      };
    }
    if (plotData?.plot_type === 'ts') {
      return {
        ...base,
        xaxis: { ...axis, title: { text: xlabel || 'Practical Salinity (psu)' } },
        yaxis: { ...axis, title: { text: ylabel || 'Temperature (°C)' }, autorange: true },
        showlegend: plotData.color_mode === 'season',
      };
    }
    if (plotData?.plot_type === 'sampling') {
      return {
        ...base,
        barmode: 'stack',
        showlegend: true,
        legend: { bgcolor: 'rgba(255,255,255,0.85)', borderwidth: 0 },
        xaxis: { ...axis, title: { text: xlabel || 'Date' } },
        yaxis: { ...axis, title: { text: ylabel || '# of casts' }, autorange: true },
      };
    }
    if (plotData?.plot_type === 'distribution') {
      const layout: any = {
        ...base,
        showlegend: false,
        grid: { rows: 3, columns: 3, pattern: 'independent', xgap: 0.12, ygap: 0.22 },
        margin: { t: 16, b: 52, l: 52, r: 16 },
      };
      (plotData.panels || []).forEach((p: any, i: number) => {
        const xkey = i === 0 ? 'xaxis' : `xaxis${i + 1}`;
        const ykey = i === 0 ? 'yaxis' : `yaxis${i + 1}`;
        layout[xkey] = { ...axis, title: { text: variableXLabel(p.variable, p.units), font: { size: 10 } } };
        layout[ykey] = { ...axis, title: { text: 'Count', font: { size: 10 } } };
      });
      return layout;
    }
    return base;
  };

  const downloadName = () => {
    let base = (fileName.trim() || title.trim() || 'cf-plot');
    base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.+$/, '').trim();
    base = base.replace(/\.(png|svg|pdf)$/i, '');
    if (!base) base = 'cf-plot';
    return `${base}.${exportFormat}`;
  };

  const saveFigure = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      const payload = { ...stylePayload(), show_attribution: showAttribution };
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName();
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`widget single-plot canvas-${preset.canvas}${studioOpen ? ' studio-open' : ''}`}>
      <div className="widget-head">
        <div className="widget-controls">
          <select className="select" value={plotType} onChange={(e) => setPlotType(e.target.value)}>
            {availablePlotTypes.map((pt) => <option key={pt} value={pt}>{pt}</option>)}
          </select>
          {show.variable && (
            <select className="select" value={activeVar} onChange={(e) => setActiveVar(e.target.value)}>
              {availableVars.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
          {show.colorBy && (
            <select className="select" value={colorBy} onChange={(e) => setColorBy(e.target.value)}>
              <option value="Season">Color: Season</option>
              <option value="Depth">Color: Depth</option>
              {availableVars.map((v) => <option key={v} value={v}>Color: {v}</option>)}
            </select>
          )}
          {show.overlay && (
            <select className="select" value={secondaryVar} onChange={(e) => setSecondaryVar(e.target.value)}>
              <option value="None">Overlay: none</option>
              {availableVars.map((v) => <option key={v} value={v}>Overlay: {v}</option>)}
            </select>
          )}
          {show.overlay && secondaryVar !== 'None' && (
            <div className="heat-toggle overlay-color">
              <button type="button" className={overlayColor === 'black' ? 'on' : ''} onClick={() => setOverlayColor('black')}>
                Black
              </button>
              <button type="button" className={overlayColor === 'white' ? 'on' : ''} onClick={() => setOverlayColor('white')}>
                White
              </button>
            </div>
          )}
          {show.overlay && secondaryVar !== 'None' && (
            <label className="check">
              <input type="checkbox" checked={overlayLabels} onChange={(e) => setOverlayLabels(e.target.checked)} />
              Labels
            </label>
          )}
          {show.date && (
            <select className="select" value={effectiveDate} onChange={(e) => setSelectedDate(e.target.value)}>
              <option value="All">All dates</option>
              {dateOptions.map((d) => (
                <option key={d.date} value={d.date}>{d.label}</option>
              ))}
            </select>
          )}
          <label className="check">
            <input type="checkbox" checked={showAttribution} onChange={(e) => setShowAttribution(e.target.checked)} />
            Attribution
          </label>
        </div>
        <div className="widget-controls">
          <button type="button" className="btn btn-ghost" onClick={() => setStudioOpen((v) => !v)}>
            {studioOpen ? 'Hide options' : 'Customize'}
          </button>
          <span className="file-name-wrap">
            <input
              className="input"
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder={title.trim() || 'cf-plot'}
              aria-label="File name"
            />
            <span className="file-ext">.{exportFormat}</span>
          </span>
          <button type="button" className="btn btn-save" disabled={saving} onClick={saveFigure}>
            {saving ? 'Saving…' : 'Save figure'}
          </button>
        </div>
      </div>

      <div className={`plot-canvas ${preset.canvas}`}>
        {errorMsg ? (
          <p className="plot-error">{errorMsg}</p>
        ) : plotData ? (
          <>
            <div className="plot-frame" ref={plotFrameRef}>
              <Plot
                key={`plot-${plotRev}-${plotData.plot_type}-${overlayColor}-${overlayLabels}-${numDensity}`}
                data={generatePlotlyTraces()}
                layout={generateLayout()}
                config={{ responsive: true, displayModeBar: true }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
              />
              {loading && <div className="plot-updating">Updating…</div>}
            </div>
            {showAttribution && plotData.attribution && (
              <div className="attribution-foot">{plotData.attribution}</div>
            )}
          </>
        ) : (
          <p className="muted">
            {needsSelection && plotIds.length === 0
              ? 'Select a station in Explore, then come back to Studio.'
              : loading ? 'Loading…' : 'No plot yet.'}
          </p>
        )}
      </div>

      {studioOpen && (
        <div className="studio">
          <label>Title<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>X label<input className="input" value={xlabel} onChange={(e) => setXlabel(e.target.value)} /></label>
          <label>Y label<input className="input" value={ylabel} onChange={(e) => setYlabel(e.target.value)} /></label>
          {show.colorbar && <label>Colorbar<input className="input" value={colorbarLabel} onChange={(e) => setColorbarLabel(e.target.value)} /></label>}
          {show.depth && <label>Depth min<input className="input" value={depthMin} onChange={(e) => setDepthMin(e.target.value)} /></label>}
          {show.depth && <label>Depth max<input className="input" value={depthMax} onChange={(e) => setDepthMax(e.target.value)} /></label>}
          {show.vlim && <label>Value min<input className="input" value={vmin} onChange={(e) => setVmin(e.target.value)} /></label>}
          {show.vlim && <label>Value max<input className="input" value={vmax} onChange={(e) => setVmax(e.target.value)} /></label>}
          {show.colormap && (
            <label>Colormap
              <select className="select" value={colormap} onChange={(e) => setColormap(e.target.value)}>
                {COLORMAPS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          {show.contours && <label>Contour lines<input className="input" value={numContours} onChange={(e) => setNumContours(e.target.value)} /></label>}
          {show.contours && secondaryVar !== 'None' && (
            <label>Overlay contours<input className="input" value={numDensity} onChange={(e) => setNumDensity(e.target.value)} /></label>
          )}
          {show.std && <label>Std-dev band<input className="input" value={numStd} onChange={(e) => setNumStd(e.target.value)} /></label>}
          {show.marker && <label>Marker size<input className="input" value={markerSize} onChange={(e) => setMarkerSize(e.target.value)} /></label>}
          {show.line && <label>Line width<input className="input" value={lineWidth} onChange={(e) => setLineWidth(e.target.value)} /></label>}
          <label>Figure width<input className="input" value={figWidth} onChange={(e) => setFigWidth(e.target.value)} /></label>
          <label>Figure height<input className="input" value={figHeight} onChange={(e) => setFigHeight(e.target.value)} /></label>
          <label>DPI
            <select className="select" value={dpi} onChange={(e) => setDpi(e.target.value)}>
              <option value="150">150</option>
              <option value="300">300</option>
              <option value="600">600</option>
            </select>
          </label>
          <label>File name<input className="input" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder={title.trim() || 'cf-plot'} /></label>
          <label>Format
            <select className="select" value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
              <option value="png">PNG</option>
              <option value="svg">SVG</option>
              <option value="pdf">PDF</option>
            </select>
          </label>
          <label>Attribution position
            <select className="select" value={attrPosition} onChange={(e) => setAttrPosition(e.target.value)}>
              <option value="footer">Footer</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-right">Bottom right</option>
            </select>
          </label>
          <label>Attribution size<input className="input" value={attrFontSize} onChange={(e) => setAttrFontSize(e.target.value)} /></label>
          <div className="studio-actions">
            <span className="muted">Save uses {preset.w}×{preset.h} in at {dpi} DPI. Change size and format here, then use Save figure.</span>
          </div>
        </div>
      )}
    </div>
  );
}
