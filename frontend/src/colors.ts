import palette from './palette.json';

export const STATION_COLOR = palette.station;
export const UNASSIGNED_COLOR = palette.unassigned;

const LEGACY_UNASSIGNED = new Set(['#0077b6', '#72aebb', UNASSIGNED_COLOR]);

export function isUnassignedStation(st: { kind?: string; color?: string }) {
  return st.kind === 'unassigned' || (!st.kind && !!st.color && LEGACY_UNASSIGNED.has(st.color));
}
