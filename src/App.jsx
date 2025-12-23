import React, { useEffect, useMemo, useRef, useState } from "react";
import Quagga from "@ericblade/quagga2";
import { db } from "./db";
import { downloadCSV, parseCSV } from "./csv";

/**
 * Notes:
 * - Designed for CODE_128 on small ID cards.
 * - Uses Quagga2 "locate" mode + overlay (green boxes / red line), like the demo.
 * - Scanner opens expanded by default for more pixels (higher success rate).
 * - Flip camera cycles available video inputs by deviceId.
 */

function pad2(n) {
  return String(n).padStart(2, "0");
}
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function normalizeId(id) {
  const s = String(id ?? "").trim();
  if (/^\d{6}$/.test(s)) return "0" + s;
  return s;
}
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning ☀️";
  if (hour < 18) return "Good afternoon 🌤️";
  return "Good evening 🌙";
}
function formatDateLong() {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function App() {
  const [screen, setScreen] = useState("welcome"); // welcome | app
  const [welcomeStage, setWelcomeStage] = useState("in"); // in | out

  const [mode, setMode] = useState("events"); // events | distribution
  const [records, setRecords] = useState([]);
  const [scan, setScan] = useState("");

  const [banner, setBanner] = useState(null); // {text, type}
  const bannerTimer = useRef(null);

  // Scanner UI
  const [scanOpen, setScanOpen] = useState(false);

  // Cameras (for flip)
  const [videoInputs, setVideoInputs] = useState([]); // [{deviceId,label}]
  const [cameraIndex, setCameraIndex] = useState(0);

  // Quagga lifecycle flags
  const quaggaRunningRef = useRef(false);

  // Debounce / confirm detections (reduces false reads)
  const lastDetectedRef = useRef({ text: "", t: 0, streak: 0 });

  const title = useMemo(
    () => (mode === "events" ? "Events" : "Distribution"),
    [mode]
  );

  function showBanner(text, type = "ok", seconds = 1.5) {
    setBanner({ text, type });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), seconds * 1000);
  }

  function dismissWelcome() {
    if (screen !== "welcome") return;
    setWelcomeStage("out");
    setTimeout(() => setScreen("app"), 350);
  }

  // Welcome: 3 seconds then fade out (tap anywhere also dismisses)
  useEffect(() => {
    if (screen !== "welcome") return;
    setWelcomeStage("in");
    const t1 = setTimeout(() => setWelcomeStage("out"), 2600);
    const t2 = setTimeout(() => setScreen("app"), 3000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [screen]);

  async function loadRecords() {
    const rows = await db.records.where({ mode }).toArray();
    setRecords(rows);
  }

  useEffect(() => {
    if (screen === "app") loadRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, mode]);

  // Auto-submit on exactly 7 digits in Events mode (typing)
  useEffect(() => {
    const v = scan.trim();
    if (mode === "events" && /^\d{7}$/.test(v)) {
      const t = setTimeout(() => handleSubmit(v), 50);
      return () => clearTimeout(t);
    }
  }, [scan, mode]); // eslint-disable-line

  // CSV import/export
  async function importCSV(file) {
    const rows = (await parseCSV(file)).map((r) => {
      const ID = normalizeId(r.ID);
      const Name = String(r.Name ?? "").trim();
      const Type = r.Type ?? r.Size ?? "";
      return {
        ID,
        Name,
        Type,
        Scanned: r.Scanned ?? "",
        Received: r.Received ?? "",
        Timestamp: r.Timestamp ?? "",
      };
    });

    // Replace current mode roster with imported rows
    await db.records.where({ mode }).delete();

    const toInsert = rows
      .filter((r) => r.ID || r.Name)
      .map((r) => ({
        mode,
        studentId: r.ID,
        name: r.Name,
        type: r.Type,
        scanned: String(r.Scanned).toLowerCase() === "yes",
        received: String(r.Received).toLowerCase() === "yes",
        timestamp: r.Timestamp || "",
      }));

    await db.records.bulkAdd(toInsert);
    await loadRecords();
    showBanner(`Imported ${toInsert.length} rows`, "ok", 1.5);
  }

  async function exportCSV() {
    const rows = records;

    if (mode === "events") {
      downloadCSV(
        `events-export.csv`,
        rows.map((r) => ({
          ID: r.studentId ?? "",
          Name: r.name ?? "",
          Scanned: r.scanned ? "Yes" : "No",
          Timestamp: r.timestamp ?? "",
        })),
        ["ID", "Name", "Scanned", "Timestamp"]
      );
    } else {
      downloadCSV(
        `distribution-export.csv`,
        rows.map((r) => ({
          ID: r.studentId ?? "",
          Name: r.name ?? "",
          Type: r.type ?? "",
          Received: r.received ? "Yes" : "No",
          Timestamp: r.timestamp ?? "",
        })),
        ["ID", "Name", "Type", "Received", "Timestamp"]
      );
    }
  }

  async function handleSubmit(raw) {
    const value = String(raw ?? "").trim();
    if (!value) return;

    const list = await db.records.where({ mode }).toArray();
    await processValueAgainstList(value, list);
    setScan("");
  }

  async function processValueAgainstList(value, list) {
    if (mode === "events") {
      const id = normalizeId(value);
      const target = list.find((r) => (r.studentId ?? "") === id);
      if (!target) {
        showBanner("Not found!", "bad", 1.2);
        return;
      }
      if (target.scanned) {
        showBanner("Already checked in!", "bad", 1.2);
        return;
      }
      await db.records.update(target.id, { scanned: true, timestamp: nowStamp() });
      await loadRecords();
      showBanner(`✅ Thank you\n${target.name || ""}`, "ok", 1.2);
      return;
    }

    // distribution: match ID or Name, mark first unreceived
    const v = value.trim().toLowerCase();
    const id = normalizeId(value);
    const matches = list.filter(
      (r) =>
        (r.studentId ?? "").trim() === id ||
        (r.name ?? "").trim().toLowerCase() === v
    );

    if (!matches.length) {
      showBanner("Not ordered!", "bad", 1.6);
      return;
    }

    const total = matches.length;
    const receivedCount = matches.filter((r) => r.received).length;
    const next = matches.find((r) => !r.received);

    if (!next) {
      showBanner("All items already received!", "bad", 1.8);
      return;
    }

    await db.records.update(next.id, { received: true, timestamp: nowStamp() });
    await loadRecords();
    const nowReceived = receivedCount + 1;
    showBanner(
      `✅ Thank you ${next.name || ""}\nType: ${next.type || ""}\nReceived: ${nowReceived} of ${total}`,
      "ok",
      2.5
    );
  }

  async function resetAll() {
    await db.records.clear();
    setRecords([]);
    showBanner("Cleared all records.", "ok", 1.5);
  }

  // ---- QUAGGA2 LIVE SCANNER (demo-style: locate + overlay boxes) ----

  // Best-effort: refresh cameras for flip. (Labels appear after permission.)
  async function refreshVideoInputs() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      const vids = devices.filter((d) => d.kind === "videoinput");
      const list = vids.map((d) => ({ deviceId: d.deviceId, label: d.label || "Camera" }));
      setVideoInputs(list);
      return list;
    } catch {
      return [];
    }
  }

  function stopScanner() {
    try {
      if (!quaggaRunningRef.current) return;
      Quagga.offDetected(onDetected);
      Quagga.offProcessed(onProcessed);
      Quagga.stop();
    } catch {
      // ignore
    } finally {
      quaggaRunningRef.current = false;
      lastDetectedRef.current = { text: "", t: 0, streak: 0 };
    }
  }

  function onProcessed(result) {
    try {
      const ctx = Quagga.canvas?.ctx?.overlay;
      const canvas = Quagga.canvas?.dom?.overlay;
      if (!ctx || !canvas) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (result) {
        // many small boxes while it searches (demo behavior)
        if (result.boxes) {
          result.boxes
            .filter((b) => b !== result.box)
            .forEach((box) => {
              Quagga.ImageDebug.drawPath(box, { x: 0, y: 1 }, ctx, {
                color: "rgba(0,255,0,0.35)",
                lineWidth: 2,
              });
            });
        }

        // best candidate
        if (result.box) {
          Quagga.ImageDebug.drawPath(result.box, { x: 0, y: 1 }, ctx, {
            color: "rgba(0,255,0,0.9)",
            lineWidth: 3,
          });
        }

        // scan line
        if (result.line) {
          Quagga.ImageDebug.drawPath(result.line, { x: "x", y: "y" }, ctx, {
            color: "rgba(255,0,0,0.9)",
            lineWidth: 3,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  function onDetected(result) {
    const code = result?.codeResult?.code;
    if (!code) return;

    // require 2 quick confirmations to reduce misreads, but still feel fast
    const now = Date.now();
    const last = lastDetectedRef.current;

    if (code === last.text && now - last.t < 900) {
      last.streak += 1;
    } else {
      last.text = code;
      last.t = now;
      last.streak = 1;
    }

    if (last.streak < 2) return;

    // cooldown so it doesn't spam
    last.t = now;
    last.streak = 0;

    handleSubmit(code);
  }

  function startScanner() {
    try {
      if (quaggaRunningRef.current) return;

      const targetEl = document.querySelector("#quagga-view");
      if (!targetEl) return;

      const useDeviceId = videoInputs?.[cameraIndex]?.deviceId;
      const constraints = useDeviceId
        ? { deviceId: { exact: useDeviceId } }
        : { facingMode: "environment" };

      Quagga.init(
        {
          numOfWorkers: Math.min(4, navigator.hardwareConcurrency || 2),
          inputStream: {
            type: "LiveStream",
            target: targetEl,
            constraints: {
              ...constraints,
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            // Full frame hunt like the demo
            area: { top: "0%", right: "0%", left: "0%", bottom: "0%" },
          },
          locator: {
            locate: true,
            halfSample: true,
            patchSize: "medium",
          },
          decoder: {
            readers: ["code_128_reader"],
          },
          locate: true,
        },
        async (err) => {
          if (err) {
            console.error(err);
            showBanner("Camera scan failed. Try reloading / HTTPS.", "bad", 2.0);
            setScanOpen(false);
            return;
          }

          Quagga.onProcessed(onProcessed);
          Quagga.onDetected(onDetected);
          Quagga.start();
          quaggaRunningRef.current = true;

          // after permissions, enumerate so flip works more reliably
          const list = await refreshVideoInputs();
          if (list?.length && cameraIndex >= list.length) setCameraIndex(0);
        }
      );
    } catch (e) {
      console.error(e);
      showBanner("Camera scan failed. Try reloading / HTTPS.", "bad", 2.0);
      setScanOpen(false);
    }
  }

  function flipCamera() {
    if (!videoInputs || videoInputs.length <= 1) return;
    stopScanner();
    setCameraIndex((i) => (i + 1) % videoInputs.length);
  }

  // Start/stop scanner
  useEffect(() => {
    if (!scanOpen) {
      stopScanner();
      return;
    }
    const t = setTimeout(() => startScanner(), 80);
    return () => {
      clearTimeout(t);
      stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanOpen]);

  // Restart on flip
  useEffect(() => {
    if (!scanOpen) return;
    const t = setTimeout(() => startScanner(), 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraIndex]);

  // ---- UI ----
  if (screen === "welcome") {
    return (
      <div style={styles.page} onClick={dismissWelcome}>
        <div
          style={{
            ...styles.card,
            opacity: welcomeStage === "in" ? 1 : 0,
            transform: welcomeStage === "in" ? "translateY(0px)" : "translateY(10px)",
            transition: "opacity 420ms ease, transform 420ms ease",
          }}
        >
          <div style={styles.welcomeLogoWrap}>
            <img src="/sga-logo.png" alt="SGA" style={styles.welcomeLogo} />
          </div>
          <div style={styles.h1}>{getGreeting()}</div>
          <div style={{ ...styles.p, marginBottom: 6 }}>{formatDateLong()}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {banner && (
        <div
          style={{
            ...styles.banner,
            background: banner.type === "ok" ? "#16a34a" : "#ef4444",
          }}
          onClick={() => setBanner(null)}
        >
          <div
            style={{
              whiteSpace: "pre-line",
              textAlign: "center",
              fontWeight: 900,
              fontSize: 22,
            }}
          >
            {banner.text}
          </div>
          <div style={{ marginTop: 12, opacity: 0.95, fontWeight: 800 }}>
            Tap to dismiss
          </div>
        </div>
      )}

      {scanOpen && (
        <div style={styles.bigScanner}>
          <style>{`
            #quagga-view { position: relative; }
            #quagga-view video, #quagga-view canvas { width: 100% !important; height: 100% !important; }
            #quagga-view canvas { position: absolute !important; top: 0; left: 0; z-index: 3; }
            #quagga-view video { position: absolute !important; top: 0; left: 0; z-index: 2; object-fit: cover; }
            #quagga-view canvas { pointer-events: none; }
          `}</style>
          <div style={styles.cornerHeader}>
            <div style={{ fontWeight: 900, fontSize: 13 }}>Scan</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                style={{ ...styles.smallBtn, opacity: videoInputs.length > 1 ? 1 : 0.45 }}
                onClick={flipCamera}
                title="Flip camera"
                aria-label="Flip camera"
              >
                ↺
              </button>
              <button
                style={styles.xBtn}
                onClick={() => setScanOpen(false)}
                aria-label="Close scanner"
                title="Close"
              >
                ✕
              </button>
            </div>
          </div>

          <div id="quagga-view" style={styles.readerBody} />
          <div style={styles.scanHintBand} />
        </div>
      )}

      <div style={styles.top}>
        <div style={styles.header}>
          <img src="/sga-logo.png" alt="SGA" style={styles.logo} />
          <div style={styles.h1}>{title}</div>
        </div>

        <div style={styles.row}>
          <button
            style={{ ...styles.chip, background: mode === "events" ? "#111827" : "transparent" }}
            onClick={() => setMode("events")}
          >
            Events
          </button>
          <button
            style={{ ...styles.chip, background: mode === "distribution" ? "#111827" : "transparent" }}
            onClick={() => setMode("distribution")}
          >
            Distribution
          </button>
        </div>

        <div style={styles.row}>
          <input
            style={styles.input}
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder={mode === "events" ? "Scan/Type 7-digit ID" : "Enter ID or Name"}
            inputMode={mode === "events" ? "numeric" : "text"}
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button style={styles.btnPrimary} onClick={() => handleSubmit(scan)}>
            Submit
          </button>
        </div>

        <div style={styles.row}>
          <button
            style={styles.btnSecondary}
            onClick={() => {
              setScanOpen((v) => !v);
            }}
          >
            {scanOpen ? "Hide Camera" : "Camera Scan"}
          </button>

          <label style={styles.fileBtn}>
            Import CSV
            <input
              type="file"
              accept=".csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importCSV(f);
                e.target.value = "";
              }}
            />
          </label>

          <button style={styles.btnSecondary} onClick={exportCSV}>
            Export CSV
          </button>

          <button style={styles.btnDanger} onClick={resetAll}>
            Reset
          </button>
        </div>
      </div>

      <div style={styles.list}>
        {records.length === 0 ? (
          <div style={styles.empty}>No records yet. Import a CSV.</div>
        ) : (
          records
            .slice()
            .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
            .map((r) => {
              const status =
                mode === "events"
                  ? r.scanned
                    ? "Checked In"
                    : "Not Yet"
                  : r.received
                  ? "Received"
                  : "Not Yet";

              return (
                <button
                  key={r.id}
                  style={styles.rowItem}
                  onClick={() =>
                    handleSubmit(mode === "events" ? r.studentId : r.studentId || r.name)
                  }
                >
                  <div style={{ fontWeight: 900 }}>{r.name || "(No name)"}</div>
                  <div style={{ opacity: 0.9, fontSize: 13 }}>
                    ID: {r.studentId || "—"}
                    {mode === "distribution" ? ` • Type: ${r.type || "—"}` : ""}
                  </div>
                  <div style={{ marginTop: 6, fontWeight: 800, opacity: 0.95 }}>
                    {status}
                    {r.timestamp ? ` • ${r.timestamp}` : ""}
                  </div>
                </button>
              );
            })
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#0f172a",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    padding: 14,
  },
  top: {
    maxWidth: 760,
    margin: "0 auto",
    padding: 12,
    background: "#0b1220",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.08)",
  },
  card: {
    maxWidth: 560,
    margin: "14vh auto 0",
    padding: 18,
    background: "#0b1220",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.08)",
  },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 6 },
  logo: { height: 44, width: 44, objectFit: "contain" },

  welcomeLogoWrap: { display: "flex", justifyContent: "center", marginBottom: 12 },
  welcomeLogo: { height: 86, width: 86, objectFit: "contain" },

  h1: { fontSize: 22, fontWeight: 900, marginBottom: 6 },
  p: { opacity: 0.9, marginBottom: 12, lineHeight: 1.35 },

  row: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 10 },
  chip: {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "transparent",
    color: "#e5e7eb",
    fontWeight: 900,
  },
  input: {
    flex: 1,
    minWidth: 220,
    padding: "12px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#111827",
    color: "#e5e7eb",
    fontWeight: 900,
    fontSize: 16,
  },
  btnPrimary: {
    padding: "12px 14px",
    borderRadius: 12,
    border: "none",
    background: "#22c55e",
    color: "white",
    fontWeight: 900,
  },
  btnSecondary: {
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#111827",
    color: "#e5e7eb",
    fontWeight: 900,
  },
  btnDanger: {
    padding: "12px 14px",
    borderRadius: 12,
    border: "none",
    background: "#ef4444",
    color: "white",
    fontWeight: 900,
  },
  fileBtn: {
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#111827",
    color: "#e5e7eb",
    fontWeight: 900,
    cursor: "pointer",
  },

  list: { maxWidth: 760, margin: "12px auto 0" },
  rowItem: {
    width: "100%",
    textAlign: "left",
    padding: 14,
    marginTop: 10,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "#0b1220",
    color: "#e5e7eb",
  },
  empty: { opacity: 0.85, padding: 18 },

  banner: {
    position: "fixed",
    inset: 0,
    display: "grid",
    placeItems: "center",
    zIndex: 50,
    padding: 24,
    color: "white",
  },

  cornerScanner: {
    position: "fixed",
    right: 12,
    bottom: 12,
    width: 290,
    height: 320,
    background: "#0b1220",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 16,
    overflow: "hidden",
    zIndex: 40,
    boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
  },

  bigScanner: {
    position: "fixed",
    left: 12,
    right: 12,
    bottom: 12,
    height: "55vh",
    background: "#0b1220",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 16,
    overflow: "hidden",
    zIndex: 40,
    boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
  },

  cornerHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },

  smallBtn: {
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#111827",
    color: "#e5e7eb",
    fontWeight: 900,
    fontSize: 14,
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 10,
  },
  xBtn: {
    border: "none",
    background: "transparent",
    color: "#e5e7eb",
    fontWeight: 900,
    fontSize: 16,
    cursor: "pointer",
    padding: "2px 6px",
    borderRadius: 8,
  },

  readerBody: {
    width: "100%",
    height: "100%",
    position: "relative",
    overflow: "hidden",
  },

  // subtle band hint (doesn't tell the user what to do, just helps aim)
  scanHintBand: {
    position: "absolute",
    left: "5%",
    right: "5%",
    top: "45%",
    height: 2,
    background: "rgba(255,255,255,0.10)",
    pointerEvents: "none",
  },
};
