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
    if (vaCommissions.length >= 2) {
      let totalDiff = 0;
      for (let i = 1; i < vaCommissions.length; i++) {
        totalDiff += vaCommissions[i].timestamp - vaCommissions[i - 1].timestamp;
      }
      avgIntervalMs = totalDiff / (vaCommissions.length - 1);
    }

    const minutesSinceLast = last ? (now - last) / 60000 : null;
    const throughputPerHour = avgIntervalMs ? 3600000 / avgIntervalMs : null;

    return {
      key,
      label,
      total,
      lastCommissionAt: last,
      minutesSinceLast,
      avgIntervalMinutes: avgIntervalMs ? avgIntervalMs / 60000 : null,
      throughputPerHour
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
      --bg: #0b0f14;
      --panel: #121821;
      --panel-2: #171f2b;
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
        radial-gradient(circle at top left, rgba(78,130,255,0.08), transparent 28%),
        radial-gradient(circle at top right, rgba(190,78,255,0.07), transparent 24%),
        var(--bg);
      color: var(--text);
      font-family: Inter, system-ui, Arial, sans-serif;
    }

    .wrap {
      max-width: 1400px;
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
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .subtitle {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    input, button {
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
    }

    input {
      min-width: 180px;
    }

    button {
      cursor: pointer;
      font-weight: 700;
      transition: transform 0.12s ease, opacity 0.12s ease;
    }

    button:hover {
      transform: translateY(-1px);
      opacity: 0.95;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 14px;
      margin-bottom: 14px;
    }

    .panel {
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: var(--shadow);
    }

    .panel-pad {
      padding: 14px;
    }

    .panel-title {
      font-size: 14px;
      font-weight: 800;
      margin-bottom: 10px;
      color: #d9e2ef;
      letter-spacing: 0.01em;
    }

    .chart-wrap {
      height: 360px;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }

    .metric-box {
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      min-height: 88px;
    }

    .metric-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }

    .metric-value {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }

    .metric-sub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }

    .va-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-top: 10px;
    }

    .va-card {
      background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02));
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px;
      box-shadow: var(--shadow);
      min-height: 145px;
    }

    .va-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      gap: 10px;
    }

    .va-name {
      font-size: 17px;
      font-weight: 800;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      font-size: 11px;
      padding: 5px 8px;
      border-radius: 999px;
      font-weight: 800;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    .status-good {
      background: rgba(99,212,113,0.12);
      color: #91f2a0;
      border-color: rgba(99,212,113,0.28);
    }

    .status-warn {
      background: rgba(247,183,49,0.12);
      color: #ffd36b;
      border-color: rgba(247,183,49,0.28);
    }

    .status-bad {
      background: rgba(255,107,107,0.12);
      color: #ff9c9c;
      border-color: rgba(255,107,107,0.28);
    }

    .va-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .mini-stat {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px;
    }

    .mini-label {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 6px;
    }

    .mini-value {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .footnote {
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 980px) {
      .hero-grid {
        grid-template-columns: 1fr;
      }

      .summary-grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    @media (max-width: 640px) {
      .summary-grid,
      .va-stats {
        grid-template-columns: 1fr;
      }

      .chart-wrap {
        height: 300px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div>
        <div class="title">VA Time Off Task Dashboard</div>
        <div class="subtitle">Live sawtooth trend: minutes since each VA's last commission over the past 10 minutes</div>
      </div>

      <div class="actions">
        <input id="vaInput" type="text" placeholder="Enter VA name" />
        <button id="addCommissionBtn">Add Commission</button>
      </div>
    </div>

    <div class="hero-grid">
      <div class="panel panel-pad">
        <div class="panel-title">Commission Interval Trend</div>
        <div class="chart-wrap">
          <canvas id="intervalChart"></canvas>
        </div>
      </div>

      <div class="panel panel-pad">
        <div class="panel-title">Live Summary</div>
        <div class="summary-grid">
          <div class="metric-box">
            <div class="metric-label">Active VAs</div>
            <div class="metric-value" id="activeVAs">0</div>
            <div class="metric-sub">Unique VAs detected</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Total Commissions</div>
            <div class="metric-value" id="totalCommissions">0</div>
            <div class="metric-sub">All recorded entries</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Average Cycle Time</div>
            <div class="metric-value" id="avgCycleTime">--</div>
            <div class="metric-sub">Across all VAs</div>
          </div>
          <div class="metric-box">
            <div class="metric-label">Slowest Current Gap</div>
            <div class="metric-value" id="slowestGap">--</div>
            <div class="metric-sub">Highest minutes since last commission</div>
          </div>
        </div>
        <div class="footnote">Status colors are based on current minutes since last commission: good under 3m, warning under 6m, bad 6m+.</div>
      </div>
    </div>

    <div class="panel panel-pad">
      <div class="panel-title">VA Cards</div>
      <div class="va-grid" id="vaGrid"></div>
    </div>
  </div>

  <script>
    const COLORS = [
      { border: "rgb(91, 143, 249)", fill: "rgba(91, 143, 249, 0.18)" },
      { border: "rgb(255, 99, 132)", fill: "rgba(255, 99, 132, 0.16)" },
      { border: "rgb(75, 192, 192)", fill: "rgba(75, 192, 192, 0.16)" },
      { border: "rgb(255, 205, 86)", fill: "rgba(255, 205, 86, 0.16)" },
      { border: "rgb(180, 120, 255)", fill: "rgba(180, 120, 255, 0.16)" },
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
      if (value < 1) return value.toFixed(1) + "m";
      return value.toFixed(1) + "m";
    }

    function formatCycle(value) {
      if (value == null || Number.isNaN(value)) return "--";
      return value.toFixed(1) + " min";
    }

    function formatPerHour(value) {
      if (value == null || Number.isNaN(value)) return "--";
      return value.toFixed(1) + "/hr";
    }

    function formatClock(ts) {
      if (!ts) return "--";
      return new Date(ts).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      });
    }

    function getStatusClass(minutes) {
      if (minutes == null) return "status-warn";
      if (minutes < 3) return "status-good";
      if (minutes < 6) return "status-warn";
      return "status-bad";
    }

    function getStatusText(minutes) {
      if (minutes == null) return "No data";
      if (minutes < 3) return "On pace";
      if (minutes < 6) return "Slowing";
      return "Idle";
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

      for (let t = start; t <= endNow; t += stepSeconds * 1000) {
        while (index < vaCommissions.length && vaCommissions[index] <= t) {
          lastCommission = vaCommissions[index];
          index++;
        }

        const y = lastCommission ? (t - lastCommission) / 60000 : null;

        points.push({
          x: t,
          y: y
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
            labels: {
              color: "#dfe7f2",
              boxWidth: 14,
              boxHeight: 14,
              padding: 16,
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
                return \`\${context.dataset.label}: \${y == null ? "--" : y.toFixed(2) + " min"}\`;
              }
            }
          }
        },
        elements: {
          line: {
            tension: 0,
            borderWidth: 2.5
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
            ticks: {
              color: "#9aa7b8",
              callback: function(value) {
                return value + "m";
              }
            },
            title: {
              display: true,
              text: "Minutes Since Last Commission",
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

      document.getElementById("activeVAs").textContent = vas.length;
      document.getElementById("totalCommissions").textContent = commissions.length;

      const avgCycleValues = vas
        .map(v => v.avgIntervalMinutes)
        .filter(v => v != null && !Number.isNaN(v));

      const avgCycle =
        avgCycleValues.length
          ? avgCycleValues.reduce((a, b) => a + b, 0) / avgCycleValues.length
          : null;

      const currentMinutes = vas
        .map(v => v.minutesSinceLast)
        .filter(v => v != null && !Number.isNaN(v));

      const slowest =
        currentMinutes.length
          ? Math.max(...currentMinutes)
          : null;

      document.getElementById("avgCycleTime").textContent = avgCycle == null ? "--" : avgCycle.toFixed(1) + " min";
      document.getElementById("slowestGap").textContent = slowest == null ? "--" : slowest.toFixed(1) + " min";
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
            <div class="va-name" title="\${v.label}">\${v.label}</div>
            <div class="status-pill \${getStatusClass(v.minutesSinceLast)}">\${getStatusText(v.minutesSinceLast)}</div>
          </div>

          <div class="va-stats">
            <div class="mini-stat">
              <div class="mini-label">Minutes Since Last</div>
              <div class="mini-value">\${formatMinutes(v.minutesSinceLast)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Avg Cycle Time</div>
              <div class="mini-value">\${formatCycle(v.avgIntervalMinutes)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Throughput</div>
              <div class="mini-value">\${formatPerHour(v.throughputPerHour)}</div>
            </div>

            <div class="mini-stat">
              <div class="mini-label">Last Commission</div>
              <div class="mini-value" style="font-size:15px;">\${formatClock(v.lastCommissionAt)}</div>
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
  console.log(\`Server running on port \${PORT}\`);
});
