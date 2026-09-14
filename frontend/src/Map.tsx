import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Polyline, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

const STATION_COLOR = '#2d6a4f';
const UNASSIGNED_COLOR = '#e07a2f';
const SELECTED_COLOR = '#00b4d8';

const MONTH_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const GRID_W = 216;
const LABEL_W = 32;
const MONTH_H = 12;

function dayOfYear(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

function isUnassignedStation(st: any) {
  return st.kind === 'unassigned' || (!st.kind && (st.color === '#0077b6' || st.color === '#72aebb' || st.color === UNASSIGNED_COLOR));
}

function markerFill(st: any) {
  return isUnassignedStation(st) ? UNASSIGNED_COLOR : STATION_COLOR;
}

function SamplingMiniGrid({ dates, color }: { dates: string[]; color: string }) {
  const samples: { year: number; doy: number }[] = [];
  const seen = new Set<string>();
  for (const d of dates) {
    if (!d || d === 'Unknown' || d.length < 10 || seen.has(d)) continue;
    seen.add(d);
    const year = Number(d.slice(0, 4));
    const doy = dayOfYear(d);
    if (!year || !doy) continue;
    samples.push({ year, doy });
  }
  if (!samples.length) return null;

  const minYear = Math.min(...samples.map((s) => s.year));
  const maxYear = Math.max(...samples.map((s) => s.year));
  const years: number[] = [];
  for (let y = minYear; y <= maxYear; y++) years.push(y);
  const gridH = Math.max(72, Math.min(110, years.length * 12));
  const rowH = gridH / years.length;
  const sq = Math.max(3.2, Math.min(5, rowH - 1.2));
  const yearIndex = new Map(years.map((y, i) => [y, i]));
  const svgW = LABEL_W + GRID_W + 1;
  const svgH = gridH + MONTH_H + 2;

  return (
    <svg className="tip-grid" width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} aria-hidden>
      <rect x={LABEL_W} y={0} width={GRID_W} height={gridH} fill="#f4f7f6" rx="2" />
      {MONTH_STARTS.map((doy, i) => {
        const x = LABEL_W + ((doy - 1) / 365) * GRID_W;
        return (
          <g key={MONTH_LABELS[i] + i}>
            <line x1={x} y1={0} x2={x} y2={gridH} stroke="#d7e3de" strokeWidth="0.8" />
            <text
              x={x + (GRID_W / 24)}
              y={gridH + 10}
              textAnchor="middle"
              fontSize="10"
              fill="#5a7268"
            >
              {MONTH_LABELS[i]}
            </text>
          </g>
        );
      })}
      {years.map((y, i) => (
        <g key={y}>
          {i > 0 && (
            <line
              x1={LABEL_W}
              y1={i * rowH}
              x2={LABEL_W + GRID_W}
              y2={i * rowH}
              stroke="#e2ebe7"
              strokeWidth="0.7"
            />
          )}
          <text
            x={LABEL_W - 3}
            y={i * rowH + rowH / 2}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize="10"
            fill="#5a7268"
          >
            {y}
          </text>
        </g>
      ))}
      {samples.map((s) => {
        const xi = LABEL_W + ((s.doy - 1) / 365) * GRID_W - sq / 2;
        const yi = (yearIndex.get(s.year) ?? 0) * rowH + rowH / 2 - sq / 2;
        return (
          <rect
            key={`${s.year}-${s.doy}`}
            x={xi}
            y={yi}
            width={sq}
            height={sq}
            fill={color}
            fillOpacity={0.5}
          />
        );
      })}
    </svg>
  );
}

function markerTooltip(
  st: any,
  isSelected: boolean,
  selectedIndex: number,
  selectedCount: number,
  showTimeline: boolean,
  pinColor: string,
) {
  const nation = st.community && st.community !== 'Unknown' && st.community !== 'nan'
    ? st.community
    : null;
  return (
    <div className="marker-tip">
      <b>{st.short_label || st.label}</b>
      {nation && <div className="marker-tip-nation">{nation}</div>}
      {isSelected && selectedCount > 1 && (
        <div className="marker-tip-order">#{selectedIndex + 1}</div>
      )}
      {showTimeline && (
        <SamplingMiniGrid
          dates={st.cast_dates || st.dates || []}
          color={pinColor}
        />
      )}
    </div>
  );
}

interface MapProps {
  stations: any[];
  selectedIds: string[];
  showLine: boolean;
  drawTransect: boolean;
  showStations: boolean;
  showUnassigned: boolean;
  showTimeline: boolean;
  onDrawTransect: (on: boolean) => void;
  onShowStations: (on: boolean) => void;
  onShowUnassigned: (on: boolean) => void;
  onShowTimeline: (on: boolean) => void;
  focus?: { lats: number[]; lons: number[]; token: string } | null;
  active?: boolean;
  onStationSelect: (id: string, shiftKey: boolean) => void;
}

function MapFocus({ focus }: { focus?: { lats: number[]; lons: number[]; token: string } | null }) {
  const map = useMap();
  const last = useRef<string>('');

  useEffect(() => {
    if (!focus?.token || focus.token === last.current) return;
    if (!focus.lats.length) return;
    last.current = focus.token;
    const south = Math.min(...focus.lats);
    const north = Math.max(...focus.lats);
    const west = Math.min(...focus.lons);
    const east = Math.max(...focus.lons);
    if (south === north && west === east) {
      map.flyTo([south, west], 9, { duration: 0.7 });
      return;
    }
    map.flyToBounds([[south, west], [north, east]], { padding: [36, 36], maxZoom: 10, duration: 0.7 });
  }, [focus, map]);

  return null;
}

function MapResize({ active }: { active: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => map.invalidateSize(), 80);
    return () => window.clearTimeout(t);
  }, [active, map]);
  return null;
}

export default function MapView({
  stations,
  selectedIds,
  showLine,
  drawTransect,
  showStations,
  showUnassigned,
  showTimeline,
  onDrawTransect,
  onShowStations,
  onShowUnassigned,
  onShowTimeline,
  focus,
  active = true,
  onStationSelect,
}: MapProps) {
  const transectCoords: [number, number][] = selectedIds
    .map((id) => {
      const st = stations.find((s) => s.id === id);
      return st ? [st.lat, st.lon] as [number, number] : null;
    })
    .filter((coord): coord is [number, number] => coord !== null);

  const center: [number, number] = stations.length
    ? [stations[0].lat, stations[0].lon]
    : [54.3, -130.4];

  return (
    <div className="map-wrap">
      <div className="map-toolbar">
        <label className="check">
          <input type="checkbox" checked={drawTransect} onChange={(e) => onDrawTransect(e.target.checked)} />
          Draw transect
        </label>
        <label className="check">
          <input type="checkbox" checked={showStations} onChange={(e) => onShowStations(e.target.checked)} />
          Stations
        </label>
        <label className="check">
          <input type="checkbox" checked={showUnassigned} onChange={(e) => onShowUnassigned(e.target.checked)} />
          Unassigned
        </label>
        <label className="check">
          <input type="checkbox" checked={showTimeline} onChange={(e) => onShowTimeline(e.target.checked)} />
          Sampling timeline
        </label>
      </div>
      <MapContainer center={center} zoom={4} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <MapFocus focus={focus} />
        <MapResize active={active} />

        {showLine && transectCoords.length > 1 && (
          <Polyline
            positions={transectCoords}
            pathOptions={{ color: '#00b4d8', weight: 4, opacity: 0.85, dashArray: '8, 8' }}
          />
        )}

        {stations.map((st, i) => {
          const isSelected = selectedIds.includes(st.id);
          const selectedIndex = selectedIds.indexOf(st.id);
          const pinColor = isSelected ? SELECTED_COLOR : markerFill(st);
          return (
            <CircleMarker
              key={`${st.id}-${i}`}
              center={[st.lat, st.lon]}
              radius={isSelected ? 10 : 7}
              pathOptions={{
                color: pinColor,
                fillColor: pinColor,
                opacity: 1,
                fillOpacity: 0.4,
                weight: isSelected ? 3 : 2,
              }}
              eventHandlers={{
                click: (e) => onStationSelect(st.id, !!(e.originalEvent as MouseEvent)?.shiftKey),
              }}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={1} className="marker-tip-wrap">
                {markerTooltip(st, isSelected, selectedIndex, selectedIds.length, showTimeline, pinColor)}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
