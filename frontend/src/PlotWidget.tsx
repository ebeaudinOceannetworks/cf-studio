import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Plot from 'react-plotly.js';
import { STATION_COLOR, UNASSIGNED_COLOR, variableColor, variableXLabel } from './colors';

interface WidgetProps {
  id: string;
  availableVars: string[];
  availablePlotTypes: string[];
  availableDates: { date: string; label: string }[];
  selectedStations: string[];
  selectedLabels: string[];
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
  overview: { w: '4', h: '6', canvas: 'portrait' },
  profile: { w: '4', h: '6', canvas: 'portrait' },
  seasonal: { w: '4', h: '6', canvas: 'portrait' },
  transect: { w: '12', h: '4', canvas: 'landscape' },
  timeseries: { w: '8', h: '4', canvas: 'landscape' },
  ts: { w: '6', h: '6', canvas: 'square' },
  sampling: { w: '12', h: '4', canvas: 'wide' },
  history: { w: '8', h: '6', canvas: 'landscape' },
  distribution: { w: '10', h: '8', canvas: 'square' },
};

function stationTopLabel(name: string) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}<br>${parts[1]}`;
  return parts[0] || '';
}

function wrapAttribution(text: string, widthChars: number) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > widthChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join('<br>');
}

function jpegDataUrlToPdf(dataUrl: string, widthPx: number, heightPx: number, dpi: number) {
  const comma = dataUrl.indexOf(',');
  const raw = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const wPt = (widthPx * 72) / dpi;
  const hPt = (heightPx * 72) / dpi;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets = [0];
  let pos = 0;
  const pushStr = (s: string) => {
    const b = encoder.encode(s);
    parts.push(b);
    pos += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    parts.push(b);
    pos += b.length;
  };
  pushStr('%PDF-1.4\n');
  offsets.push(pos);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets.push(pos);
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets.push(pos);
  pushStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  offsets.push(pos);
  pushStr(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
  pushBytes(bytes);
  pushStr('\nendstream\nendobj\n');
  offsets.push(pos);
  const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q`;
  pushStr(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const xref = pos;
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pushStr(table);
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return new Blob([out], { type: 'application/pdf' });
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
  if (plotType.includes('Timeseries') || plotType.includes('Time Series')) return 'timeseries';
  if (plotType.includes('Season')) return 'seasonal';
  if (plotType.includes('Profile')) return 'profile';
  if (plotType.includes('T-S') || plotType.includes('T–S')) return 'ts';
  if (plotType.includes('History')) return 'history';
  if (plotType.includes('Sampling')) return 'sampling';
  if (plotType.includes('Distribution')) return 'distribution';
  return 'other';
}

function controlsFor(kind: string, colorBy: string) {
  const colored = kind === 'ts' && colorBy !== 'Season';
  const filled = kind === 'transect' || kind === 'timeseries';
  return {
    variable: ['overview', 'transect', 'timeseries', 'profile', 'seasonal'].includes(kind),
    overlay: filled,
    bathymetry: kind === 'transect',
    date: kind !== 'distribution' && kind !== 'timeseries',
    station: kind === 'timeseries',
    colorBy: kind === 'ts',
    colorbar: filled || colored,
    depth: ['overview', 'transect', 'timeseries', 'profile', 'seasonal'].includes(kind),
    vlim: filled || (kind === 'ts' && colorBy !== 'Season' && colorBy.toLowerCase() !== 'depth'),
    colormap: filled || colored,
    contours: filled,
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
  selectedLabels = [],
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
  const [tsStation, setTsStation] = useState<string>(
    selectedStations[selectedStations.length - 1] || ''
  );
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
  const [numContours, setNumContours] = useState('15');
  const [numDensity, setNumDensity] = useState('5');
  const [overlayColor, setOverlayColor] = useState<'black' | 'white'>('black');
  const [overlayLabels, setOverlayLabels] = useState(true);
  const [addBathy, setAddBathy] = useState(true);
  const [bathyStyle, setBathyStyle] = useState<'filled' | 'outline'>('filled');
  const [numStd, setNumStd] = useState('1');
  const [markerSize, setMarkerSize] = useState('8');
  const [lineWidth, setLineWidth] = useState('2.5');
  const [figWidth, setFigWidth] = useState('6');
  const [figHeight, setFigHeight] = useState('8');
  const [dpi, setDpi] = useState('300');
  const [exportFormat, setExportFormat] = useState('png');
  const [fileName, setFileName] = useState('');
  const [attrFontSize, setAttrFontSize] = useState('8');
  const [fontSize, setFontSize] = useState('11');

  const [plotData, setPlotData] = useState<any>(null);
  const [plotRev, setPlotRev] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const kind = plotKind(plotType);
  const preset = PRESETS[kind] || PRESETS.overview;
  const show = controlsFor(kind, colorBy);
  const needsSelection = kind !== 'sampling';
  const lastSelected = selectedStations[selectedStations.length - 1] || '';
  const timeseriesStation = selectedStations.includes(tsStation) ? tsStation : lastSelected;
  const plotIds = kind === 'timeseries'
    ? (timeseriesStation ? [timeseriesStation] : [])
    : selectedStations;
  const plotFrameRef = useRef<HTMLDivElement | null>(null);
  const plotlyGd = useRef<any>(null);
  const fetchGen = useRef(0);

  const effectiveDate = dateApplies(selectedDate, availableDates) ? selectedDate : 'All';
  const dateOptions = useMemo(() => {
    if (effectiveDate === 'All' || availableDates.some((d) => d.date === effectiveDate)) return availableDates;
    return [{ date: effectiveDate, label: effectiveDate }, ...availableDates];
  }, [availableDates, effectiveDate]);

  useEffect(() => { setSelectedDate(globalDate); }, [globalDate]);
  useEffect(() => {
    if (lastSelected) setTsStation(lastSelected);
  }, [lastSelected]);
  useEffect(() => {
    if (availableVars.length && !availableVars.includes(activeVar)) setActiveVar(availableVars[0]);
  }, [availableVars, activeVar]);
  useEffect(() => {
    setFigWidth(preset.w);
    setFigHeight(preset.h);
    if (kind === 'timeseries' || kind === 'history') setSelectedDate('All');
    if (kind === 'timeseries' && lastSelected) setTsStation(lastSelected);
    if (kind === 'timeseries' && availableVars.includes('Density') && secondaryVar === 'None') {
      setSecondaryVar('Density');
    }
  }, [plotType]);

  const stylePayload = () => ({
    selected_ids: plotIds,
    variable: activeVar,
    secondary_variable: secondaryVar,
    plot_type: plotType,
    date_filter: kind === 'timeseries' ? 'All' : effectiveDate,
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
    num_contour_lines: Number(numContours) || 15,
    num_density_lines: Number(numDensity) || 5,
    overlay_color: overlayColor,
    overlay_labels: overlayLabels,
    add_bathymetry: addBathy,
    bathymetry_style: bathyStyle,
    num_std: Number(numStd) || 1,
    marker_size: Number(markerSize) || 8,
    line_width: Number(lineWidth) || 2.5,
    paper: 'light',
    show_attribution: showAttribution,
    attribution_position: 'footer',
    attribution_fontsize: Number(attrFontSize) || 8,
    fontsize: Number(fontSize) || 11,
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
    const fs = Number(fontSize) || 11;

    if (plotData.plot_type === 'transect') {
      const isPixelMesh = plotType.includes('Pixel Mesh');
      const nLevels = Math.max(2, Number(numContours) || 15);
      const zmin = plotData.vmin;
      const zmax = plotData.vmax;
      const hasRange = zmin != null && zmax != null && Number(zmax) > Number(zmin);
      const filledContours = isPixelMesh ? {} : {
        ncontours: nLevels,
        autocontour: !hasRange,
        contours: hasRange
          ? {
              coloring: 'fill',
              showlines: false,
              start: Number(zmin),
              end: Number(zmax),
              size: (Number(zmax) - Number(zmin)) / nLevels,
            }
          : { coloring: 'fill', showlines: false },
      };
      const traces: any[] = [{
        z: plotData.z_primary,
        x: plotData.x_dist,
        y: plotData.y_depth,
        type: isPixelMesh ? 'heatmap' : 'contour',
        colorscale: plotData.colorscale || 'Viridis',
        zmin: plotData.vmin ?? undefined,
        zmax: plotData.vmax ?? undefined,
        cliponaxis: true,
        ...filledContours,
        colorbar: {
          title: {
            text: colorbarLabel || `${plotData.primary_var} (${plotData.units_primary})`,
            font: { color: '#143028', size: fs },
            side: 'right',
          },
          tickfont: { color: '#143028', size: fs },
          titlefont: { color: '#143028', size: fs },
          len: 0.8,
          thickness: 16,
          outlinewidth: 0,
          x: 1.02,
          xpad: 12,
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
            labelfont: { color: overlayStroke, size: fs },
          },
          line: { color: overlayStroke, width: 1.6 },
        });
      }
      const xs: number[] = plotData.x_dist || [];
      const types: string[] = plotData.cast_types || [];
      const bathyX: number[] = plotData.bathy_dist || [];
      const bathyY: number[] = plotData.bathy_depth || [];
      if (addBathy && plotData.used_mask && bathyX.length > 1) {
        const yTop = Number(plotData.depth_min ?? 0);
        const yMax = Number(plotData.depth_max);
        const clipY = Number.isFinite(yMax)
          ? bathyY.map((y) => {
              if (y == null || !Number.isFinite(Number(y))) return y;
              const v = Number(y);
              const lo = Number.isFinite(yTop) ? yTop : 0;
              return Math.min(Math.max(v, lo), yMax);
            })
          : bathyY;
        if (bathyStyle === 'outline') {
          traces.push({
            x: bathyX,
            y: clipY,
            mode: 'lines',
            line: { color: '#111111', width: 1.8 },
            hoverinfo: 'skip',
            showlegend: false,
            cliponaxis: true,
            name: 'Bathymetry',
          });
        } else {
          traces.push({
            x: [...bathyX, bathyX[bathyX.length - 1], bathyX[0]],
            y: [...clipY, yMax, yMax],
            type: 'scatter',
            mode: 'lines',
            fill: 'toself',
            fillcolor: 'rgba(128,128,128,0.92)',
            line: { color: '#111111', width: 1.2 },
            hoverinfo: 'skip',
            showlegend: false,
            cliponaxis: true,
            name: 'Bathymetry',
          });
        }
      }
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

    if (plotData.plot_type === 'timeseries') {
      const nLevels = Math.max(2, Number(numContours) || 15);
      const zmin = plotData.vmin;
      const zmax = plotData.vmax;
      const hasRange = zmin != null && zmax != null && Number(zmax) > Number(zmin);
      const traces: any[] = [{
        z: plotData.z_primary,
        x: plotData.x_time,
        y: plotData.y_depth,
        type: 'contour',
        colorscale: plotData.colorscale || 'Viridis',
        zmin: plotData.vmin ?? undefined,
        zmax: plotData.vmax ?? undefined,
        ncontours: nLevels,
        autocontour: !hasRange,
        contours: hasRange
          ? {
              coloring: 'fill',
              showlines: false,
              start: Number(zmin),
              end: Number(zmax),
              size: (Number(zmax) - Number(zmin)) / nLevels,
            }
          : { coloring: 'fill', showlines: false },
        colorbar: {
          title: {
            text: colorbarLabel || `${plotData.primary_var} (${plotData.units_primary})`,
            font: { color: '#143028', size: fs },
            side: 'right',
          },
          tickfont: { color: '#143028', size: fs },
          titlefont: { color: '#143028', size: fs },
          len: 0.8,
          thickness: 16,
          outlinewidth: 0,
          x: 1.02,
          xpad: 12,
        },
      }];
      if (plotData.z_secondary && secondaryVar !== 'None') {
        const overlayStroke = overlayColor === 'white' ? '#ffffff' : '#000000';
        traces.push({
          z: plotData.z_secondary,
          x: plotData.x_time,
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
            labelfont: { color: overlayStroke, size: fs },
          },
          line: { color: overlayStroke, width: 1.6 },
        });
      }
      const xs: string[] = plotData.x_time || [];
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
      const color = plotData.color || variableColor(plotData.variable || activeVar);
      return (plotData.traces || []).map((t: any) => ({
        x: t.x,
        y: t.y,
        mode: 'lines',
        name: t.latest ? `Most recent (${t.date})` : t.date,
        showlegend: !!t.latest,
        hoverinfo: 'name',
        line: { color, width: t.latest ? lineW : 1 },
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
            title: {
              text: colorbarLabel || plotData.colorbar_title || '',
              font: { color: '#143028', size: fs },
              side: 'right',
            },
            tickfont: { color: '#143028', size: fs },
            thickness: 16,
            outlinewidth: 0,
            x: 1.02,
            xpad: 12,
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

    if (plotData.plot_type === 'history') {
      return (plotData.series || []).map((s: any) => ({
        x: s.times,
        y: (s.times || []).map(() => s.name),
        mode: 'markers',
        name: s.name,
        showlegend: false,
        marker: {
          symbol: s.kind === 'unassigned' ? 'triangle-down' : 'hexagon',
          size: 12,
          color: s.kind === 'unassigned'
            ? (plotData.unassigned_color || UNASSIGNED_COLOR)
            : (plotData.station_color || STATION_COLOR),
          line: { color: '#143028', width: 1 },
        },
      }));
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
    const fs = Number(fontSize) || 11;
    const axis = {
      color: '#143028',
      gridcolor: '#e2ebe7',
      zerolinecolor: '#c5d4cc',
      linecolor: '#143028',
      tickfont: { size: fs, color: '#143028' },
      title: { font: { size: fs, color: '#143028' } },
    };
    const viewKey = `${id}|${plotType}|${plotIds.join('|')}|${effectiveDate}|${activeVar}|${depthMin}|${depthMax}|${fs}`;
    const depthRange = (plotData?.depth_max != null)
      ? [plotData.depth_max, plotData.depth_min ?? 0]
      : undefined;
    const legendFont = { font: { size: fs, color: '#143028' }, bgcolor: 'rgba(255,255,255,0.85)', borderwidth: 0 };
    const axisTitle = (text: string) => ({ text, font: { size: fs, color: '#143028' } });
    const base: any = {
      autosize: true,
      margin: { t: 40, b: showAttribution ? 56 : 40, l: 56, r: show.colorbar ? 96 : 30 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      font: { color: '#143028', size: fs },
      uirevision: viewKey,
      xaxis: { ...axis },
      yaxis: { ...axis },
      legend: legendFont,
      title: title ? { text: title, font: { size: fs + 3 } } : undefined,
    };

    if (plotData?.plot_type === 'transect') {
      const xs: number[] = plotData.x_dist || [];
      const types: string[] = plotData.cast_types || [];
      const names: string[] = plotData.stations || [];
      const lastCast = xs.length ? Number(xs[xs.length - 1]) : 1;
      const bathyX: number[] = plotData.bathy_dist || [];
      const lastBathy = addBathy && bathyX.length ? Number(bathyX[bathyX.length - 1]) : lastCast;
      const lastX = Math.max(lastCast || 1, Number.isFinite(lastBathy) ? lastBathy : 0, 1);
      const hasStationLabels = types.some((t, i) => t === 'station' && stationTopLabel(names[i]));
      const heading = title || plotData.title;
      return {
        ...base,
        margin: {
          ...base.margin,
          t: heading ? (hasStationLabels ? 96 : 64) : (hasStationLabels ? 56 : 40),
        },
        title: heading ? { text: heading, font: { size: fs + 3 } } : undefined,
        xaxis: {
          ...axis,
          title: axisTitle(xlabel || 'Distance along transect (km)'),
          range: [0, lastX],
        },
        yaxis: {
          ...axis,
          title: axisTitle(ylabel || 'Depth (m)'),
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
            font: { size: fs, color: '#143028' },
          }];
        }),
      };
    }
    if (plotData?.plot_type === 'timeseries') {
      const xs: string[] = plotData.x_time || [];
      const heading = title || plotData.title;
      return {
        ...base,
        margin: {
          ...base.margin,
          t: heading ? 64 : 40,
          r: 96,
        },
        title: heading ? { text: heading, font: { size: fs + 3 } } : undefined,
        xaxis: {
          ...axis,
          type: 'date',
          title: axisTitle(xlabel || ''),
        },
        yaxis: {
          ...axis,
          title: axisTitle(ylabel || 'Depth (m)'),
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
        showlegend: false,
      };
    }
    if (plotData?.plot_type === 'overview' || plotData?.plot_type === 'profile' || plotData?.plot_type === 'seasonal') {
      return {
        ...base,
        showlegend: plotData.plot_type !== 'overview',
        legend: plotData.plot_type === 'profile'
          ? { ...legendFont, x: 0.98, y: 0.02, xanchor: 'right', yanchor: 'bottom' }
          : legendFont,
        xaxis: { ...axis, title: axisTitle(xlabel || `${plotData.variable} (${plotData.units})`) },
        yaxis: {
          ...axis,
          title: axisTitle(ylabel || 'Depth (m)'),
          autorange: depthRange ? false : 'reversed',
          range: depthRange,
        },
      };
    }
    if (plotData?.plot_type === 'ts') {
      const xs: number[] = plotData.salinity || [];
      const ys: number[] = plotData.temperature || [];
      let xmin = Infinity;
      let xmax = -Infinity;
      let ymin = Infinity;
      let ymax = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        const y = ys[i];
        if (x != null && Number.isFinite(x)) {
          xmin = Math.min(xmin, x);
          xmax = Math.max(xmax, x);
        }
        if (y != null && Number.isFinite(y)) {
          ymin = Math.min(ymin, y);
          ymax = Math.max(ymax, y);
        }
      }
      const xspan = Math.max(xmax - xmin, 1e-6);
      const yspan = Math.max(ymax - ymin, 1e-6);
      const padX = xspan * 0.06;
      const padY = yspan * 0.06;
      const x0 = xmin - padX;
      const x1 = xmax + padX;
      const y0 = ymin - padY;
      const y1 = ymax + padY;
      return {
        ...base,
        margin: { ...base.margin, r: plotData.color_mode === 'season' ? 24 : 88, t: 40, b: 48, l: 56 },
        xaxis: {
          ...axis,
          title: axisTitle(xlabel || 'Practical Salinity (psu)'),
          range: Number.isFinite(x0) ? [x0, x1] : undefined,
        },
        yaxis: {
          ...axis,
          title: axisTitle(ylabel || 'Temperature (°C)'),
          autorange: false,
          range: Number.isFinite(y0) ? [y0, y1] : undefined,
          scaleanchor: 'x',
          scaleratio: (x1 - x0) / (y1 - y0),
          constrain: 'domain',
        },
        showlegend: plotData.color_mode === 'season',
        legend: {
          ...legendFont,
          x: 0.98,
          y: 0.98,
          xanchor: 'right',
          yanchor: 'top',
        },
      };
    }
    if (plotData?.plot_type === 'sampling') {
      return {
        ...base,
        barmode: 'stack',
        showlegend: true,
        legend: legendFont,
        xaxis: { ...axis, title: axisTitle(xlabel || 'Date') },
        yaxis: { ...axis, title: axisTitle(ylabel || '# of casts'), autorange: true },
      };
    }
    if (plotData?.plot_type === 'history') {
      const labels = (plotData.series || []).map((s: any) => s.name);
      const heading = title || `Total # of casts: ${plotData.n_casts ?? 0}`;
      return {
        ...base,
        margin: { ...base.margin, t: 64, l: 120 },
        title: { text: heading, font: { size: fs + 3 } },
        showlegend: false,
        xaxis: {
          ...axis,
          type: 'date',
          title: axisTitle(xlabel || ''),
        },
        yaxis: {
          ...axis,
          title: axisTitle(ylabel || ''),
          type: 'category',
          categoryorder: 'array',
          categoryarray: labels,
        },
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
        layout[xkey] = { ...axis, title: axisTitle(variableXLabel(p.variable, p.units)) };
        layout[ykey] = { ...axis, title: axisTitle('Count') };
      });
      return layout;
    }
    return base;
  };

  const layoutWithAttribution = () => {
    const layout = generateLayout();
    const text = plotData?.attribution;
    if (!showAttribution || !text) return layout;
    const axisFs = Number(fontSize) || 11;
    const attrFs = Number(attrFontSize) || 8;
    const wrapped = wrapAttribution(text, 52);
    const nlines = wrapped.split('<br>').length;
    const xlabelRoom = Math.round(axisFs * 2.5 + 32);
    const attrRoom = nlines * (attrFs + 6) + 10;
    const next: any = {
      ...layout,
      margin: { ...layout.margin, b: xlabelRoom + attrRoom },
      annotations: [
        ...(layout.annotations || []),
        {
          text: wrapped,
          xref: 'paper',
          yref: 'paper',
          x: 0.5,
          y: 0,
          xanchor: 'center',
          yanchor: 'top',
          yshift: -xlabelRoom,
          showarrow: false,
          font: { size: attrFs, color: '#143028', style: 'italic' },
          align: 'center',
        },
      ],
    };
    for (const key of Object.keys(next)) {
      if (key === 'xaxis' || /^xaxis\d+$/.test(key)) {
        const ax = next[key] || {};
        const title = typeof ax.title === 'object' && ax.title ? ax.title : { text: ax.title };
        next[key] = { ...ax, automargin: false, title: { ...title, standoff: 12 } };
      }
    }
    return next;
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
      const Plotly = (window as any).Plotly;
      const gd = plotlyGd.current || plotFrameRef.current?.querySelector('.js-plotly-plot');
      if (!gd || !Plotly?.toImage) throw new Error('Plot is not ready yet.');
      const d = Number(dpi) || 300;
      const scale = Math.max(1, d / 96);
      const cssW = Math.max(1, gd._fullLayout?.width || gd.clientWidth || 800);
      const cssH = Math.max(1, gd._fullLayout?.height || gd.clientHeight || 600);
      const width = Math.round(cssW * scale);
      const height = Math.round(cssH * scale);
      const fmt = exportFormat === 'pdf' ? 'jpeg' : exportFormat;
      const img = await Plotly.toImage(gd, { format: fmt, width: cssW, height: cssH, scale });
      let blob: Blob;
      if (exportFormat === 'pdf') {
        blob = jpegDataUrlToPdf(img, width, height, d);
      } else {
        blob = await (await fetch(img)).blob();
      }
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
          {show.bathymetry && (
            <label className="check" title={plotData?.used_mask ? (plotData.bathy_name || 'Bathymetry') : 'No bathymetry raster covers this transect'}>
              <input
                type="checkbox"
                checked={addBathy}
                onChange={(e) => setAddBathy(e.target.checked)}
                disabled={!plotData?.used_mask}
              />
              Add bathymetry
            </label>
          )}
          {show.bathymetry && addBathy && plotData?.used_mask && (
            <div className="heat-toggle overlay-color">
              <button type="button" className={bathyStyle === 'filled' ? 'on' : ''} onClick={() => setBathyStyle('filled')}>
                Filled
              </button>
              <button type="button" className={bathyStyle === 'outline' ? 'on' : ''} onClick={() => setBathyStyle('outline')}>
                Outline
              </button>
            </div>
          )}
          {show.station && (
            <select
              className="select"
              value={timeseriesStation}
              onChange={(e) => setTsStation(e.target.value)}
              disabled={!selectedStations.length}
            >
              {!selectedStations.length && <option value="">Select a station</option>}
              {selectedStations.map((id, i) => (
                <option key={id} value={id}>{selectedLabels[i] || id}</option>
              ))}
            </select>
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
          <div className="plot-area">
            <div
              className="plot-frame"
              ref={plotFrameRef}
              style={{
                ['--plot-w']: String(Number(figWidth) || preset.w),
                ['--plot-h']: String(Number(figHeight) || preset.h),
              } as CSSProperties}
            >
              <Plot
                key={`plot-${plotRev}-${plotData.plot_type}-${overlayColor}-${overlayLabels}-${numDensity}-${numContours}-${addBathy}-${bathyStyle}`}
                data={generatePlotlyTraces()}
                layout={layoutWithAttribution()}
                config={{ responsive: true, displayModeBar: true }}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
                onInitialized={(_fig: any, gd: any) => { plotlyGd.current = gd; }}
                onUpdate={(_fig: any, gd: any) => { plotlyGd.current = gd; }}
              />
              {loading && <div className="plot-updating">Updating…</div>}
            </div>
          </div>
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
          <label>Font size<input className="input" type="number" min="8" max="28" step="1" value={fontSize} onChange={(e) => setFontSize(e.target.value)} /></label>
          {show.colorbar && <label>Colorbar label<input className="input" value={colorbarLabel} onChange={(e) => setColorbarLabel(e.target.value)} /></label>}
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
          {show.contours && !plotType.includes('Pixel') && (
            <label>Number of colors<input className="input" value={numContours} onChange={(e) => setNumContours(e.target.value)} /></label>
          )}
          {show.contours && secondaryVar !== 'None' && (
            <label>Number of lines<input className="input" value={numDensity} onChange={(e) => setNumDensity(e.target.value)} /></label>
          )}
          {show.std && <label>Std-dev band<input className="input" value={numStd} onChange={(e) => setNumStd(e.target.value)} /></label>}
          {show.marker && <label>Marker size<input className="input" value={markerSize} onChange={(e) => setMarkerSize(e.target.value)} /></label>}
          {show.line && <label>Line width<input className="input" value={lineWidth} onChange={(e) => setLineWidth(e.target.value)} /></label>}
          <label>Figure width<input className="input" value={figWidth} onChange={(e) => setFigWidth(e.target.value)} /></label>
          <label>Figure height<input className="input" value={figHeight} onChange={(e) => setFigHeight(e.target.value)} /></label>
          <label>DPI
            <select className="select" value={dpi} onChange={(e) => setDpi(e.target.value)}>
              <option value="300">300</option>
              <option value="600">600</option>
              <option value="1000">1000</option>
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
          <label>Attribution size<input className="input" value={attrFontSize} onChange={(e) => setAttrFontSize(e.target.value)} /></label>
          <div className="studio-actions">
            <span className="muted">Save is this figure, at {dpi} DPI.</span>
          </div>
        </div>
      )}
    </div>
  );
}
