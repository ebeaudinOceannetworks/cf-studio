import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Polyline, Rectangle, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { STATION_COLOR, UNASSIGNED_COLOR, isUnassignedStation } from './colors';

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

function markerFill(st: any) {
  if (st.color) return st.color;
  return isUnassignedStation(st) ? UNASSIGNED_COLOR : STATION_COLOR;
}

function stackKey(lat: number, lon: number) {
  return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

function groupStations(stations: any[]) {
  const groups = new Map<string, { key: string; lat: number; lon: number; members: any[] }>();
  for (const st of stations) {
    const key = stackKey(st.lat, st.lon);
    const g = groups.get(key);
    if (g) g.members.push(st);
    else groups.set(key, { key, lat: st.lat, lon: st.lon, members: [st] });
  }
  return [...groups.values()];
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
  showBathyCoverage: boolean;
  bathyCoverages?: { name: string; bounds: [[number, number], [number, number]] }[];
  bathySkipped?: { name: string; size_mb: number; max_mb: number; reason: string }[];
  maxBathyMb?: number;
  onDrawTransect: (on: boolean) => void;
  onShowStations: (on: boolean) => void;
  onShowUnassigned: (on: boolean) => void;
  onShowTimeline: (on: boolean) => void;
  onShowBathyCoverage: (on: boolean) => void;
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

function MapClickClose({ onClose }: { onClose: () => void }) {
  useMapEvents({
    click: () => onClose(),
  });
  return null;
}

function stopMarkerClick(e: any) {
  L.DomEvent.stopPropagation(e);
  const orig = e.originalEvent as MouseEvent | undefined;
  orig?.stopPropagation();
}

function StationPin({
  st,
  center,
  selectedIds,
  showTimeline,
  onStationSelect,
}: {
  st: any;
  center?: [number, number];
  selectedIds: string[];
  showTimeline: boolean;
  onStationSelect: (id: string, shiftKey: boolean) => void;
}) {
  const isSelected = selectedIds.includes(st.id);
  const selectedIndex = selectedIds.indexOf(st.id);
  const pinColor = isSelected ? SELECTED_COLOR : markerFill(st);
  return (
    <CircleMarker
      center={center || [st.lat, st.lon]}
      radius={isSelected ? 10 : 7}
      pathOptions={{
        color: pinColor,
        fillColor: pinColor,
        opacity: 1,
        fillOpacity: 0.4,
        weight: isSelected ? 3 : 2,
      }}
      eventHandlers={{
        click: (e) => {
          stopMarkerClick(e);
          onStationSelect(st.id, !!(e.originalEvent as MouseEvent)?.shiftKey);
        },
      }}
    >
      <Tooltip direction="top" offset={[0, -10]} opacity={1} className="marker-tip-wrap">
        {markerTooltip(st, isSelected, selectedIndex, selectedIds.length, showTimeline, pinColor)}
      </Tooltip>
    </CircleMarker>
  );
}

function SpiderGroup({
  group,
  selectedIds,
  showTimeline,
  onStationSelect,
}: {
  group: { lat: number; lon: number; members: any[] };
  selectedIds: string[];
  showTimeline: boolean;
  onStationSelect: (id: string, shiftKey: boolean) => void;
}) {
  const map = useMap();
  const n = group.members.length;
  const [arms, setArms] = useState<[number, number][]>([]);

  const layout = () => {
    const origin = map.latLngToLayerPoint([group.lat, group.lon]);
    const R = Math.max(32, 20 + n * 5);
    const next: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      const ll = map.layerPointToLatLng(L.point(origin.x + R * Math.cos(a), origin.y + R * Math.sin(a)));
      next.push([ll.lat, ll.lng]);
    }
    setArms(next);
  };

  useEffect(layout, [group.lat, group.lon, n, map]);
  useMapEvents({ zoomend: layout, moveend: layout });

  return (
    <>
      <CircleMarker
        center={[group.lat, group.lon]}
        radius={4}
        pathOptions={{ color: '#5a7268', fillColor: '#5a7268', fillOpacity: 0.8, weight: 1 }}
        eventHandlers={{ click: stopMarkerClick }}
      />
      {group.members.map((st, i) => {
        const dest = arms[i] || [st.lat, st.lon];
        return (
          <Fragment key={st.id}>
            <Polyline
              positions={[[group.lat, group.lon], dest]}
              pathOptions={{ color: '#5a7268', weight: 1.5, opacity: 0.55 }}
            />
            <StationPin
              st={st}
              center={dest}
              selectedIds={selectedIds}
              showTimeline={showTimeline}
              onStationSelect={onStationSelect}
            />
          </Fragment>
        );
      })}
    </>
  );
}

export default function MapView({
  stations,
  selectedIds,
  showLine,
  drawTransect,
  showStations,
  showUnassigned,
  showTimeline,
  showBathyCoverage,
  bathyCoverages = [],
  bathySkipped = [],
  maxBathyMb = 100,
  onDrawTransect,
  onShowStations,
  onShowUnassigned,
  onShowTimeline,
  onShowBathyCoverage,
  focus,
  active = true,
  onStationSelect,
}: MapProps) {
  const [openStack, setOpenStack] = useState<string | null>(null);
  const [routedPath, setRoutedPath] = useState<[number, number][] | null>(null);
  const groups = useMemo(() => groupStations(stations), [stations]);

  const transectCoords: [number, number][] = selectedIds
    .map((id) => {
      const st = stations.find((s) => s.id === id);
      return st ? [st.lat, st.lon] as [number, number] : null;
    })
    .filter((coord): coord is [number, number] => coord !== null);

  useEffect(() => {
    if (!drawTransect || transectCoords.length < 2) {
      setRoutedPath(null);
      return;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      fetch('/api/draw-transect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stations: transectCoords }),
        signal: ac.signal,
      })
        .then(async (res) => {
          const json = await res.json();
          if (!res.ok) throw new Error(json.detail || 'Transect routing failed');
          if (json.used_mask && Array.isArray(json.path) && json.path.length > 1) {
            setRoutedPath(json.path.map((p: number[]) => [p[0], p[1]] as [number, number]));
          } else {
            setRoutedPath(null);
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          setRoutedPath(null);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [drawTransect, transectCoords.map((p) => p.join(',')).join('|')]);

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
        <label
          className="check"
          title={
            bathySkipped.length
              ? bathySkipped.map((item) => item.reason).join(' · ')
              : `GeoTIFFs up to ${maxBathyMb} MB`
          }
        >
          <input type="checkbox" checked={showBathyCoverage} onChange={(e) => onShowBathyCoverage(e.target.checked)} />
          Bathymetry coverage
        </label>
        {bathySkipped.length > 0 && (
          <span className="muted" title={bathySkipped.map((item) => item.reason).join('\n')}>
            skipped {bathySkipped.length} raster{bathySkipped.length === 1 ? '' : 's'} over {maxBathyMb} MB
          </span>
        )}
      </div>
      <MapContainer center={center} zoom={4} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <MapFocus focus={focus} />
        <MapResize active={active} />
        <MapClickClose onClose={() => setOpenStack(null)} />

        {showBathyCoverage && bathyCoverages.map((item) => (
          <Rectangle
            key={item.name}
            bounds={item.bounds}
            pathOptions={{ color: '#8b0000', weight: 2, fill: false }}
          />
        ))}
        {showLine && transectCoords.length > 1 && (
          <Polyline
            positions={routedPath && routedPath.length > 1 ? routedPath : transectCoords}
            pathOptions={{
              color: '#00b4d8',
              weight: 4,
              opacity: 0.85,
              dashArray: routedPath && routedPath.length > 1 ? undefined : '8, 8',
            }}
          />
        )}

        {groups.map((group) => {
          if (group.members.length === 1) {
            const st = group.members[0];
            return (
              <StationPin
                key={st.id}
                st={st}
                selectedIds={selectedIds}
                showTimeline={showTimeline}
                onStationSelect={onStationSelect}
              />
            );
          }
          if (openStack === group.key) {
            return (
              <SpiderGroup
                key={group.key}
                group={group}
                selectedIds={selectedIds}
                showTimeline={showTimeline}
                onStationSelect={onStationSelect}
              />
            );
          }
          const anySelected = group.members.some((st) => selectedIds.includes(st.id));
          const pinColor = anySelected ? SELECTED_COLOR : markerFill(group.members[0]);
          return (
            <CircleMarker
              key={group.key}
              center={[group.lat, group.lon]}
              radius={11}
              pathOptions={{
                color: pinColor,
                fillColor: pinColor,
                opacity: 1,
                fillOpacity: 0.45,
                weight: anySelected ? 3 : 2,
              }}
              eventHandlers={{
                click: (e) => {
                  stopMarkerClick(e);
                  setOpenStack(group.key);
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={1} className="marker-tip-wrap">
                <div className="marker-tip">
                  <b>{group.members.length} stations here</b>
                  <div className="marker-tip-nation">Click to spread the pins apart</div>
                </div>
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
