import { useEffect, useMemo, useState } from 'react';
import MapView from './Map';
import PlotWidget from './PlotWidget';
import DateHeatmap from './DateHeatmap';

const DEFAULT_FOLDER = '/Users/ebeaudin/Desktop/CF/data-test';

export default function App() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string>(DEFAULT_FOLDER);
  const [loading, setLoading] = useState<boolean>(false);

  const [selectedStations, setSelectedStations] = useState<string[]>([]);
  const [dateFilter, setDateFilter] = useState<string>('All');
  const [selectedNation, setSelectedNation] = useState<string>('All');
  const [heatMode, setHeatMode] = useState<'display' | 'selection'>('display');
  const [drawTransect, setDrawTransect] = useState<boolean>(false);
  const [showStations, setShowStations] = useState<boolean>(true);
  const [showUnassigned, setShowUnassigned] = useState<boolean>(true);
  const [mode, setMode] = useState<'explore' | 'studio'>('explore');

  const communityStations = useMemo(() => {
    return (data?.stations || []).filter((st: any) => (
      selectedNation === 'All' ||
      (st.community && st.community.toLowerCase().includes(selectedNation.toLowerCase()))
    ));
  }, [data, selectedNation]);

  const filteredStations = useMemo(() => {
    return communityStations.filter((st: any) => {
      const matchesDate = dateFilter === 'All' || (st.dates || []).some((d: string) => d.startsWith(dateFilter));
      const isUnassigned = st.kind === 'unassigned' || (!st.kind && st.color === '#0077b6');
      const matchesKind = isUnassigned ? showUnassigned : showStations;
      return matchesDate && matchesKind;
    });
  }, [communityStations, dateFilter, showStations, showUnassigned]);

  const heatmapStations = heatMode === 'selection'
    ? communityStations.filter((st: any) => selectedStations.includes(st.id))
    : communityStations;

  const mapFocus = useMemo(() => {
    if (selectedNation === 'All' || !communityStations.length) return null;
    return {
      token: selectedNation,
      lats: communityStations.map((st: any) => st.lat),
      lons: communityStations.map((st: any) => st.lon),
    };
  }, [selectedNation, communityStations]);

  const fetchSummary = () => {
    fetch('/api/summary')
      .then((res) => res.json())
      .then((json) => {
        setData(json);
        if (json.default_folder) setFolderPath(json.default_folder);
        setError(null);
      })
      .catch((err) => setError(err.message));
  };

  useEffect(() => { fetchSummary(); }, []);

  const handleFolderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    fetch('/api/load_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
    })
      .then(async (res) => {
        const resData = await res.json();
        if (!res.ok) throw new Error(resData.detail || 'Failed to load folder');
        setSelectedStations([]);
        fetchSummary();
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const handleStationClick = (id: string, shiftKey: boolean) => {
    if (shiftKey) {
      setSelectedStations((prev) => (prev.includes(id) ? prev.filter((st) => st !== id) : [...prev, id]));
      return;
    }
    setSelectedStations([id]);
  };

  const selectedLabels = selectedStations.map((id) => {
    const st = (data?.stations || []).find((s: any) => s.id === id);
    return st?.short_label || st?.label || id;
  });

  const selectedDates = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const st of data?.stations || []) {
      if (!selectedStations.includes(st.id)) continue;
      for (const d of st.cast_dates || st.dates || []) {
        if (!d || d === 'Unknown') continue;
        counts[d] = (counts[d] || 0) + 1;
      }
    }
    return Object.keys(counts).sort().map((d) => ({
      date: d,
      label: `${d} (${counts[d]} cast${counts[d] === 1 ? '' : 's'})`,
    }));
  }, [data, selectedStations]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Community Fishers</h1>
        <p className="subtitle">Plot Studio</p>

        <form onSubmit={handleFolderSubmit} style={{ marginBottom: 15 }}>
          <label className="field-label">Data folder</label>
          <input
            className="input"
            type="text"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <button type="submit" className="btn btn-ocean" disabled={loading}>
            {loading ? 'Scanning…' : 'Load folder'}
          </button>
        </form>

        {error && <div className="error-box">{error}</div>}

        <label className="field-label">Nation / community</label>
        <select
          className="select"
          value={selectedNation}
          onChange={(e) => setSelectedNation(e.target.value)}
          style={{ marginBottom: 14 }}
        >
          <option value="All">All communities</option>
          {data?.nations?.map((n: string) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>

        <div className="panel">
          <DateHeatmap
            stations={heatmapStations}
            dateFilter={dateFilter}
            onSelect={setDateFilter}
            mode={heatMode}
            onMode={setHeatMode}
            selectionEmpty={selectedStations.length === 0}
          />
        </div>

        <div className="panel" style={{ marginBottom: 0 }}>
          <strong>Selected ({selectedStations.length})</strong>
          <p className="muted" style={{ margin: '6px 0' }}>
            Click a station. Shift-click to add. The calendar date is the plot date until you change it in Studio.
          </p>
          <ol style={{ paddingLeft: 20, margin: '8px 0' }}>
            {selectedLabels.map((label, i) => <li key={selectedStations[i]}>{label}</li>)}
          </ol>
          <button type="button" className="btn btn-danger" onClick={() => setSelectedStations([])}>
            Clear selection
          </button>
        </div>
      </aside>

      <div className={`main mode-${mode}`}>
        <div className="mode-bar">
          <div className="heat-toggle">
            <button type="button" className={mode === 'explore' ? 'on' : ''} onClick={() => setMode('explore')}>
              Explore
            </button>
            <button type="button" className={mode === 'studio' ? 'on' : ''} onClick={() => setMode('studio')}>
              Studio
            </button>
          </div>
          <span className="muted">
            {mode === 'explore'
              ? (dateFilter === 'All' ? 'All dates on the map' : `Map date: ${dateFilter}`)
              : 'Working on one figure'}
          </span>
        </div>

        <div className="map-pane">
          <MapView
            stations={filteredStations}
            selectedIds={selectedStations}
            showLine={drawTransect && selectedStations.length > 1}
            drawTransect={drawTransect}
            showStations={showStations}
            showUnassigned={showUnassigned}
            onDrawTransect={setDrawTransect}
            onShowStations={setShowStations}
            onShowUnassigned={setShowUnassigned}
            focus={mapFocus}
            active={mode === 'explore'}
            onStationSelect={handleStationClick}
          />
        </div>

        <div className="widget-pane">
          {data && (
            <PlotWidget
              id="main-plot"
              availableVars={data.variables || []}
              availablePlotTypes={data.plot_types || []}
              availableDates={selectedDates}
              selectedStations={selectedStations}
              globalDate={dateFilter}
              visible={mode === 'studio'}
            />
          )}
        </div>
      </div>
    </div>
  );
}
