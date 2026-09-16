const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface HeatCell {
  casts: number;
  days: number;
}

function emptyGrid(): Record<number, Record<number, HeatCell>> {
  return {};
}

function addDate(grid: Record<number, Record<number, HeatCell>>, date: string, daySet: Record<string, Set<string>>) {
  const parts = date.split('-');
  if (parts.length < 2) return;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!year || !month) return;
  if (!grid[year]) grid[year] = {};
  if (!grid[year][month]) grid[year][month] = { casts: 0, days: 0 };
  grid[year][month].casts += 1;
  const key = `${year}-${month}`;
  if (!daySet[key]) daySet[key] = new Set();
  daySet[key].add(date);
}

function buildGrid(stations: any[]): { grid: Record<number, Record<number, HeatCell>>; years: number[]; maxCasts: number } {
  const grid = emptyGrid();
  const daySet: Record<string, Set<string>> = {};
  for (const st of stations) {
    for (const d of st.cast_dates || st.dates || []) addDate(grid, d, daySet);
  }
  for (const year of Object.keys(grid)) {
    for (const month of Object.keys(grid[Number(year)])) {
      const key = `${year}-${month}`;
      grid[Number(year)][Number(month)].days = daySet[key]?.size || 0;
    }
  }
  const years = Object.keys(grid).map(Number).sort((a, b) => a - b);
  let maxCasts = 1;
  for (const y of years) {
    for (let m = 1; m <= 12; m++) {
      maxCasts = Math.max(maxCasts, grid[y][m]?.casts || 0);
    }
  }
  return { grid, years, maxCasts };
}

function cellStyle(count: number, maxCasts: number) {
  if (!count) return { background: '#f4f7f6', color: 'transparent' };
  const t = Math.min(1, count / Math.max(1, maxCasts));
  const r = Math.round(214 - t * (214 - 27));
  const g = Math.round(232 - t * (232 - 80));
  const b = Math.round(210 - t * (210 - 50));
  return {
    background: `rgb(${r},${g},${b})`,
    color: t > 0.42 ? '#ffffff' : '#143028',
    fontWeight: 700,
  };
}

function dayCounts(stations: any[], yearMonth: string): { day: number; casts: number }[] {
  const counts = new Map<number, number>();
  for (const st of stations) {
    for (const d of st.cast_dates || st.dates || []) {
      if (!d.startsWith(yearMonth)) continue;
      const day = Number(d.slice(8, 10));
      if (!day) continue;
      counts.set(day, (counts.get(day) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([day, casts]) => ({ day, casts }));
}

interface Props {
  stations: any[];
  dateFilter: string;
  onSelect: (value: string) => void;
  mode: 'display' | 'selection';
  onMode: (mode: 'display' | 'selection') => void;
  selectionEmpty: boolean;
}

export default function DateHeatmap({ stations, dateFilter, onSelect, mode, onMode, selectionEmpty }: Props) {
  const { grid, years, maxCasts } = buildGrid(stations);
  const activeYear = dateFilter !== 'All' ? Number(dateFilter.slice(0, 4)) : null;
  const activeMonth = dateFilter.length >= 7 ? Number(dateFilter.slice(5, 7)) : null;
  const activeDay = dateFilter.length >= 10 ? dateFilter.slice(0, 10) : null;
  const monthKey = activeYear && activeMonth ? `${activeYear}-${String(activeMonth).padStart(2, '0')}` : null;
  const days = monthKey ? dayCounts(stations, monthKey) : [];
  const maxDay = days.reduce((n, d) => Math.max(n, d.casts), 1);

  return (
    <div className="heatmap">
      <div className="row-between" style={{ marginBottom: 8 }}>
        <strong>Sampling calendar</strong>
        <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '0.75rem' }} onClick={() => onSelect('All')}>
          All dates
        </button>
      </div>
      <div className="heat-toggle">
        <button type="button" className={mode === 'display' ? 'on' : ''} onClick={() => onMode('display')}>Display</button>
        <button type="button" className={mode === 'selection' ? 'on' : ''} onClick={() => onMode('selection')}>Selection</button>
      </div>
      <p className="muted" style={{ margin: '6px 0 8px' }}>
        {dateFilter === 'All' ? 'All dates' : dateFilter}
        {mode === 'selection' && selectionEmpty ? ' — select casts to fill the grid' : ''}
      </p>
      {years.length === 0 ? (
        <p className="muted">No sampling days in this view.</p>
      ) : (
        <div className="heat-grid">
          <div className="heat-row heat-head">
            <span className="heat-year" />
            {MONTHS.map((m, i) => <span key={m + i} className="heat-cell head">{m}</span>)}
          </div>
          {years.map((year) => (
            <div key={year} className="heat-row">
              <button
                type="button"
                className={`heat-year${activeYear === year && !activeMonth ? ' active' : ''}`}
                onClick={() => onSelect(String(year))}
              >
                {year}
              </button>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
                const cell = grid[year]?.[month];
                const count = cell?.casts || 0;
                const value = `${year}-${String(month).padStart(2, '0')}`;
                const active = dateFilter.startsWith(value);
                return (
                  <button
                    key={value}
                    type="button"
                    className={`heat-cell${active ? ' active' : ''}${count ? '' : ' empty'}`}
                    style={cellStyle(count, maxCasts)}
                    title={`${MONTH_NAMES[month - 1]} ${year}: ${count} casts${cell ? ` · ${cell.days} days` : ''}`}
                    onClick={() => onSelect(active && dateFilter === value ? 'All' : value)}
                    disabled={!count}
                  >
                    {count || ''}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {monthKey && days.length > 0 && (
        <div className="heat-days">
          <span className="muted">Days in {monthKey}</span>
          <div className="heat-day-row">
            {days.map(({ day, casts }) => {
              const value = `${monthKey}-${String(day).padStart(2, '0')}`;
              return (
                <button
                  key={value}
                  type="button"
                  className={`heat-day${activeDay === value ? ' active' : ''}`}
                  style={cellStyle(casts, maxDay)}
                  title={`${value}: ${casts} casts`}
                  onClick={() => onSelect(activeDay === value ? monthKey : value)}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
