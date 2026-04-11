import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.json());

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const starter = {
      commissions: [
        { va: "Alice", timestamp: Date.now() - 8 * 60 * 1000 },
        { va: "Alice", timestamp: Date.now() - 5 * 60 * 1000 },
        { va: "Alice", timestamp: Date.now() - 2 * 60 * 1000 },

        { va: "Brenda", timestamp: Date.now() - 9 * 60 * 1000 },
        { va: "Brenda", timestamp: Date.now() - 6 * 60 * 1000 },
        { va: "Brenda", timestamp: Date.now() - 90 * 1000 },

        { va: "Carlos", timestamp: Date.now() - 7 * 60 * 1000 },
        { va: "Carlos", timestamp: Date.now() - 4 * 60 * 1000 }
      ]
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(starter, null, 2));
    return starter;
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to read data.json:", err);
    return { commissions: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function normalizeVAName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function displayVAName(name) {
  const trimmed = String(name || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "Unknown VA";
  return trimmed
    .split(" ")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getUniqueVAs(commissions) {
  const map = new Map();

  for (const c of commissions) {
    const key = normalizeVAName(c.va);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, displayVAName(c.va));
    }
  }

  return [...map.entries()].map(([key, label]) => ({
    key,
    label
  }));
}

function getVAStats(commissions, now = Date.now()) {
  const uniqueVAs = getUniqueVAs(commissions);

  return uniqueVAs.map(({ key, label }) => {
    const vaCommissions = commissions
      .filter(c => normalizeVAName(c.va) === key)
      .sort((a, b) => a.timestamp - b.timestamp);

    const total = vaCommissions.length;
    const last = total ? vaCommissions[total - 1].timestamp : null;

    let avgIntervalMs = null;
    let latestCycleMs = null;

    if (vaCommissions.length >= 2) {
      let totalDiff = 0;
      for (let i = 1; i < vaCommissions.length; i++) {
        const diff = vaCommissions[i].timestamp - vaCommissions[i - 1].timestamp;
        totalDiff += diff;
        if (i === vaCommissions.length - 1) {
          latestCycleMs = diff;
        }
      }
      avgIntervalMs = totalDiff / (vaCommissions.length - 1);
    }

    const minutesSinceLast = last ? (now - last) / 60000 : null;
    const throughputPerHour = avgIntervalMs ? 3600000 / avgIntervalMs : null;

    const tenMinAgo = now - 10 * 60 * 1000;
    const recent = vaCommissions.filter(c => c.timestamp >= tenMinAgo);
    const recentCount = recent.length;

    let rollingAvgMs = null;
    if (recent.length >= 2) {
      let rollingTotal = 0;
      for (let i = 1; i < recent.length; i++) {
        rollingTotal += recent[i].timestamp - recent[i - 1].timestamp;
      }
      rollingAvgMs = rollingTotal / (recent.length - 1);
    }

    return {
      key,
      label,
      total,
      lastCommissionAt: last,
      minutesSinceLast,
      avgIntervalMinutes: avgIntervalMs ? avgIntervalMs / 60000 : null,
      latestCycleMinutes: latestCycleMs ? latestCycleMs / 60000 : null,
      throughputPerHour,
      rollingAvgMinutes: rollingAvgMs ? rollingAvgMs / 60000 : null,
      receiptsLast10Min: recentCount
    };
  });
}

app.get("/api/state", (req, res) => {
  const data = loadData();
  const now = Date.now();

  res.json({
    now,
    commissions: data.commissions.sort((a, b) => a.timestamp - b.timestamp),
    vas: getVAStats(data.commissions, now)
  });
});

app.post("/api/commission", (req, res) => {
  const data = loadData();
  const rawName = req.body?.va;
  const timestamp = req.body?.timestamp ? Number(req.body.timestamp) : Date.now();

  if (!rawName || !String(rawName).trim()) {
    return res.status(400).json({ error: "VA name is required." });
  }

  const cleanName = displayVAName(rawName);

  data.commissions.push({
    va: cleanName,
    timestamp
  });

  saveData(data);

  res.json({
    success: true,
    added: {
      va: cleanName,
      timestamp
    }
  });
});

app.post("/api/notion-webhook", (req, res) => {
  try {
    const data = loadData();
    const body = req.body || {};

    const rawVA =
      body.va ||
      body.vaName ||
      body.va_name ||
      body.name ||
      body.employee ||
      body.employeeName ||
      body.assignee ||
      body.chatter;

    const rawTimestamp =
      body.timestamp ||
      body.time ||
      body.createdAt ||
      body.completedAt ||
      body.completed_at ||
      body.date;

    const rawStatus =
      body.status ||
      body.Status ||
      body.stage ||
      body.state;

    if (!rawVA || !String(rawVA).trim()) {
      return res.status(400).json({
        error: "VA name is required in webhook body."
      });
    }

    if (rawStatus && String(rawStatus).trim().toLowerCase() !== "completed") {
      return res.json({
        success: false,
        ignored: true,
        reason: "Status was not Completed."
      });
    }

    let parsedTimestamp = Date.now();

    if (rawTimestamp) {
      const t =
        typeof rawTimestamp === "number"
          ? rawTimestamp
          : Date.parse(String(rawTimestamp));

      if (!Number.isNaN(t)) {
        parsedTimestamp = t;
      }
    }

    const cleanName = displayVAName(rawVA);

    const duplicate = data.commissions.find(c => {
      return (
        normalizeVAName(c.va) === normalizeVAName(cleanName) &&
        Math.abs(c.timestamp - parsedTimestamp) <= 15000
      );
    });

    if (duplicate) {
      return res.json({
        success: true,
        duplicate: true,
        added: duplicate
      });
    }

    const newCommission = {
      va: cleanName,
      timestamp: parsedTimestamp
    };

    data.commissions.push(newCommission);
    saveData(data);

    return res.json({
      success: true,
      source: "notion-webhook",
      added: newCommission
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({
      error: "Webhook failed."
    });
  }
});

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Time Off Task Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #09111d;
      --panel: rgba(14, 21, 34, 0.88);
      --panel-2: rgba(22, 31, 47, 0.9);
      --border: rgba(255,255,255,0.08);
      --text: #f4f7fb;
      --muted: #9aa7b8;
      --good: #63d471;
      --warn: #f7b731;
      --bad: #ff6b6b;
      --shadow: 0 10px 30px rgba(0,0,0,0.35);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(78,130,255,0.09), transparent 28%),
        radial-gradient(circle at top right, rgba(190,78,255,0.08), transparent 24%),
        #050b14;
      color: var(--text);
      font-family: Inter, system-ui, Arial, sans-serif;
    }

    .wrap {
      max-width: 1750px;
      margin: 0 auto;
      padding: 18px;
    }

    .topbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .title {
      font-size: 34px;
      font-weight: 900;
      letter-spacing: -0.03em;
    }

    .subtitle {
      color: #a7b6cb;
      font-size: 16px;
      margin-top: 6px;
    }

    .pill {
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
      color: #a7b6cb;
      border-radius: 999px;
      padding: 14px 18px;
      font-size: 14px;
    }

    .summary-row {
      display: grid;
      grid-template-columns: repeat(5, minmax(160px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }

    .metric-box {
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 18px 18px;
      box-shadow: var(--shadow);
      min-height: 108px;
    }

    .metric-label {
      color: #9db0ca;
      font-size: 14px;
      margin-bottom: 10px;
    }

    .metric-value {
      font-size: 31px;
      font-weight: 900;
      letter-spacing: -0.03em;
    }

    .main-grid {
      display: grid;
      grid-template-columns: 1.6fr 1fr;
      gap: 18px;
      align-items: start;
    }

    .panel {
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      border: 1px solid var(--border);
      border-radius: 28px;
      box-shadow: var(--shadow);
    }

    .panel-pad {
      padding: 22px;
    }

    .panel-title {
      font-size: 17px;
      font-weight: 900;
      color: #eef4ff;
      margin-bottom: 8px;
    }

    .panel-subtitle {
      color: #9db0ca;
      font-size: 14px;
      margin-bottom: 14px;
    }

    .chart-wrap {
      height: 470px;
    }

    .va-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(280px, 1fr));
      gap: 14px;
    }

    .va-card {
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      border: 1px solid var(--border);
      border-radius: 26px;
      padding: 16px;
      min-height: 360px;
    }

    .va-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 14px;
    }

    .va-name {
      font-size: 18px;
      font-weight: 900;
      color: #f5f8ff;
    }

    .status-pill {
      font-size: 13px;
      padding: 8px 14px;
      border-radius: 999px;
      font-weight: 900;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    .status-good {
      background: rgba(27, 145, 94, 0.16);
      color: #55ef9e;
      border-color: rgba(85,239,158,0.22);
    }

    .status-warn {
      background: rgba(247,183,49,0.14);
      color: #ffd36b;
      border-color: rgba(247,183,49,0.24);
    }

    .status-bad {
      background: rgba(255,107,107,0.14);
      color: #ff8f9a;
      border-color: rgba(255,107,107,0.24);
    }

    .va-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .mini-stat {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px;
      min-height: 92px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .mini-label {
      color: #9db0ca;
      font-size: 12px;
      line-height: 1.25;
    }

    .mini-value {
      font-size: 18px;
      font-weight: 900;
      line-height: 1.05;
      color: #f4f7fb;
      word-break: break-word;
    }

    .legend-note {
      color: #9db0ca;
      font-size: 12px;
      margin-top: 10px;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 14px;
    }

    input, button {
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
      color: var(--text);
      border-radius: 14px;
      padding: 11px 13px;
      font-size: 14px;
      outline: none;
    }

    input { min-width: 170px; }

    button {
      cursor: pointer;
      font-weight: 800;
    }

    @media (max-width: 1300px) {
      .main-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 1100px) {
      .summary-row {
        grid-template-columns: repeat(2, 1fr);
      }
      .va-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 650px) {
      .summary-row,
      .va-stats {
        grid-template-columns: 1fr;
      }
      .chart-wrap {
        height: 320px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div>
        <div class="title">VA Time Off Task Dashboard</div>
        <div class="subtitle">Live Notion-backed view with sawtooth interval trend, cycle time, and throughput.</div>
      </div>
      <div class="pill" id="lastRefresh">Last refresh: --</div>
    </div>

    <div class="summary-row">
      <div class="metric-box">
        <div class="metric-label">Total VAs</div>
        <div class="metric-value" id="totalVAs">0</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">On Pace</div>
        <div class="metric-value" id="onPaceCount">0</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Slowing Down</div>
        <div class="metric-value" id="slowingCount">0</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Off Task</div>
        <div class="metric-value" id="offTaskCount">0</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Receipts in Last 10 Min</div>
        <div class="metric-value" id="receiptsLast10">0</div>
      </div>
    </div>

    <div class="main-grid">
      <div class="panel panel-pad">
        <div class="panel-title">Commission Interval Trend</div>
        <div class="panel-subtitle">Past 10 minutes. Each line rises until the next commission drops it back to zero.</div>
        <div class="chart-wrap">
          <canvas id="intervalChart"></canvas>
        </div>
        <div class="legend-note">Status guide: on pace under 3 min, slowing down under 6 min, off task at 6+ min.</div>

        <div class="actions">
          <input id="vaInput" type="text" placeholder="Enter VA name" />
          <button id="addCommissionBtn">Add Commission</button>
        </div>
      </div>

      <div class="va-grid" id="vaGrid"></div>
    </div>
  </div>

  <script>
    const COLORS = [
      { border: "rgb(91, 143, 249)", fill: "rgba(91, 143, 249, 0.18)" },
      { border: "rgb(190, 120, 255)", fill: "rgba(190, 120, 255, 0.18)" },
      { border: "rgb(75, 192, 192)", fill: "rgba(75, 192, 192, 0.16)" },
      { border: "rgb(255, 205, 86)", fill: "rgba(255, 205, 86, 0.16)" },
      { border: "rgb(255, 99, 132)", fill: "rgba(255, 99, 132, 0.16)" },
      { border: "rgb(255, 159, 64)", fill: "rgba(255, 159, 64, 0.16)" },
      { border: "rgb(54, 162, 235)", fill: "rgba(54, 162, 235, 0.16)" },
      { border: "rgb(0, 220, 130)", fill: "rgba(0, 220, 130, 0.16)" }
    ];

    let latestState = {
      now: Date.now(),
      commissions: [],
      vas: []
    };

    function normalizeName(name) {
      return String(name || "").trim().replace(/\\s+/g, " ").toLowerCase();
    }

    function formatMinutes(value) {
      if (value == null || Number.isNaN(value)) return "--";
      if (value < 1) {
        return Math.round(value * 60) + " sec";
      }
      return value.toFixed(1) + " min";
    }

    function formatCycle(value) {
      if (value == null || Number.isNaN(value)) return "--";
      if (value >= 60) {
        return (value / 60).toFixed(1) + " hr";
      }
      return value.toFixed(1) + " min";
    }

    function formatThroughput(value) {
      if (value == null || Number.isNaN(value)) return "--";
      if (value === 0) return "--";
      const minutesPerCommission = 60 / value;
      return "1 commission / " + formatCycle(minutesPerCommission);
    }

    function formatClock(ts) {
      if (!ts) return "--";
      return new Date(ts).toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    }

    function getStatusClass(minutes) {
      if (minutes == null) return "status-warn";
      if (minutes < 3) return "status-good";
      if (minutes < 6) return "status-warn";
      return "status-bad";
    }

    function getStatusText(minutes) {
      if (minutes == null) return "No Data";
      if (minutes < 3) return "On Pace";
      if (minutes < 6) return "Slowing Down";
      return "Off Task";
    }

    function buildSeries(commissions, vaKey, endNow, windowMinutes = 10, stepSeconds = 5) {
      const start = endNow - windowMinutes * 60 * 1000;

      const vaCommissions = commissions
        .filter(c => normalizeName(c.va) === vaKey)
        .map(c => c.timestamp)
        .sort((a, b) => a - b);

      const points = [];
      let index = 0;
      let lastCommission = null;

      while (index < vaCommissions.length && vaCommissions[index] < start) {
        lastCommission = vaCommissions[index];
        index++;
      }

      for (let t = start; t <= endNow; t += stepSeconds * 1000) {
        while (index < vaCommissions.length && vaCommissions[index] <= t) {
          lastCommission = vaCommissions[index];
          index++;
        }

        points.push({
          x: t,
          y: lastCommission ? (t - lastCommission) / 60000 : null
        });
      }

      return points;
    }

    async function fetchState() {
      const res = await fetch("/api/state");
      latestState = await res.json();
      renderAll();
    }

    async function addCommission(name) {
      const res = await fetch("/api/commission", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ va: name })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to add commission.");
        return;
      }

      await fetchState();
    }

    const ctx = document.getElementById("intervalChart").getContext("2d");

    const chart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: []
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: "nearest",
          intersect: false
        },
        plugins: {
          legend: {
            position: "top",
            align: "end",
            labels: {
              color: "#dfe7f2",
              usePointStyle: true,
              pointStyle: "circle",
              boxWidth: 10,
              boxHeight: 10,
              padding: 18,
              font: {
                size: 12,
                weight: "700"
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const y = context.parsed.y;
                return context.dataset.label + ": " + (y == null ? "--" : y.toFixed(2) + " min");
              }
            }
          }
        },
        elements: {
          line: {
            tension: 0,
            borderWidth: 3
          },
          point: {
            radius: 0,
            hitRadius: 8,
            hoverRadius: 4
          }
        },
        scales: {
          x: {
            type: "linear",
            min: Date.now() - 10 * 60 * 1000,
            max: Date.now(),
            ticks: {
              color: "#9aa7b8",
              callback: function(value) {
                return new Date(value).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit"
                });
              }
            },
            grid: {
              color: "rgba(255,255,255,0.05)"
            }
          },
          y: {
            beginAtZero: true,
            suggestedMax: 15,
            ticks: {
              color: "#9aa7b8",
              callback: function(value) {
                return value + "m";
              }
            },
            title: {
              display: true,
              text: "Minutes since last commission",
              color: "#dfe7f2",
              font: {
                weight: "700"
              }
            },
            grid: {
              color: "rgba(255,255,255,0.05)"
            }
          }
        }
      }
    });

    function renderSummary() {
      const vas = latestState.vas || [];
      const commissions = latestState.commissions || [];
      const now = Date.now();
      const tenMinAgo = now - 10 * 60 * 1000;

      let onPace = 0;
      let slowing = 0;
      let offTask = 0;

      vas.forEach(v => {
        const mins = v.lastCommissionAt ? (now - v.lastCommissionAt) / 60000 : null;
        if (mins == null) {
          slowing++;
        } else if (mins < 3) {
          onPace++;
        } else if (mins < 6) {
          slowing++;
        } else {
          offTask++;
        }
      });

      const recentTotal = commissions.filter(c => c.timestamp >= tenMinAgo).length;

      document.getElementById("totalVAs").textContent = vas.length;
      document.getElementById("onPaceCount").textContent = onPace;
      document.getElementById("slowingCount").textContent = slowing;
      document.getElementById("offTaskCount").textContent = offTask;
      document.getElementById("receiptsLast10").textContent = recentTotal;
      document.getElementById("lastRefresh").textContent =
        "Last refresh: " +
        new Date(now).toLocaleString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit"
        });
    }

    function renderVACards() {
      const grid = document.getElementById("vaGrid");
      const now = Date.now();

      const refreshed = (latestState.vas || []).map(v => {
        const mins = v.lastCommissionAt ? (now - v.lastCommissionAt) / 60000 : null;
        return {
          ...v,
          minutesSinceLast: mins
        };
      });

      grid.innerHTML = "";

      refreshed.forEach(v => {
        const card = document.createElement("div");
        card.className = "va-card";

        card.innerHTML = \`
          <div class="va-head">
            <div class="va-name">\${v.label}</div>
            <div class="status-pill \${getStatusClass(v.minutesSinceLast)}">\${getStatusText(v.minutesSinceLast)}</div>
          </div>

          <div class="va-stats">
            <div class="mini-stat">
              <div class="mini-label">Minutes since last commission</div>
              <div class="mini-value">\${formatMinutes(v.minutesSinceLast)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Throughput</div>
              <div class="mini-value">\${formatThroughput(v.throughputPerHour)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Latest cycle time</div>
              <div class="mini-value">\${formatCycle(v.latestCycleMinutes)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Avg cycle time</div>
              <div class="mini-value">\${formatCycle(v.avgIntervalMinutes)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">10-min rolling avg</div>
              <div class="mini-value">\${formatCycle(v.rollingAvgMinutes)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Receipts last 10 min</div>
              <div class="mini-value">\${v.receiptsLast10Min ?? 0}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Receipt count</div>
              <div class="mini-value">\${v.total}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Last commission</div>
              <div class="mini-value">\${formatClock(v.lastCommissionAt)}</div>
            </div>
          </div>
        \`;

        grid.appendChild(card);
      });
    }

    function renderChart() {
      const vas = latestState.vas || [];
      const commissions = latestState.commissions || [];
      const now = Date.now();
      const start = now - 10 * 60 * 1000;

      chart.options.scales.x.min = start;
      chart.options.scales.x.max = now;

      chart.data.datasets = vas.map((va, i) => {
        const color = COLORS[i % COLORS.length];
        return {
          label: va.label,
          data: buildSeries(commissions, va.key, now, 10, 5),
          parsing: false,
          borderColor: color.border,
          backgroundColor: color.fill,
          fill: true,
          spanGaps: false
        };
      });

      chart.update("none");
    }

    function renderAll() {
      renderSummary();
      renderVACards();
      renderChart();
    }

    document.getElementById("addCommissionBtn").addEventListener("click", async () => {
      const input = document.getElementById("vaInput");
      const name = input.value.trim();
      if (!name) {
        alert("Enter a VA name first.");
        return;
      }

      await addCommission(name);
      input.value = "";
      input.focus();
    });

    document.getElementById("vaInput").addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        document.getElementById("addCommissionBtn").click();
      }
    });

    fetchState();

    setInterval(() => {
      renderSummary();
      renderVACards();
      renderChart();
    }, 1000);

    setInterval(() => {
      fetchState().catch(err => console.error("Refresh failed:", err));
    }, 5000);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
