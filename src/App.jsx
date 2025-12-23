import React, { useEffect, useMemo, useRef, useState } from "react";
import Quagga from "@ericblade/quagga2";
import { db } from "./db";
import { downloadCSV, parseCSV } from "./csv";

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
  const [scannerExpanded, setScannerExpanded] = useState(true); // expanded by default (best for small ID cards)

  // Camera flip (deviceId list)
  const [cameras, setCameras] = useState([]); // [{deviceId,label}]
  const [cameraIndex, setCameraIndex] = useState(0);

  // Quagga refs
  const quaggaActiveRef = useRef(false);
  const lastDetectedRef = useRef({ code: "", t: 0 });
  const viewportId = "quagga-viewport";

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

  // Welcome: 3 seconds then fade out (also tap anywhere)
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

  // Auto-submit on exactly 7 digits in Events mode
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

  // -------- Quagga2 scanner --------
  async function refreshCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const vids = devices.filter((d) => d.kind === "videoinput");
      setCameras(vids.map((d) => ({ deviceId: d.deviceId, label: d.label || "Camera" })));
      return vids;
    } catch {
      setCameras([]);
      return [];
    }
  }

  function stopScanner() {
    try {
      if (quaggaActiveRef.current) {
        Quagga.offDetected(onDetected);
        Quagga.stop();
      }
    } catch {
      // ignore
    } finally {
      quaggaActiveRef.current = false;
    }
  }

  function onDetected(result) {
    const code = result?.codeResult?.code ? String(result.codeResult.code).trim() : "";
    if (!code) return;

    const now = Date.now();
    const last = lastDetectedRef.current;
    if (code === last.code && now - last.t < 1200) return;
    lastDetectedRef.current = { code, t: now };

    handleSubmit(code);
  }

  async function startScanner() {
    if (quaggaActiveRef.current) return;

    if (!cameras.length) {
      await refreshCameras();
    }

    const picked = cameras.length ? cameras[Math.min(cameraIndex, cameras.length - 1)] : null;

    const target = document.getElementById(viewportId);
    if (!target) return;

    target.innerHTML = "";

    const constraints = picked?.deviceId
      ? { deviceId: { exact: picked.deviceId } }
      : { facingMode: "environment" };

    return new Promise((resolve, reject) => {
      Quagga.init(
        {
          inputStream: {
            type: "LiveStream",
            target,
            constraints: {
              ...constraints,
              width: { ideal: 1280 },
              height: { ideal: 720 },
              aspectRatio: { ideal: 1.777 },
            },
            area: {
              top: "38%",
              right: "6%",
              left: "6%",
              bottom: "38%",
            },
          },
          locator: {
            patchSize: "medium",
            halfSample: true,
          },
          numOfWorkers: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 2,
          frequency: 10,
          decoder: {
            readers: ["code_128_reader"],
            multiple: false,
          },
          locate: true,
        },
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          Quagga.onDetected(onDetected);
          Quagga.start();
          quaggaActiveRef.current = true;
          resolve();
        }
      );
    });
  }

  useEffect(() => {
    if (!scanOpen) {
      stopScanner();
      return;
    }
    (async () => {
      try {
        await startScanner();
        await refreshCameras();
      } catch (e) {
        showBanner("Camera scan not available. Try the HTTPS (Vercel) link.", "bad", 2.2);
        stopScanner();
        setScanOpen(false);
      }
    })();

    return () => stopScanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanOpen]);

  useEffect(() => {
    if (!scanOpen) return;
    (async () => {
      stopScanner();
      try {
        await startScanner();
      } catch {
        showBanner("Couldn’t switch camera.", "bad", 1.6);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraIndex]);

  useEffect(() => {
    if (!scanOpen) return;
    const t = setTimeout(() => {
      stopScanner();
      startScanner().catch(() => {});
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannerExpanded]);

  function flipCamera() {
    if (cameras.length <= 1) return;
    setCameraIndex((i) => (i + 1) % cameras.length);
  }

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
          <div style={{ whiteSpace: "pre-line", textAlign: "center", fontWeight: 900, fontSize: 22 }}>
            {banner.text}
          </div>
          <div style={{ marginTop: 12, opacity: 0.95, fontWeight: 800 }}>Tap to dismiss</div>
        </div>
      )}

      {scanOpen && (
        <div style={scannerExpanded ? styles.bigScanner : styles.cornerScanner}>
          <div style={styles.cornerHeader}>
            <div style={{ fontWeight: 900, fontSize: 13 }}>Scan</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                style={{ ...styles.smallBtn, opacity: cameras.length > 1 ? 1 : 0.45 }}
                onClick={flipCamera}
                title="Flip camera"
                aria-label="Flip camera"
              >
                ↺
              </button>
              <button
                style={styles.smallBtn}
                onClick={() => setScannerExpanded((v) => !v)}
                title="Resize"
                aria-label="Resize"
              >
                ⤢
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

          <div style={styles.readerBody}>
            <div id={viewportId} style={styles.viewport} />
            <div style={styles.aimGuide} />
          </div>
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
              setScannerExpanded(true);
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
                  onClick={() => handleSubmit(mode === "events" ? r.studentId : r.studentId || r.name)}
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
    width: 280,
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
    position: "relative",
    width: "100%",
    height: "calc(100% - 42px)",
    background: "#000",
  },
  viewport: {
    width: "100%",
    height: "100%",
  },
  aimGuide: {
    position: "absolute",
    left: "6%",
    right: "6%",
    top: "38%",
    bottom: "38%",
    border: "2px solid rgba(34,197,94,0.7)",
    borderRadius: 12,
    pointerEvents: "none",
    boxShadow: "0 0 0 9999px rgba(0,0,0,0.18) inset",
  },
};
