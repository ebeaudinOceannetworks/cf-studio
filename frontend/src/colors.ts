import palette from './palette.json';

export const STATION_COLOR = palette.station;
export const UNASSIGNED_COLOR = palette.unassigned;

const VARIABLE_COLORS: Record<string, string> = palette.variables || {};
const LEGACY_UNASSIGNED = new Set(['#0077b6', '#72aebb', UNASSIGNED_COLOR]);

const VARIABLE_UNITS: Record<string, string> = {
  temperature: '°C',
  'potential temperature': '°C',
  salinity: 'psu',
  'practical salinity': 'psu',
  density: 'kg m⁻³',
  chlorophyll: 'mg m⁻³',
  nitrate: 'µmol L⁻¹',
  oxygen: 'µL L⁻¹',
  'oxygen concentration': 'µL L⁻¹',
  'dissolved oxygen': 'mL L⁻¹',
  'oxygen saturation': '%',
  'sound speed': 'm s⁻¹',
  depth: 'm',
  turbidity: 'NTU',
  pressure: 'dbar',
  conductivity: 'mS cm⁻¹',
  cdom: 'm⁻¹',
};

export function isUnassignedStation(st: { kind?: string; color?: string }) {
  return st.kind === 'unassigned' || (!st.kind && !!st.color && LEGACY_UNASSIGNED.has(st.color));
}

export function variableColor(name: string) {
  const key = (name || '').trim().toLowerCase();
  if (VARIABLE_COLORS[key]) return VARIABLE_COLORS[key];
  if (key.includes('temperature') && VARIABLE_COLORS.temperature) return VARIABLE_COLORS.temperature;
  if (key.includes('salinity') && VARIABLE_COLORS['practical salinity']) return VARIABLE_COLORS['practical salinity'];
  return STATION_COLOR;
}

export function variableUnits(name: string) {
  const key = (name || '').trim().toLowerCase();
  if (VARIABLE_UNITS[key]) return VARIABLE_UNITS[key];
  if (key.includes('temperature')) return VARIABLE_UNITS.temperature;
  if (key.includes('salinity')) return VARIABLE_UNITS['practical salinity'];
  return '';
}

export function variableXLabel(name: string, units?: string) {
  const u = (units || variableUnits(name)).trim();
  return u ? `${name} (${u})` : name;
}
