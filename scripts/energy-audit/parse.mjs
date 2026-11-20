// Pure parsers for powercfg's output. powercfg prints in the system language, so they never read labels: they rely on
// GUIDs, indentation, hex values and the few keywords Windows leaves untranslated (DISPLAY:, [PROCESS]...).

const GUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** `powercfg /q[h] <scheme>` → { scheme: {guid, name}, settings: {guid: {alias, name, subgroup, ac, dc}} }. */
export function parsePowerQuery(text) {
  const result = { scheme: null, settings: {} };
  let subgroup = null;
  let setting = null;
  let afterGuid = null; // the block whose alias line may follow
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^ */)[0].length;
    const guid = raw.match(GUID);
    const value = raw.match(/:\s*(.*?)\s*$/)?.[1] ?? '';
    if (guid && /:\s*[0-9a-f]{8}-/i.test(raw)) {
      const name = raw.match(/\((.*)\)\s*$/)?.[1]?.trim() ?? null;
      const id = guid[1].toLowerCase();
      if (indent === 0) result.scheme = afterGuid = { guid: id, name };
      else if (indent === 2) subgroup = afterGuid = { guid: id, name, alias: null };
      else if (indent === 4) {
        setting = afterGuid = { alias: null, name, subgroup: subgroup?.guid ?? null, subgroupAlias: subgroup?.alias ?? null, ac: null, dc: null };
        result.settings[id] = setting;
      }
      continue;
    }
    if (afterGuid && afterGuid !== result.scheme && /^[A-Z][A-Z0-9_]*$/.test(value)) {
      afterGuid.alias = value;
      if (afterGuid === setting) setting.subgroupAlias = subgroup?.alias ?? null;
      afterGuid = null;
      continue;
    }
    afterGuid = null;
    // Current AC then DC index: the only hex lines at the setting's own indentation.
    const hex = value.match(/^0x([0-9a-f]+)$/i);
    if (setting && indent === 4 && hex) {
      const n = parseInt(hex[1], 16);
      if (setting.ac === null) setting.ac = n;
      else if (setting.dc === null) setting.dc = n;
    }
  }
  return result;
}

/** `powercfg /devicequery <query>` → device names (one per line; an empty or "NONE" answer gives []). */
export function parseDeviceList(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(none|aucun)\.?$/i.test(l));
}

/** `powercfg /lastwake` → number of wake sources recorded, and their lines. */
export function parseLastWake(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const count = Number(lines[0]?.match(/(\d+)\s*$/)?.[1] ?? NaN);
  return { count: Number.isFinite(count) ? count : null, details: lines.slice(1) };
}

/** `powercfg /requests` (admin) → { DISPLAY: [{kind, what, reason}], SYSTEM: [...], ... }; the category names and the
 *  [PROCESS]/[SERVICE]/[DRIVER] tags are not translated. */
export function parseRequests(text) {
  const out = {};
  let current = null;
  let last = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cat = line.match(/^([A-Z]+):$/);
    if (cat) {
      current = out[cat[1]] = [];
      last = null;
      continue;
    }
    if (!current) continue;
    const entry = line.match(/^\[([A-Z]+)\]\s*(.*)$/);
    if (entry) {
      last = { kind: entry[1], what: entry[2].split(/[\\/]/).pop() || entry[2], reason: null };
      current.push(last);
    } else if (last && !last.reason) last.reason = line;
  }
  return out;
}

/** ISO 8601 duration (PT1H2M3S, P2DT4H) → seconds. */
export function isoDurationSeconds(s) {
  const m = String(s ?? '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/);
  if (!m) return null;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}

const tagText = (xml, tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() ?? null;
const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** `powercfg /batteryreport /xml` → batteries, recent usage, weekly history. Serial numbers and the computer name are
 *  left out on purpose. */
export function parseBatteryReport(xml) {
  const batteries = [...xml.matchAll(/<Battery>([\s\S]*?)<\/Battery>/g)].map(([, b]) => ({
    manufacturer: tagText(b, 'Manufacturer'),
    chemistry: tagText(b, 'Chemistry'),
    designMWh: num(tagText(b, 'DesignCapacity')),
    fullMWh: num(tagText(b, 'FullChargeCapacity')),
    cycles: num(tagText(b, 'CycleCount')),
  }));
  const usage = [...xml.matchAll(/<UsageEntry\b([^>]*)\/?>/g)].map(([, a]) => {
    const e = attrs(a);
    return {
      at: e.Timestamp ?? null,
      seconds: num(e.Duration) === null ? null : num(e.Duration) / 1e7, // 100 ns ticks
      ac: e.Ac === '1',
      type: e.EntryType ?? null,
      chargeMWh: num(e.ChargeCapacity),
      dischargeMWh: num(e.Discharge),
      fullMWh: num(e.FullChargeCapacity),
    };
  });
  const history = [...xml.matchAll(/<HistoryEntry\b([^>]*)\/?>/g)].map(([, a]) => {
    const e = attrs(a);
    return {
      start: e.StartDate ?? null,
      end: e.EndDate ?? null,
      designMWh: num(e.DesignCapacity),
      fullMWh: num(e.FullChargeCapacity),
      cycles: num(e.CycleCount),
      activeAcSec: isoDurationSeconds(e.ActiveAcTime),
      activeDcSec: isoDurationSeconds(e.ActiveDcTime),
      standbyAcSec: isoDurationSeconds(e.CsAcTime),
      standbyDcSec: isoDurationSeconds(e.CsDcTime),
      activeDcMWh: num(e.ActiveDcEnergy),
      standbyDcMWh: num(e.CsDcEnergy),
    };
  });
  return {
    platformRole: tagText(xml, 'PlatformRole'),
    connectedStandby: tagText(xml, 'ConnectedStandby') === '1',
    batteries,
    usage,
    history,
  };
}

/** Battery drain measured in the report: average watts while on battery and awake, and while in standby on battery. */
export function batteryDrain(report) {
  let activeMWh = 0;
  let activeSec = 0;
  let standbyMWh = 0;
  let standbySec = 0;
  for (const h of report.history) {
    if (h.activeDcSec && h.activeDcMWh) (activeMWh += h.activeDcMWh), (activeSec += h.activeDcSec);
    if (h.standbyDcSec && h.standbyDcMWh) (standbyMWh += h.standbyDcMWh), (standbySec += h.standbyDcSec);
  }
  // Recent usage: consecutive entries on battery give a finer, recent figure for the awake drain.
  let recentMWh = 0;
  let recentSec = 0;
  const u = report.usage;
  for (let i = 0; i + 1 < u.length; i++) {
    const a = u[i];
    const b = u[i + 1];
    if (a.ac || a.type !== 'Active' || a.chargeMWh === null || b.chargeMWh === null || !a.seconds) continue;
    const drop = a.chargeMWh - b.chargeMWh;
    if (drop > 0) (recentMWh += drop), (recentSec += a.seconds);
  }
  const w = (mwh, sec) => (sec >= 600 ? Math.round((mwh / (sec / 3600)) / 100) / 10 : null);
  return {
    activeW: w(activeMWh, activeSec),
    activeHours: Math.round(activeSec / 360) / 10,
    standbyW: w(standbyMWh, standbySec),
    standbyHours: Math.round(standbySec / 360) / 10,
    recentActiveW: w(recentMWh, recentSec),
  };
}

/** Usage entries → time spent awake and asleep (any power source) over the report's window, in hours. */
export function usageSummary(report) {
  const out = { activeH: 0, suspendH: 0, standbyH: 0, hibernateH: 0, otherH: 0 };
  for (const e of report.usage) {
    const h = (e.seconds ?? 0) / 3600;
    if (e.type === 'Active') out.activeH += h;
    else if (e.type === 'Suspend') out.suspendH += h;
    else if (e.type === 'ConnectedStandby') out.standbyH += h;
    else if (e.type === 'Hibernate') out.hibernateH += h;
    else if (e.type !== 'ReportGenerated') out.otherH += h;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 10) / 10;
  return out;
}
