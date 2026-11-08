// Health data from Health Auto Export (iOS app, JSON export format v2) into
// JSON Lines files: one row per day, per workout, per km split, per running
// sample, and a file of minutes for each workout. Only numbers, dates and a few
// known identifiers are copied: no free text of the source reaches the vault.
// Rows already written are kept and updated; derived fields (heart-rate zones,
// training load, running dynamics of each workout) are computed again on every
// import from the stored rows, so they do not depend on the order files arrive in.

export type Value = number | string | boolean;
export type Row = Record<string, Value>;

export interface Store {
  /** By day, YYYY-MM-DD. */
  daily: Map<string, Row>;
  /** By workout id. */
  workouts: Map<string, Row>;
  /** Kilometre splits by workout id. */
  splits: Map<string, Row[]>;
  /** Running samples (minute or hour) by time and resolution. */
  running: Map<string, Row>;
  /** Minutes of each workout, by workout id. */
  minutes: Map<string, Row[]>;
}

export interface HealthOptions {
  /** Maximum heart rate; 0: the highest seen in a workout. */
  maxHr: number;
  /** Sex, for the weighting of Banister's TRIMP. */
  sex: "male" | "female";
}

export interface SourceFile {
  /** Path inside the source folder. */
  path: string;
  size: number;
  mtime: number;
}

export interface ImportState {
  files: Record<string, { size: number; mtime: number }>;
  last?: { time: string; ok: boolean; message: string };
}

export interface ImportCounts {
  files: number;
  ignored: string[];
  days: Set<string>;
  workouts: Set<string>;
  running: number;
}

export const DEFAULT_HEALTH: HealthOptions = { maxHr: 0, sex: "male" };

export function emptyStore(): Store {
  return { daily: new Map(), workouts: new Map(), splits: new Map(), running: new Map(), minutes: new Map() };
}

export function newCounts(): ImportCounts {
  return { files: 0, ignored: [], days: new Set(), workouts: new Set(), running: 0 };
}

// ---------------------------------------------------------------- numbers and dates

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** Rounded to a number of decimals; integers stay integers. */
export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** "2026-10-29 18:58:20 +0100" (the app's format) or ISO 8601, as ISO with its offset. */
export function isoTime(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const zone = !m[4] ? "" : m[4] === "Z" ? "Z" : `${m[4].slice(0, 3)}:${m[4].slice(-2)}`;
  return `${m[1]}T${m[2]}:${m[3] ?? "00"}${zone}`;
}

const ms = (iso: string): number => Date.parse(iso);
const day = (iso: string): string => iso.slice(0, 10);
const timeOfDay = (iso: string): string => iso.slice(11, 19);

/** Quantity with units, converted to the unit wanted; null when the unit is unknown. */
function convert(value: number, from: string, to: string): number | null {
  const unit = from.trim();
  if (unit === to) return value;
  const factors: Record<string, Record<string, number>> = {
    kcal: { kJ: 1 / 4.184, Cal: 1, kcal: 1 },
    km: { m: 0.001, mi: 1.609344, km: 1 },
    m: { km: 1000, cm: 0.01, mi: 1609.344, ft: 0.3048, in: 0.0254, m: 1 },
    cm: { m: 100, mm: 0.1, in: 2.54, cm: 1 },
    kg: { lb: 0.45359237, g: 0.001, kg: 1 },
    "km/hr": { "m/s": 3.6, "mi/hr": 1.609344, "km/hr": 1 },
    "m/s": { "km/hr": 1 / 3.6, "ft/s": 0.3048, "m/s": 1 },
    ms: { s: 1000, ms: 1 },
    min: { s: 1 / 60, hr: 60, min: 1 },
    hr: { min: 1 / 60, s: 1 / 3600, hr: 1 },
  };
  if (to === "degC") return unit === "degF" ? ((value - 32) * 5) / 9 : null;
  const factor = factors[to]?.[unit];
  return factor === undefined ? null : value * factor;
}

/** A quantity object of the export ({qty, units}), in the unit wanted. */
function quantity(value: unknown, to: string): number | null {
  if (!isObject(value)) return null;
  const qty = num(value.qty);
  if (qty === null) return null;
  return typeof value.units === "string" ? convert(qty, value.units, to) : null;
}

// ---------------------------------------------------------------- daily metrics

type DailyMap = { field: string; unit?: string; decimals?: number };

/** Metrics of the export and the fields of a day: names carry the unit. */
const DAILY: Record<string, DailyMap> = {
  step_count: { field: "steps", decimals: 0 },
  walking_running_distance: { field: "distance_km", unit: "km", decimals: 3 },
  active_energy: { field: "active_kcal", unit: "kcal", decimals: 0 },
  basal_energy_burned: { field: "basal_kcal", unit: "kcal", decimals: 0 },
  apple_exercise_time: { field: "exercise_min", unit: "min", decimals: 0 },
  apple_stand_time: { field: "stand_min", unit: "min", decimals: 0 },
  apple_stand_hour: { field: "stand_h", decimals: 0 },
  flights_climbed: { field: "flights", decimals: 0 },
  time_in_daylight: { field: "daylight_min", unit: "min", decimals: 0 },
  resting_heart_rate: { field: "rhr_bpm", decimals: 0 },
  walking_heart_rate_average: { field: "walking_hr_bpm", decimals: 1 },
  heart_rate_variability: { field: "hrv_sdnn_ms", decimals: 1 },
  heart_rate_variability_rmssd: { field: "hrv_rmssd_ms", decimals: 1 },
  respiratory_rate: { field: "respiratory_rate", decimals: 1 },
  blood_oxygen_saturation: { field: "spo2_pct", decimals: 1 },
  apple_sleeping_wrist_temperature: { field: "wrist_temp_c", unit: "degC", decimals: 2 },
  breathing_disturbances: { field: "breathing_disturbances", decimals: 1 },
  vo2_max: { field: "vo2max", decimals: 1 },
  cardio_recovery: { field: "cardio_recovery_bpm", decimals: 1 },
  weight_body_mass: { field: "weight_kg", unit: "kg", decimals: 2 },
  body_fat_percentage: { field: "body_fat_pct", decimals: 1 },
  lean_body_mass: { field: "lean_kg", unit: "kg", decimals: 2 },
  body_mass_index: { field: "bmi", decimals: 1 },
  walking_speed: { field: "walking_speed_kmh", unit: "km/hr", decimals: 2 },
  walking_step_length: { field: "walking_step_cm", unit: "cm", decimals: 1 },
  walking_double_support_percentage: { field: "walking_double_support_pct", decimals: 1 },
  walking_asymmetry_percentage: { field: "walking_asymmetry_pct", decimals: 1 },
  stair_speed_up: { field: "stair_up_mps", unit: "m/s", decimals: 2 },
  stair_speed_down: { field: "stair_down_mps", unit: "m/s", decimals: 2 },
  six_minute_walking_test_distance: { field: "six_min_walk_m", unit: "m", decimals: 0 },
  physical_effort: { field: "physical_effort", decimals: 2 },
  environmental_audio_exposure: { field: "audio_env_db", decimals: 1 },
  headphone_audio_exposure: { field: "audio_headphone_db", decimals: 1 },
  running_power: { field: "run_power_w", decimals: 0 },
  running_speed: { field: "run_speed_kmh", unit: "km/hr", decimals: 2 },
  running_vertical_oscillation: { field: "run_vo_cm", unit: "cm", decimals: 2 },
  running_ground_contact_time: { field: "run_gct_ms", unit: "ms", decimals: 0 },
  running_stride_length: { field: "run_stride_m", unit: "m", decimals: 3 },
};

/** Running metrics kept sample by sample, to give each run its dynamics. */
const RUNNING: Record<string, DailyMap> = {
  running_power: { field: "power_w", decimals: 0 },
  running_speed: { field: "speed_kmh", unit: "km/hr", decimals: 2 },
  running_vertical_oscillation: { field: "vo_cm", unit: "cm", decimals: 2 },
  running_ground_contact_time: { field: "gct_ms", unit: "ms", decimals: 0 },
  running_stride_length: { field: "stride_m", unit: "m", decimals: 3 },
};

const NAME = /^[a-z][a-z0-9_]*$/;

/** The value of a sample in a metric's unit for us; null when unknown or unconvertible. */
function sampleValue(item: Json, units: string, map?: DailyMap): number | null {
  const qty = num(item.qty);
  if (qty === null) return null;
  return map?.unit ? convert(qty, units, map.unit) : qty;
}

/** A file of metrics summarised by day: every sample at midnight. Otherwise by hour or minute. */
function resolution(metrics: Json[]): "day" | "hour" | "minute" {
  const times = metrics.flatMap((metric) => list(metric.data).map((item) => isoTime(item.date))).filter((t): t is string => t !== null);
  if (times.every((t) => timeOfDay(t) === "00:00:00")) return "day";
  return times.every((t) => t.slice(14, 19) === "00:00") ? "hour" : "minute";
}

function addDailyMetrics(store: Store, metrics: Json[], counts: ImportCounts): void {
  for (const metric of metrics) {
    const name = typeof metric.name === "string" ? metric.name : "";
    if (!NAME.test(name)) continue;
    const units = typeof metric.units === "string" ? metric.units : "";
    for (const item of list(metric.data)) {
      const time = isoTime(item.date);
      if (!time) continue;
      const fields: Row = {};
      if (name === "heart_rate") {
        for (const [key, field] of [["Min", "hr_min_bpm"], ["Avg", "hr_avg_bpm"], ["Max", "hr_max_bpm"]] as const) {
          const value = num(item[key]);
          if (value !== null) fields[field] = round(value, key === "Avg" ? 1 : 0);
        }
      } else if (name === "sleep_analysis") {
        const total = num(item.totalSleep) || num(item.asleep);
        if (total) fields.sleep_h = round(total, 2);
        for (const [key, field] of [["deep", "sleep_deep_h"], ["rem", "sleep_rem_h"], ["core", "sleep_core_h"], ["awake", "sleep_awake_h"]] as const) {
          const value = num(item[key]);
          if (value !== null && total) fields[field] = round(value, 2);
        }
        const start = isoTime(item.sleepStart);
        const end = isoTime(item.sleepEnd);
        if (start && total) fields.sleep_start = start;
        if (end && total) fields.sleep_end = end;
      } else {
        const map = DAILY[name];
        const value = sampleValue(item, units, map);
        if (value === null) continue;
        fields[map?.field ?? name] = round(value, map?.decimals ?? 3);
      }
      if (!Object.keys(fields).length) continue;
      const date = day(time);
      const row = store.daily.get(date) ?? { date };
      Object.assign(row, fields);
      store.daily.set(date, row);
      counts.days.add(date);
    }
  }
}

function addRunningSamples(store: Store, metrics: Json[], res: "hour" | "minute", counts: ImportCounts): void {
  for (const metric of metrics) {
    const map = typeof metric.name === "string" ? RUNNING[metric.name] : undefined;
    if (!map) continue;
    const units = typeof metric.units === "string" ? metric.units : "";
    for (const item of list(metric.data)) {
      const time = isoTime(item.date);
      const value = sampleValue(item, units, map);
      if (!time || value === null) continue;
      const key = `${time} ${res}`;
      const row = store.running.get(key) ?? { time, res };
      counts.running++;
      row[map.field] = round(value, map.decimals ?? 2);
      store.running.set(key, row);
    }
  }
}

// ---------------------------------------------------------------- workouts

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** Sports with a pace and a stride. */
const ON_FOOT = new Set(["running", "walking", "hiking"]);

/** The file of a workout's minutes, inside the output folder. */
export function minutesFile(workout: Row): string {
  return `Workouts/${workout.date}_${String(workout.id).slice(0, 8).toLowerCase()}.jsonl`;
}

function minutesOf(workout: Json, start: string): Row[] {
  const startMinute = ms(`${start.slice(0, 16)}:00${start.slice(19)}`);
  const rows = new Map<number, Row>();
  const at = (item: Json): Row | null => {
    const time = isoTime(item.date);
    if (!time) return null;
    const t = Math.round((ms(time) - startMinute) / 60000);
    if (t < 0 || t > 24 * 60) return null;
    const row = rows.get(t) ?? { t, time: time.slice(0, 16) };
    rows.set(t, row);
    return row;
  };
  for (const item of list(workout.heartRateData)) {
    const row = at(item);
    const avg = num(item.Avg);
    if (!row || avg === null) continue;
    row.hr = round(avg, 1);
    const [min, max] = [num(item.Min), num(item.Max)];
    if (min !== null) row.hr_min = round(min, 0);
    if (max !== null) row.hr_max = round(max, 0);
  }
  for (const item of list(workout.walkingAndRunningDistance)) {
    const row = at(item);
    const km = typeof item.units === "string" && num(item.qty) !== null ? convert(num(item.qty)!, item.units, "km") : null;
    if (row && km !== null) row.dist_m = round(km * 1000, 1);
  }
  for (const item of list(workout.stepCount)) {
    const row = at(item);
    const steps = num(item.qty);
    if (row && steps !== null) row.steps = round(steps, 0);
  }
  for (const item of list(workout.activeEnergy)) {
    const row = at(item);
    const kcal = typeof item.units === "string" && num(item.qty) !== null ? convert(num(item.qty)!, item.units, "kcal") : null;
    if (row && kcal !== null) row.kcal = round(kcal, 1);
  }
  const sorted = [...rows.values()].sort((a, b) => Number(a.t) - Number(b.t));
  for (const row of sorted) {
    const dist = num(row.dist_m);
    if (dist !== null && dist >= 10) row.pace_s_km = round(60000 / dist, 0);
  }
  return sorted;
}

function splitsOf(workout: Json, base: Row): Row[] {
  const perKm = list(workout.splits).find((split) => isObject(split.targetDistance) && split.targetDistance.qty === 1 && split.targetDistance.units === "km");
  if (!perKm) return [];
  return list(perKm.items).flatMap((item, index) => {
    const metrics = isObject(item.metrics) ? item.metrics : {};
    const distance = quantity(metrics.distance, "m");
    const duration = num(item.activeDuration);
    if (distance === null || duration === null || distance <= 0) return [];
    const row: Row = { id: base.id, date: base.date, start: base.start, sport: base.sport, km: num(item.index) ?? index + 1, distance_m: round(distance, 1), duration_s: round(duration, 1) };
    row.pace_s_km = round((duration * 1000) / distance, 0);
    const hr = isObject(metrics.heartRateAverage) ? num(metrics.heartRateAverage.qty) : null;
    if (hr !== null) row.hr_avg = round(hr, 1);
    if (item.isPartial === true) row.partial = true;
    return [row];
  });
}

function workoutRow(workout: Json): Row | null {
  const id = typeof workout.id === "string" && UUID.test(workout.id) ? workout.id.toUpperCase() : null;
  const start = isoTime(workout.start);
  const end = isoTime(workout.end);
  const duration = num(workout.duration);
  if (!id || !start || !end || duration === null) return null;
  const activity = list(workout.activities)[0] ?? {};
  const type = typeof activity.activityType === "string" ? activity.activityType : "";
  const sport = /^[a-z_]{2,40}$/.test(type) ? type : "other";
  const row: Row = { id, date: day(start), start, end, sport };
  if (typeof workout.isIndoor === "boolean") row.indoor = workout.isIndoor;
  row.duration_min = round(duration / 60, 2);
  const elapsed = num(activity.elapsedDuration);
  if (elapsed !== null && elapsed > duration + 1) row.elapsed_min = round(elapsed / 60, 2);
  const distance = quantity(workout.distance, "km");
  if (distance !== null && distance > 0) {
    row.distance_km = round(distance, 3);
    row.speed_kmh = round(distance / (duration / 3600), 2);
    if (ON_FOOT.has(sport) && distance >= 0.1) row.pace_s_km = round(duration / distance, 0);
  }
  const heart = isObject(workout.heartRate) ? workout.heartRate : {};
  const hrAvg = quantity(heart.avg, "count/min") ?? num(isObject(workout.avgHeartRate) ? workout.avgHeartRate.qty : null);
  const hrMax = quantity(heart.max, "count/min") ?? num(isObject(workout.maxHeartRate) ? workout.maxHeartRate.qty : null);
  const hrMin = quantity(heart.min, "count/min");
  if (hrAvg !== null) row.hr_avg = round(hrAvg, 1);
  if (hrMin !== null) row.hr_min = round(hrMin, 0);
  if (hrMax !== null) row.hr_max = round(hrMax, 0);
  const active = quantity(workout.activeEnergyBurned, "kcal");
  const total = quantity(workout.totalEnergy, "kcal");
  if (active !== null) row.active_kcal = round(active, 0);
  if (total !== null) row.total_kcal = round(total, 0);
  const climb = quantity(workout.elevationUp, "m");
  if (climb !== null) row.elevation_up_m = round(climb, 1);
  const cadence = isObject(workout.stepCadence) ? num(workout.stepCadence.qty) : null;
  if (cadence !== null && cadence > 0) row.cadence_spm = round(cadence, 1);
  const steps = list(workout.stepCount).reduce((sum, item) => sum + (num(item.qty) ?? 0), 0);
  if (steps > 0) {
    row.steps = round(steps, 0);
    if (ON_FOOT.has(sport) && distance) row.stride_m = round((distance * 1000) / steps, 3);
  }
  const effort = isObject(workout.effortScore) ? num(workout.effortScore.qty) : isObject(workout.estimatedEffortScore) ? num(workout.estimatedEffortScore.qty) : null;
  if (effort !== null) row.effort = effort;
  const temperature = isObject(workout.temperature) && typeof workout.temperature.units === "string" && num(workout.temperature.qty) !== null
    ? convert(num(workout.temperature.qty)!, workout.temperature.units, "degC")
    : null;
  if (temperature !== null) row.temp_c = round(temperature, 1);
  const humidity = isObject(workout.humidity) ? num(workout.humidity.qty) : null;
  if (humidity !== null) row.humidity_pct = round(humidity, 0);
  const met = isObject(workout.intensity) ? num(workout.intensity.qty) : null;
  if (met !== null) row.met = round(met, 2);
  return row;
}

function addWorkouts(store: Store, workouts: Json[], counts: ImportCounts): void {
  for (const workout of workouts) {
    const row = workoutRow(workout);
    if (!row) continue;
    const id = String(row.id);
    store.workouts.set(id, row);
    store.minutes.set(id, minutesOf(workout, String(row.start)));
    store.splits.set(id, splitsOf(workout, row));
    counts.workouts.add(id);
  }
}

/** One exported file, of any automation: workouts, metrics by day, by hour or by minute. */
export function addExport(store: Store, json: unknown, counts: ImportCounts, name = ""): void {
  const data = isObject(json) && isObject(json.data) ? json.data : null;
  if (!data) {
    counts.ignored.push(name);
    return;
  }
  counts.files++;
  addWorkouts(store, list(data.workouts), counts);
  const metrics = list(data.metrics);
  if (!metrics.length) return;
  const res = resolution(metrics);
  if (res === "day") addDailyMetrics(store, metrics, counts);
  else addRunningSamples(store, metrics, res, counts);
}

// ---------------------------------------------------------------- derived fields

/** Fields computed on every import: never read back from the files. */
const DERIVED_WORKOUT = [
  "m_per_beat", "decoupling_pct", "trimp", "z1_min", "z2_min", "z3_min", "z4_min", "z5_min",
  "run_power_w", "power_w_kg", "run_vo_cm", "run_gct_ms", "run_stride_m", "vertical_ratio_pct", "dynamics_src",
];
const DERIVED_MINUTE = ["power_w", "vo_cm", "gct_ms", "stride_m"];
const DERIVED_DAILY = ["trimp", "atl", "ctl", "tsb"];

const strip = (row: Row, fields: string[]): Row => {
  for (const field of fields) delete row[field];
  return row;
};

const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** The latest value of a daily field on or before a day, within a number of days. */
function latest(store: Store, field: string, date: string, days: number): number | null {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  let best: [string, number] | null = null;
  for (const [d, row] of store.daily) {
    const value = num(row[field]);
    if (value === null || d > date || d < from) continue;
    if (!best || d > best[0]) best = [d, value];
  }
  return best?.[1] ?? null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Running dynamics of a run: minute samples inside it, else hourly ones weighted by overlap, else the day's. */
function dynamics(store: Store, workout: Row, runs: number): Row {
  const [start, end] = [ms(String(workout.start)), ms(String(workout.end))];
  const fields = Object.values(RUNNING).map((map) => map.field);
  const samples = [...store.running.values()];
  const minute = samples.filter((s) => s.res === "minute" && ms(String(s.time)) >= start - 60000 && ms(String(s.time)) <= end);
  const result: Row = {};
  if (minute.length) {
    for (const field of fields) {
      const value = mean(minute.map((s) => num(s[field])).filter((v): v is number => v !== null));
      if (value !== null) result[field] = value;
    }
    if (Object.keys(result).length) return { ...result, dynamics_src: "minute" };
  }
  const hourly = samples.filter((s) => s.res === "hour" && ms(String(s.time)) < end && ms(String(s.time)) + 3600000 > start);
  if (hourly.length) {
    for (const field of fields) {
      let [sum, weight] = [0, 0];
      for (const s of hourly) {
        const value = num(s[field]);
        if (value === null) continue;
        const t = ms(String(s.time));
        const overlap = Math.min(end, t + 3600000) - Math.max(start, t);
        if (overlap > 0) [sum, weight] = [sum + value * overlap, weight + overlap];
      }
      if (weight) result[field] = sum / weight;
    }
    if (Object.keys(result).length) return { ...result, dynamics_src: "hour" };
  }
  const daily = store.daily.get(String(workout.date));
  if (daily && runs === 1) {
    const fromDay: Record<string, string> = { power_w: "run_power_w", speed_kmh: "run_speed_kmh", vo_cm: "run_vo_cm", gct_ms: "run_gct_ms", stride_m: "run_stride_m" };
    for (const field of fields) {
      const value = num(daily[fromDay[field]]);
      if (value !== null) result[field] = value;
    }
    if (Object.keys(result).length) return { ...result, dynamics_src: "day" };
  }
  return {};
}

/** Recomputes every derived field from the stored rows. */
export function derive(store: Store, options: HealthOptions = DEFAULT_HEALTH): void {
  const workouts = [...store.workouts.values()];
  const maxHr = options.maxHr > 0 ? options.maxHr : Math.max(0, ...workouts.map((w) => num(w.hr_max) ?? 0));
  const rests = [...store.daily.values()].map((row) => num(row.rhr_bpm)).filter((v): v is number => v !== null);
  const usualRest = median(rests) ?? 60;
  const k = options.sex === "female" ? 1.67 : 1.92;
  const runsByDay = new Map<string, number>();
  for (const w of workouts) if (w.sport === "running") runsByDay.set(String(w.date), (runsByDay.get(String(w.date)) ?? 0) + 1);
  const byMinute = new Map([...store.running.values()].filter((s) => s.res === "minute").map((s) => [String(s.time).slice(0, 16), s]));

  for (const w of workouts) {
    strip(w, DERIVED_WORKOUT);
    const id = String(w.id);
    const minutes = store.minutes.get(id) ?? [];
    for (const m of minutes) strip(m, DERIVED_MINUTE);
    const distance = num(w.distance_km);
    const hrAvg = num(w.hr_avg);
    const duration = num(w.duration_min);
    if (distance && hrAvg && duration && ON_FOOT.has(String(w.sport))) w.m_per_beat = round((distance * 1000) / (hrAvg * duration), 3);

    // Heart-rate zones (Karvonen, % of reserve) and Banister's TRIMP, minute by minute.
    const rest = latest(store, "rhr_bpm", String(w.date), 30) ?? usualRest;
    if (maxHr > rest) {
      const zones = [0, 0, 0, 0, 0];
      let trimp = 0;
      for (const m of minutes) {
        const hr = num(m.hr);
        if (hr === null) continue;
        const reserve = Math.min(1, Math.max(0, (hr - rest) / (maxHr - rest)));
        trimp += reserve * 0.64 * Math.exp(k * reserve);
        // Tenths of the reserve, with a tolerance: 84/140 is 60 %, not 59.99… %.
        const tenth = Math.floor(reserve * 10 + 1e-9);
        if (tenth >= 5) zones[Math.min(4, tenth - 5)]++;
      }
      if (minutes.some((m) => num(m.hr) !== null)) {
        w.trimp = round(trimp, 1);
        zones.forEach((count, i) => (w[`z${i + 1}_min`] = count));
      }
    }

    // Aerobic decoupling: speed per heartbeat, first half against second half.
    const paired = minutes.filter((m) => num(m.hr) !== null && num(m.dist_m) !== null);
    if (w.sport === "running" && paired.length >= 20) {
      const half = Math.floor(paired.length / 2);
      const ef = (rows: Row[]) => rows.reduce((s, m) => s + Number(m.dist_m), 0) / rows.reduce((s, m) => s + Number(m.hr), 0);
      const [first, second] = [ef(paired.slice(0, half)), ef(paired.slice(half))];
      if (first > 0) w.decoupling_pct = round(((first - second) / first) * 100, 1);
    }

    if (w.sport === "running") {
      const d = dynamics(store, w, runsByDay.get(String(w.date)) ?? 0);
      const names: Record<string, string> = { power_w: "run_power_w", vo_cm: "run_vo_cm", gct_ms: "run_gct_ms", stride_m: "run_stride_m" };
      for (const [from, to] of Object.entries(names)) {
        const value = num(d[from]);
        if (value !== null) w[to] = round(value, from === "stride_m" ? 3 : from === "vo_cm" ? 2 : 0);
      }
      const weight = latest(store, "weight_kg", String(w.date), 60);
      if (num(w.run_power_w) !== null && weight) w.power_w_kg = round(Number(w.run_power_w) / weight, 2);
      if (num(w.run_vo_cm) !== null && num(w.run_stride_m)) w.vertical_ratio_pct = round(Number(w.run_vo_cm) / Number(w.run_stride_m), 1);
      if (d.dynamics_src) w.dynamics_src = d.dynamics_src;
      // The same samples, minute by minute.
      for (const m of minutes) {
        const s = byMinute.get(String(m.time));
        if (!s) continue;
        for (const field of DERIVED_MINUTE) if (s[field] !== undefined) m[field] = s[field];
      }
    }
  }

  // Training load by day: TRIMP, fatigue (ATL, 7 days), fitness (CTL, 42 days), form (TSB).
  for (const row of store.daily.values()) strip(row, DERIVED_DAILY);
  const trimpByDay = new Map<string, number>();
  for (const w of workouts) if (num(w.trimp) !== null) trimpByDay.set(String(w.date), (trimpByDay.get(String(w.date)) ?? 0) + Number(w.trimp));
  if (!trimpByDay.size) return;
  const days = [...trimpByDay.keys(), ...store.daily.keys()].sort();
  const [a7, a42] = [1 - Math.exp(-1 / 7), 1 - Math.exp(-1 / 42)];
  let [atl, ctl] = [0, 0];
  for (let d = days[0]; d <= days[days.length - 1]; d = nextDay(d)) {
    const trimp = trimpByDay.get(d) ?? 0;
    const tsb = ctl - atl;
    atl += a7 * (trimp - atl);
    ctl += a42 * (trimp - ctl);
    const row = store.daily.get(d) ?? { date: d };
    Object.assign(row, { trimp: round(trimp, 1), atl: round(atl, 1), ctl: round(ctl, 1), tsb: round(tsb, 1) });
    store.daily.set(d, row);
  }
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- files

export function parseJsonl(text: string): Row[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isObject(value) ? [value as Row] : [];
      } catch {
        return [];
      }
    });
}

export function toJsonl(rows: Row[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

export const FILES = { daily: "daily.jsonl", workouts: "workouts.jsonl", splits: "splits.jsonl", running: "running.jsonl", state: "sources.json" };

/** The store from the files of an output folder; minutes by workout file name. */
export function loadStore(texts: { daily?: string | null; workouts?: string | null; splits?: string | null; running?: string | null }, readMinutes: (file: string) => string | null): Store {
  const store = emptyStore();
  for (const row of parseJsonl(texts.daily ?? "")) if (typeof row.date === "string") store.daily.set(row.date, strip(row, DERIVED_DAILY));
  for (const row of parseJsonl(texts.workouts ?? "")) {
    if (typeof row.id !== "string") continue;
    store.workouts.set(row.id, strip(row, DERIVED_WORKOUT));
    store.minutes.set(row.id, parseJsonl(readMinutes(minutesFile(row)) ?? "").map((m) => strip(m, DERIVED_MINUTE)));
  }
  for (const row of parseJsonl(texts.splits ?? "")) {
    if (typeof row.id !== "string") continue;
    store.splits.set(row.id, [...(store.splits.get(row.id) ?? []), row]);
  }
  for (const row of parseJsonl(texts.running ?? "")) if (typeof row.time === "string") store.running.set(`${row.time} ${row.res}`, row);
  return store;
}

/** Fields of a day in a fixed order: the date, the known metrics, the others by name, the training load. */
const DAILY_ORDER = [
  "date", "steps", "distance_km", "active_kcal", "basal_kcal", "exercise_min", "stand_min", "stand_h", "flights", "daylight_min",
  "rhr_bpm", "hr_min_bpm", "hr_avg_bpm", "hr_max_bpm", "walking_hr_bpm", "hrv_sdnn_ms", "hrv_rmssd_ms", "respiratory_rate", "spo2_pct",
  "wrist_temp_c", "breathing_disturbances", "vo2max", "cardio_recovery_bpm",
  "sleep_h", "sleep_deep_h", "sleep_rem_h", "sleep_core_h", "sleep_awake_h", "sleep_start", "sleep_end",
  ...Object.values(DAILY).map((map) => map.field),
];

function ordered(row: Row): Row {
  const rank = (key: string) => {
    const known = DAILY_ORDER.indexOf(key);
    if (known >= 0) return [0, known, key] as const;
    return DERIVED_DAILY.includes(key) ? ([2, DERIVED_DAILY.indexOf(key), key] as const) : ([1, 0, key] as const);
  };
  const keys = Object.keys(row).sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  });
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

/** Every file of the output folder, by path inside it. */
export function outputFiles(store: Store): Map<string, string> {
  const byStart = (a: Row, b: Row) => String(a.start).localeCompare(String(b.start));
  const workouts = [...store.workouts.values()].sort(byStart);
  const files = new Map<string, string>([
    [FILES.daily, toJsonl([...store.daily.values()].filter((row) => Object.keys(row).length > 1).sort((a, b) => String(a.date).localeCompare(String(b.date))).map(ordered))],
    [FILES.workouts, toJsonl(workouts)],
    [FILES.splits, toJsonl(workouts.flatMap((w) => store.splits.get(String(w.id)) ?? []))],
    [FILES.running, toJsonl([...store.running.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)) || String(a.res).localeCompare(String(b.res))))],
  ]);
  for (const w of workouts) {
    const minutes = store.minutes.get(String(w.id)) ?? [];
    if (minutes.length) files.set(minutesFile(w), toJsonl(minutes));
  }
  return files;
}

/** Source files that are new or changed since the last import, oldest first. */
export function changedFiles(files: SourceFile[], state: ImportState): SourceFile[] {
  return files
    .filter((file) => {
      const seen = state.files[file.path];
      return !seen || seen.size !== file.size || seen.mtime !== file.mtime;
    })
    .sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
}

export function readState(text: string | null): ImportState {
  try {
    const value: unknown = text ? JSON.parse(text) : null;
    if (isObject(value) && isObject(value.files)) return value as unknown as ImportState;
  } catch {
    // a broken state file means: read everything again
  }
  return { files: {} };
}
