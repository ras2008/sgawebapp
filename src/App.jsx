import React, { useEffect, useMemo, useRef, useState } from "react";
import Quagga from "@ericblade/quagga2";
import { db } from "./db";
import { downloadCSV, parseCSV } from "./csv";

/**
 * SGA PWA — App.jsx (CODE 39 ONLY)
 *
 * Notes:
 * - Scanner configured for Code 39 ONLY (Quagga2: code_39_reader).
 * - Includes: search (name/ID), progress pills w/ bar + remaining, offline indicator.
 * - Camera does NOT auto-open on launch; user taps "Camera Scan".
 * - Data persists locally via IndexedDB (Dexie). Offline use works after first load.
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

  const [query, setQuery] = useState("");
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  const [banner, setBanner] = useState(null); // {text, type}
  const bannerTimer = useRef(null);

  // Scanner UI
  const [scanOpen, setScanOpen] = useState(false);
  const [scannerStatus, setScannerStatus] = useState("idle"); // idle | starting | running | error
  const [rotation, setRotation] = useState(0); // 0 | 90 | 180 | 270
  const [rotScale, setRotScale] = useState(1);
  const processedCountRef = useRef(0);
  const lastBoxRef = useRef(0);

  // Cameras (for flip)
  const [videoInputs, setVideoInputs] = useState([]); // [{deviceId,label}]
  const [cameraIndex, setCameraIndex] = useState(0);

  // Quagga lifecycle flags
  const quaggaRunningRef = useRef(false);

  // Debounce detections
  const lastDetectedRef = useRef({ text: "", t: 0 });

  const title = useMemo(
    () => (mode === "events" ? "Events" : "Distribution"),
    [mode]
  );

  const totalCount = records.length;
  const doneCount = useMemo(() => {
    if (mode === "events") return records.filter((r) => r.scanned).length;
    return records.filter((r) => r.received).length;
  }, [records, mode]);
  const remainingCount = Math.max(0, totalCount - doneCount);
  const progressPct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;

  const filteredRecords = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => {
      const name = String(r.name ?? "").toLowerCase();
      const id = String(r.studentId ?? "").toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }, [records, query]);

  function showBanner(text, type = "ok", seconds = 1.5) {
    setBanner({ text, type });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), seconds * 1000);
  }

  function dismissWelcome() {
    if (screen !== "welcome") return;
    setWelcomeStage("out");
    setTimeout(() => {
      setScreen("app");
    }, 420);
  }

  // Welcome: 3 seconds then fade out (tap anywhere also dismisses)
  useEffect(() => {
    if (screen !== "welcome") return;
    setWelcomeStage("in");
    const t1 = setTimeout(() => setWelcomeStage("out"), 2600);
    const t2 = setTimeout(() => {
      setScreen("app");
    }, 3000);
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

  useEffect(() => {
    function onOn() {
      setIsOnline(true);
      showBanner("Back online", "ok", 0.8);
    }
    function onOff() {
      setIsOnline(false);
      showBanner("Offline mode", "bad", 1.0);
    }
    window.addEventListener("online", onOn);
    window.addEventListener("offline", onOff);
    return () => {
      window.removeEventListener("online", onOn);
      window.removeEventListener("offline", onOff);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const ok = window.confirm(
      "Are you sure you want to reset? This will delete all records (including imported CSV data)."
    );
    if (!ok) return;

    await db.records.clear();
    setRecords([]);
    showBanner("Cleared all records.", "ok", 1.5);
  }

  // ---- QUAGGA2 LIVE SCANNER (CODE 39 ONLY) ----

  async function refreshVideoInputs() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      const vids = devices.filter((d) => d.kind === "videoinput");
      const list = vids.map((d) => ({
        deviceId: d.deviceId,
        label: d.label || "Camera",
      }));
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
      lastDetectedRef.current = { text: "", t: 0 };
      setRotation(0);
      setRotScale(1);
      setScannerStatus("idle");
    }
  }

  function extractStudentIdFromBarcode(code) {
    const raw = String(code ?? "").trim().replace(/^\*+|\*+$/g, "");

    const m7 = raw.match(/\b(\d{7})\b/);
    if (m7) return m7[1];

    const digits = raw.replace(/\D/g, "");

    if (digits.length === 7) return digits;
    if (digits.length === 6) return "0" + digits;
    if (digits.length > 7) return digits.slice(-7);

    return raw;
  }

  function onDetected(result) {
    const code = result?.codeResult?.code;
    if (!code) return;

    const id = extractStudentIdFromBarcode(code);
    if (!id) return;

    const now = Date.now();
    const last = lastDetectedRef.current;
    if (id === last.text && now - last.t < 1400) return;

    lastDetectedRef.current = { text: id, t: now };
    handleSubmit(id);
  }

  function onProcessed(result) {
    try {
      processedCountRef.current += 1;
      if (scannerStatus !== "running") setScannerStatus("running");

      const ctx = Quagga.canvas?.ctx?.overlay;
      const canvas = Quagga.canvas?.dom?.overlay;
      if (!ctx || !canvas) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (result) {
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

        if (result.box) {
          Quagga.ImageDebug.drawPath(result.box, { x: 0, y: 1 }, ctx, {
            color: "rgba(0,255,0,0.9)",
            lineWidth: 3,
          });

          const now = Date.now();
          if (now - lastBoxRef.current > 1200) {
            lastBoxRef.current = now;
            showBanner("Locked on barcode…", "ok", 0.6);
          }
        }

        if (result.line) {
          Quagga.ImageDebug.drawPath(result.line, { x: "x", y: "y" }, ctx, {
            color: "rgba(255,0,0,0.9)",
            lineWidth: 3,
          });
        }

        if (result.codeResult?.code) {
          onDetected({ codeResult: { code: result.codeResult.code } });
        }
      }
    } catch {
      // ignore
    }
  }

  function startScanner() {
    setScannerStatus("starting");
    try {
      if (quaggaRunningRef.current) return;

      const targetEl = document.querySelector("#quagga-view");
      if (!targetEl) {
        setScannerStatus("error");
        showBanner("Scanner mount missing (#quagga-view)", "bad", 2.0);
        return;
      }

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
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 30, max: 30 },
            },
            // area removed to allow full frame scanning
          },
          locator: {
            locate: true,
            halfSample: false,
            patchSize: "medium",
          },
          decoder: {
            readers: ["code_39_reader"],
          },
          locate: true,
        },
        async (err) => {
          if (err) {
            console.error(err);
            setScannerStatus("error");
            showBanner("Camera scan failed. Try HTTPS / permissions.", "bad", 2.0);
            setScanOpen(false);
            return;
          }

          Quagga.onProcessed(onProcessed);
          Quagga.onDetected(onDetected);
          Quagga.start();
          setScannerStatus("running");
          quaggaRunningRef.current = true;

          const list = await refreshVideoInputs();
          if (list?.length && cameraIndex >= list.length) setCameraIndex(0);
        }
      );
    } catch (e) {
      console.error(e);
      setScannerStatus("error");
      showBanner("Camera scan failed. Try HTTPS / permissions.", "bad", 2.0);
      setScanOpen(false);
    }
  }

  function rotateCamera() {
    setRotation((r) => (r + 90) % 360);
  }

  function flipCamera() {
    if (!videoInputs || videoInputs.length <= 1) return;
    stopScanner();
    setCameraIndex((i) => (i + 1) % videoInputs.length);
  }

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

  useEffect(() => {
    if (!scanOpen) {
      setRotScale(1);
      return;
    }
    const el = document.querySelector("#quagga-view");
    if (!el) return;

    function compute() {
      const rect = el.getBoundingClientRect();
      const w = rect.width || 1;
      const h = rect.height || 1;
      if (rotation === 90 || rotation === 270) {
        setRotScale(Math.max(w / h, h / w));
      } else {
        setRotScale(1);
      }
    }

    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [scanOpen, rotation]);

  useEffect(() => {
    if (!scanOpen) return;
    const t = setTimeout(() => startScanner(), 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraIndex]);

  if (screen === "welcome") {
    return (
      <div id="welcome-page" style={styles.welcomePage} onClick={dismissWelcome}>
        <style>{`
          @keyframes float1 { 0% { transform: translate3d(-10px, 0, 0) scale(1); } 50% { transform: translate3d(12px, -14px, 0) scale(1.08);} 100% { transform: translate3d(-10px, 0, 0) scale(1);} }
          @keyframes float2 { 0% { transform: translate3d(10px, 0, 0) scale(1); } 50% { transform: translate3d(-16px, 12px, 0) scale(1.06);} 100% { transform: translate3d(10px, 0, 0) scale(1);} }
          @keyframes pop { 0% { transform: translateY(14px) scale(.98); opacity: 0; } 100% { transform: translateY(0px) scale(1); opacity: 1; } }
          @keyframes logoPulse { 0% { transform: scale(1); } 50% { transform: scale(1.04); } 100% { transform: scale(1); } }

          /* Mobile welcome layout fixes */
          #welcome-page { min-height: 100dvh; }
          #welcome-card { transform-origin: center center; }

          @media (max-width: 420px) {
            #welcome-card { width: 92vw !important; padding: 16px !important; border-radius: 16px !important; }
            #welcome-card img { width: 84px !important; height: 84px !important; }
          }
          @media (max-height: 740px) {
            #welcome-card { padding: 16px !important; }
          }

          /* iOS Safari/PWA viewport centering */
          html, body { height: 100%; }
          #welcome-page {
            height: 100vh;
            height: 100svh;
            height: 100dvh;
            min-height: -webkit-fill-available;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          /* Slightly lift the card on tall iPhones so it feels centered */
          @media (max-width: 430px) and (min-height: 800px) {
            #welcome-card { margin-top: -18px !important; }
          }
        `}</style>

        <div aria-hidden style={styles.welcomeBg}>
          <div style={{ ...styles.blob, ...styles.blobA }} />
          <div style={{ ...styles.blob, ...styles.blobB }} />
        </div>

        <div
          id="welcome-card"
          style={{
            ...styles.welcomeCard,
            opacity: welcomeStage === "in" ? 1 : 0,
            transform:
              welcomeStage === "in"
                ? "translateY(0px) scale(1)"
                : "translateY(-6px) scale(1.28)",
            transition:
              "opacity 420ms ease, transform 520ms cubic-bezier(0.2, 0.9, 0.2, 1)",
          }}
        >
          <div style={styles.welcomeLogoWrap}>
            <img src="/sga-logo.png" alt="SGA" style={styles.welcomeLogoHero} />
          </div>

          <div style={styles.welcomeTitle}>{getGreeting()}</div>
          <div style={styles.welcomeDate}>{formatDateLong()}</div>

          <div style={styles.welcomeTagline}>
            Scan fast • Track clean • Run events smoother
          </div>

          <div style={styles.welcomeCredit}>Made with ❤️ by the Class of 2027</div>
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

            /* Center the video/canvas so rotation stays centered */
            #quagga-view video, #quagga-view canvas {
              position: absolute !important;
              top: 50% !important;
              left: 50% !important;
              width: 100% !important;
              height: 100% !important;
              transform-origin: center center !important;
            }

            #quagga-view canvas { z-index: 3; pointer-events: none; }
            #quagga-view video { z-index: 2; object-fit: cover; }

            /* Rotation classes + scale (keeps full cover on iPad when rotated) */
            #quagga-view.rotate-0 video,  #quagga-view.rotate-0 canvas  { transform: translate(-50%, -50%) rotate(0deg) scale(var(--rot-scale, 1)); }
            #quagga-view.rotate-90 video, #quagga-view.rotate-90 canvas { transform: translate(-50%, -50%) rotate(90deg) scale(var(--rot-scale, 1)); }
            #quagga-view.rotate-180 video,#quagga-view.rotate-180 canvas{ transform: translate(-50%, -50%) rotate(180deg) scale(var(--rot-scale, 1)); }
            #quagga-view.rotate-270 video,#quagga-view.rotate-270 canvas{ transform: translate(-50%, -50%) rotate(270deg) scale(var(--rot-scale, 1)); }
          `}</style>

          <div style={styles.cornerHeader}>
            <div style={{ fontWeight: 900, fontSize: 13 }}>
              Scan{" "}
              <span style={{ opacity: 0.75, fontWeight: 800 }}>
                ({scannerStatus})
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                style={{
                  ...styles.smallBtn,
                  opacity: videoInputs.length > 1 ? 1 : 0.45,
                }}
                onClick={flipCamera}
                title="Flip camera"
                aria-label="Flip camera"
              >
                ↺
              </button>
              <button
                style={styles.smallBtn}
                onClick={rotateCamera}
                title="Rotate"
                aria-label="Rotate camera preview"
              >
                ⤾
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

          <div
            id="quagga-view"
            className={`rotate-${rotation}`}
            style={{ ...styles.readerBody, "--rot-scale": rotScale }}
          />
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
            style={{
              ...styles.chip,
              background: mode === "events" ? "#111827" : "transparent",
            }}
            onClick={() => setMode("events")}
          >
            Events
          </button>
          <button
            style={{
              ...styles.chip,
              background: mode === "distribution" ? "#111827" : "transparent",
            }}
            onClick={() => setMode("distribution")}
          >
            Distribution
          </button>
        </div>

        <div style={styles.pillRow}>
          <div style={styles.pill}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ fontWeight: 900 }}>
                {mode === "events" ? "Checked in" : "Received"}
              </span>
              <span style={{ fontWeight: 900 }}>
                {doneCount}/{totalCount}
              </span>
            </div>
            <div style={styles.pillBarOuter}>
              <div style={{ ...styles.pillBarInner, width: `${progressPct}%` }} />
            </div>
          </div>

          <div style={styles.pill}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ fontWeight: 900 }}>Remaining</span>
              <span style={{ fontWeight: 900 }}>{remainingCount}</span>
            </div>
            <div style={{ marginTop: 6, opacity: 0.8, fontWeight: 800, fontSize: 12 }}>
              {isOnline ? "Online" : "Offline"}
            </div>
          </div>
        </div>

        <div style={styles.row}>
          <input
            style={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search student name or ID"
            autoCapitalize="none"
            autoCorrect="off"
          />
          {query.trim() ? (
            <button style={styles.btnSecondary} onClick={() => setQuery("")}>
              Clear
            </button>
          ) : null}
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
              refreshVideoInputs();
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
        {filteredRecords.length === 0 ? (
          <div style={styles.empty}>
            {records.length === 0 ? "No records yet. Import a CSV." : "No matches."}
          </div>
        ) : (
          filteredRecords
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
                    handleSubmit(
                      mode === "events" ? r.studentId : r.studentId || r.name
                    )
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

      <div
        style={{
          marginTop: 18,
          textAlign: "center",
          fontSize: 12,
          opacity: 0.6,
          fontWeight: 700,
        }}
      >
        Made with ❤️ by the Class of 2027
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100dvh",
    background: "#0f172a",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    padding: 14,
  },

  welcomePage: {
    minHeight: "100dvh",
    padding: 14,
    paddingTop: "calc(14px + env(safe-area-inset-top))",
    paddingBottom: "calc(14px + env(safe-area-inset-bottom))",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    background:
      "radial-gradient(1200px 800px at 20% 10%, rgba(34,197,94,0.20), transparent 55%), radial-gradient(900px 700px at 85% 30%, rgba(59,130,246,0.22), transparent 55%), #0b1020",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
  },
  welcomeBg: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    overflow: "hidden",
  },
  blob: {
    position: "absolute",
    width: 520,
    height: 520,
    borderRadius: 999,
    filter: "blur(40px)",
    opacity: 0.7,
  },
  blobA: {
    left: "-140px",
    top: "-120px",
    background: "rgba(34,197,94,0.22)",
    animation: "float1 7s ease-in-out infinite",
  },
  blobB: {
    right: "-180px",
    bottom: "-180px",
    background: "rgba(59,130,246,0.24)",
    animation: "float2 8s ease-in-out infinite",
  },
  welcomeCard: {
    width: "min(520px, 92vw)",
    padding: 20,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(9, 14, 28, 0.70)",
    backdropFilter: "blur(10px)",
    boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
    animation: "pop 520ms ease",
  },
  welcomeLogoWrap: {
    display: "flex",
    justifyContent: "center",
    marginBottom: 12,
    position: "relative",
  },
  welcomeLogoHero: {
    height: 92,
    width: 92,
    objectFit: "contain",
    position: "relative",
    animation: "logoPulse 2.4s ease-in-out infinite",
  },
  welcomeTitle: {
    fontSize: 24,
    fontWeight: 950,
    marginTop: 10,
    marginBottom: 6,
    letterSpacing: "-0.02em",
    textAlign: "center",
  },
  welcomeDate: {
    opacity: 0.9,
    marginBottom: 10,
    fontWeight: 800,
    textAlign: "center",
  },
  welcomeTagline: {
    textAlign: "center",
    fontSize: 13,
    fontWeight: 800,
    opacity: 0.78,
    marginTop: 6,
  },
  welcomeCredit: {
    marginTop: 14,
    fontSize: 13,
    opacity: 0.75,
    fontWeight: 800,
    textAlign: "center",
  },

  top: {
    maxWidth: 760,
    margin: "0 auto",
    padding: 12,
    background: "#0b1220",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.08)",
  },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 6 },
  logo: { height: 44, width: 44, objectFit: "contain" },
  h1: { fontSize: 22, fontWeight: 900, marginBottom: 6 },

  row: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: 10,
  },

  pillRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 12,
  },
  pill: {
    flex: "1 1 220px",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(17, 24, 39, 0.75)",
  },
  pillBarOuter: {
    marginTop: 10,
    height: 10,
    borderRadius: 999,
    background: "rgba(255,255,255,0.10)",
    overflow: "hidden",
  },
  pillBarInner: {
    height: "100%",
    borderRadius: 999,
    background: "#22c55e",
    width: "0%",
  },

  chip: {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "transparent",
    color: "#e5e7eb",
    fontWeight: 900,
  },

  searchInput: {
    flex: 1,
    minWidth: 240,
    padding: "12px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#0b1220",
    color: "#e5e7eb",
    fontWeight: 900,
    fontSize: 15,
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
