import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Polyline, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

const STATION_COLOR = '#2d6a4f';
const UNASSIGNED_COLOR = '#e07a2f';

interface MapProps {
  stations: any[];
  selectedIds: string[];
  showLine: boolean;
  drawTransect: boolean;
  showStations: boolean;
  showUnassigned: boolean;
  onDrawTransect: (on: boolean) => void;
  onShowStations: (on: boolean) => void;
  onShowUnassigned: (on: boolean) => void;
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

function isUnassignedStation(st: any) {
  return st.kind === 'unassigned' || (!st.kind && (st.color === '#0077b6' || st.color === '#72aebb' || st.color === UNASSIGNED_COLOR));
}

function markerFill(st: any) {
  return isUnassignedStation(st) ? UNASSIGNED_COLOR : STATION_COLOR;
}

function markerTooltip(st: any, isSelected: boolean, selectedIndex: number, selectedCount: number) {
  const nation = st.community && st.community !== 'Unknown' && st.community !== 'nan'
    ? st.community
    : null;
  return (
    <div>
      <b>{st.short_label || st.label}</b>
      {nation && <div style={{ fontSize: '0.85em', color: '#2d6a4f' }}>{nation}</div>}
      {isSelected && selectedCount > 1 && (
        <div style={{ color: '#0077b6', fontWeight: 600 }}>#{selectedIndex + 1}</div>
      )}
    </div>
  );
}

export default function MapView({
  stations,
  selectedIds,
  showLine,
  drawTransect,
  showStations,
  showUnassigned,
  onDrawTransect,
  onShowStations,
  onShowUnassigned,
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
          return (
            <CircleMarker
              key={`${st.id}-${i}`}
              center={[st.lat, st.lon]}
              radius={isSelected ? 10 : 7}
              pathOptions={{
                color: isSelected ? '#00b4d8' : markerFill(st),
                fillColor: isSelected ? '#00b4d8' : markerFill(st),
                opacity: 1,
                fillOpacity: 0.4,
                weight: isSelected ? 3 : 2,
              }}
              eventHandlers={{
                click: (e) => onStationSelect(st.id, !!(e.originalEvent as MouseEvent)?.shiftKey),
              }}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                {markerTooltip(st, isSelected, selectedIndex, selectedIds.length)}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
