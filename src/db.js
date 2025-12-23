import Dexie from "dexie";

export const db = new Dexie("sga_pwa_db");

db.version(2).stores({
  records: "++id, mode, studentId, name, type, scanned, received, timestamp"
});
