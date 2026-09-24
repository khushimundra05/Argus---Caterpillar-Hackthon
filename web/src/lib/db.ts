import Database from "better-sqlite3";
import path from "path";

const g = globalThis as unknown as { __argusDb?: Database.Database };
// Module-level: re-runs migrations when this module is reloaded (dev hot reload) against a cached connection
let migrated = false;

export function db(): Database.Database {
  if (!g.__argusDb) {
    const d = new Database(path.join(process.cwd(), "argus.db"));
    d.pragma("journal_mode = WAL");
    migrate(d);
    migrated = true;
    const n = d.prepare("SELECT COUNT(*) AS n FROM operators").get() as { n: number };
    if (n.n === 0) seed(d);
    rollShiftToToday(d);
    g.__argusDb = d;
  }
  if (!migrated) {
    migrate(g.__argusDb);
    migrated = true;
  }
  return g.__argusDb;
}

function migrate(d: Database.Database) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS operators (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, experience_years REAL NOT NULL,
    shifts_completed INTEGER NOT NULL DEFAULT 0,
    assistance_score REAL NOT NULL DEFAULT 100, mode TEXT NOT NULL DEFAULT 'Assist',
    machine_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, model TEXT NOT NULL,
    age_years REAL NOT NULL, idle_burn_lph REAL NOT NULL, work_burn_lph REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT NOT NULL, machine_id TEXT NOT NULL,
    name TEXT NOT NULL, task_type TEXT NOT NULL, target_cycles INTEGER NOT NULL,
    scheduled_start TEXT NOT NULL, estimated_minutes REAL NOT NULL, actual_minutes REAL,
    status TEXT NOT NULL DEFAULT 'scheduled', started_at TEXT, completed_at TEXT,
    cycles_done INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'shift'
  );
  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, operator_id TEXT NOT NULL,
    timestamp TEXT NOT NULL, fuel_used REAL NOT NULL, load_cycles INTEGER NOT NULL,
    idling_seconds REAL NOT NULL, is_idle INTEGER NOT NULL, seatbelt_on INTEGER NOT NULL,
    proximity_m REAL, rpm INTEGER NOT NULL, safety_alert TEXT
  );
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT NOT NULL, machine_id TEXT NOT NULL,
    task_id INTEGER, type TEXT NOT NULL, severity TEXT NOT NULL, timestamp TEXT NOT NULL,
    telemetry_snapshot TEXT, resolved INTEGER NOT NULL DEFAULT 0, source TEXT
  );
  CREATE TABLE IF NOT EXISTS behavior_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS shift_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT NOT NULL, date TEXT NOT NULL,
    idle_ratio REAL NOT NULL, avg_cycle_sec REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_progress (
    operator_id TEXT NOT NULL, module_id TEXT NOT NULL, completed_at TEXT NOT NULL,
    PRIMARY KEY (operator_id, module_id)
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_tel_machine ON telemetry(machine_id, id);
  CREATE INDEX IF NOT EXISTS idx_inc_op ON incidents(operator_id, timestamp);
  CREATE TABLE IF NOT EXISTS score_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    score REAL NOT NULL, mode TEXT NOT NULL, source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_score_op ON score_log(operator_id, timestamp);
  `);
  // resolved_at lets the score credit fast corrections (added to existing DBs without a reset)
  const cols = d.prepare("PRAGMA table_info(incidents)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "resolved_at")) d.exec("ALTER TABLE incidents ADD COLUMN resolved_at TEXT");
}

const daysAgo = (n: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const todayAt = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

function seed(d: Database.Database) {
  const tx = d.transaction(() => {
    const m = d.prepare("INSERT INTO machines VALUES (?,?,?,?,?,?)");
    m.run("M-320", "Hydraulic Excavator", "CAT 320", 3, 3.8, 14);
    m.run("M-950", "Wheel Loader", "CAT 950 GC", 7, 4.5, 16);
    m.run("M-D6", "Track-Type Tractor", "CAT D6", 11, 5.2, 21);

    const o = d.prepare(
      "INSERT INTO operators (id,name,experience_years,shifts_completed,machine_id) VALUES (?,?,?,?,?)",
    );
    o.run("OP-101", "Ravi Kumar", 14, 420, "M-320");
    o.run("OP-102", "Maya Lopez", 5, 160, "M-950");
    o.run("OP-103", "Sam Okafor", 0.3, 12, "M-D6");

    // Historical shifts -> baseline for idle z-score
    const sh = d.prepare("INSERT INTO shift_history (operator_id,date,idle_ratio,avg_cycle_sec) VALUES (?,?,?,?)");
    const base: Record<string, [number, number]> = { "OP-101": [0.12, 0.02], "OP-102": [0.16, 0.03], "OP-103": [0.22, 0.05] };
    for (const [op, [mu, sd]] of Object.entries(base)) {
      for (let i = 1; i <= 14; i++) {
        const noise = (Math.sin(i * 7.3 + op.length) + Math.cos(i * 3.1)) / 2;
        sh.run(op, daysAgo(i), Math.max(0.02, mu + noise * sd * 1.4), 28 + noise * 3);
      }
    }

    // Past incidents / anomalies (last 7 days) so each operator lands in a different mode
    const inc = d.prepare(
      "INSERT INTO incidents (operator_id,machine_id,type,severity,timestamp,telemetry_snapshot,resolved,source,resolved_at) VALUES (?,?,?,?,?,?,1,'history',?)",
    );
    const after = (iso: string, sec: number) => new Date(Date.parse(iso) + sec * 1000).toISOString();
    inc.run("OP-102", "M-950", "SEATBELT", "critical", daysAgo(3), "{}", null);
    // Sam corrected slowly (feeds the ML model's seconds-to-correct features; the formula already counts these as slow)
    inc.run("OP-103", "M-D6", "PROXIMITY", "critical", daysAgo(2), "{}", after(daysAgo(2), 14));
    inc.run("OP-103", "M-D6", "SEATBELT", "critical", daysAgo(5), "{}", after(daysAgo(5), 13));

    const bl = d.prepare("INSERT INTO behavior_logs (operator_id,timestamp,event_type,detail) VALUES (?,?,?,?)");
    bl.run("OP-102", daysAgo(2), "IDLE_ANOMALY", JSON.stringify({ z: 2.4, idle_ratio: 0.26 }));
    bl.run("OP-102", daysAgo(4), "IDLE_ANOMALY", JSON.stringify({ z: 2.1, idle_ratio: 0.24 }));
    bl.run("OP-103", daysAgo(1), "IDLE_ANOMALY", JSON.stringify({ z: 2.9, idle_ratio: 0.41 }));
    bl.run("OP-103", daysAgo(3), "IDLE_ANOMALY", JSON.stringify({ z: 2.2, idle_ratio: 0.35 }));

    // Completed tasks in the last week -> cycle-time deviation
    const t = d.prepare(
      `INSERT INTO tasks (operator_id,machine_id,name,task_type,target_cycles,scheduled_start,estimated_minutes,actual_minutes,status,completed_at,kind)
       VALUES (?,?,?,?,?,?,?,?,'completed',?,'history')`,
    );
    t.run("OP-101", "M-320", "Footing excavation", "trenching", 40, daysAgo(2, 8), 50, 49, daysAgo(2, 9));
    t.run("OP-102", "M-950", "Truck loading Pit 1", "truck_loading", 40, daysAgo(2, 8), 45, 46, daysAgo(2, 9));
    t.run("OP-103", "M-D6", "Pad grading", "grading", 30, daysAgo(2, 8), 40, 45, daysAgo(2, 9));

    // Today's schedule
    const today: [string, string, string, string, number, number, number][] = [
      ["OP-101", "M-320", "Trench excavation — Zone B", "trenching", 35, 7, 55],
      ["OP-101", "M-320", "Load haul trucks — Pit 2", "truck_loading", 30, 9, 40],
      ["OP-101", "M-320", "Backfill utility trench", "backfill", 25, 11, 35],
      ["OP-101", "M-320", "Stockpile shaping", "grading", 20, 13, 30],
      ["OP-102", "M-950", "Load haul trucks — Pit 2", "truck_loading", 35, 7, 45],
      ["OP-102", "M-950", "Aggregate stockpiling", "stockpiling", 30, 9, 40],
      ["OP-102", "M-950", "Yard cleanup", "grading", 20, 12, 25],
      ["OP-103", "M-D6", "Rough grading — Lot 4", "grading", 30, 7, 50],
      ["OP-103", "M-D6", "Push topsoil to stockpile", "stockpiling", 25, 9, 45],
      ["OP-103", "M-D6", "Haul road maintenance", "grading", 20, 12, 35],
    ];
    const tt = d.prepare(
      "INSERT INTO tasks (operator_id,machine_id,name,task_type,target_cycles,scheduled_start,estimated_minutes) VALUES (?,?,?,?,?,?,?)",
    );
    for (const [op, mc, name, type, cycles, h, est] of today) tt.run(op, mc, name, type, cycles, todayAt(h), est);
  });
  tx();
}

/** If the DB was seeded on an earlier day, re-date and reset today's shift tasks. */
function rollShiftToToday(d: Database.Database) {
  const rows = d.prepare("SELECT id, scheduled_start FROM tasks WHERE kind='shift'").all() as { id: number; scheduled_start: string }[];
  if (!rows.length || new Date(rows[0].scheduled_start).toDateString() === new Date().toDateString()) return;
  const upd = d.prepare(
    "UPDATE tasks SET scheduled_start=?, status='scheduled', cycles_done=0, started_at=NULL, completed_at=NULL, actual_minutes=NULL WHERE id=?",
  );
  for (const r of rows) {
    const old = new Date(r.scheduled_start);
    upd.run(todayAt(old.getHours(), old.getMinutes()), r.id);
  }
}

export function kvGet<T>(key: string, fallback: T): T {
  const row = db().prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export function kvSet(key: string, value: unknown) {
  db().prepare("INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    key,
    JSON.stringify(value),
  );
}

export type Operator = {
  id: string; name: string; experience_years: number; shifts_completed: number;
  assistance_score: number; mode: string; machine_id: string;
};
export type Machine = { id: string; type: string; model: string; age_years: number; idle_burn_lph: number; work_burn_lph: number };
export type Task = {
  id: number; operator_id: string; machine_id: string; name: string; task_type: string; target_cycles: number;
  scheduled_start: string; estimated_minutes: number; actual_minutes: number | null; status: string;
  started_at: string | null; completed_at: string | null; cycles_done: number;
};
export type Incident = {
  id: number; operator_id: string; machine_id: string; task_id: number | null; type: string; severity: string;
  timestamp: string; telemetry_snapshot: string | null; resolved: number; source: string | null;
};

export const getOperator = (id: string) => db().prepare("SELECT * FROM operators WHERE id=?").get(id) as Operator | undefined;
export const getMachine = (id: string) => db().prepare("SELECT * FROM machines WHERE id=?").get(id) as Machine | undefined;
export const listOperators = () => db().prepare("SELECT * FROM operators ORDER BY id").all() as Operator[];
