import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2026-03-11";

// Your two Notion data source IDs
const VA_COUNTER_DATA_SOURCE_ID =
  process.env.VA_COUNTER_DATA_SOURCE_ID || "339faa8b-4438-8046-adb2-000bc989e4ce";
const RECEIPTS_DATA_SOURCE_ID =
  process.env.RECEIPTS_DATA_SOURCE_ID || "33afaa8b-4438-80ec-80b1-000bbe5f6ccd";

if (!NOTION_TOKEN) {
  console.error("Missing NOTION_TOKEN in environment variables.");
  process.exit(1);
}

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...notionHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.message || `Notion API error (${response.status})`;
    throw new Error(message);
  }

  return data;
}

async function queryAllRows(dataSourceId, sorts = []) {
  let results = [];
  let hasMore = true;
  let startCursor;

  while (hasMore) {
    const body = {
      page_size: 100,
      ...(startCursor ? { start_cursor: startCursor } : {}),
      ...(sorts.length ? { sorts } : {}),
    };

    const data = await notionFetch(
      `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    results = results.concat(data.results || []);
    hasMore = Boolean(data.has_more);
    startCursor = data.next_cursor;
  }

  return results;
}

function getPlainTextFromArray(arr = []) {
  return arr.map((item) => item?.plain_text || "").join("").trim();
}

function formatPropertyValue(prop) {
  if (!prop) return null;

  switch (prop.type) {
    case "title":
      return getPlainTextFromArray(prop.title);
    case "rich_text":
      return getPlainTextFromArray(prop.rich_text);
    case "number":
      return prop.number;
    case "status":
      return prop.status?.name || null;
    case "select":
      return prop.select?.name || null;
    case "multi_select":
      return (prop.multi_select || []).map((x) => x.name);
    case "date":
      return prop.date?.start || null;
    case "created_time":
      return prop.created_time || null;
    case "people":
      return (prop.people || []).map((p) => p.name || p.person?.email || "").filter(Boolean);
    case "relation":
      return (prop.relation || []).map((x) => x.id);
    case "formula": {
      const f = prop.formula;
      if (!f) return null;
      if (f.type === "string") return f.string;
      if (f.type === "number") return f.number;
      if (f.type === "boolean") return f.boolean;
      if (f.type === "date") return f.date?.start || null;
      return null;
    }
    case "rollup": {
      const r = prop.rollup;
      if (!r) return null;
      if (r.type === "number") return r.number;
      if (r.type === "date") return r.date?.start || null;
      if (r.type === "array") return r.array;
      return null;
    }
    default:
      return null;
  }
}

function pickProperty(properties, candidates) {
  for (const name of candidates) {
    if (properties[name]) return properties[name];
  }
  return null;
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(isoString) {
  if (!isoString) return "—";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function humanizeMinutes(minutes) {
  if (typeof minutes !== "number" || Number.isNaN(minutes)) return "—";
  if (minutes < 1) return `${(minutes * 60).toFixed(0)} sec`;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)} hr`;
}

function deriveStatus(minutes) {
  if (typeof minutes !== "number") return "No data";
  if (minutes >= 15) return "Off Task";
  if (minutes >= 10) return "Slowing Down";
  return "On Pace";
}

function statusOrder(status) {
  if (status === "Off Task") return 0;
  if (status === "Slowing Down") return 1;
  if (status === "Active" || status === "On Pace") return 2;
  return 3;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueSortedDates(dates) {
  const seen = new Set();
  const out = [];

  for (const d of dates) {
    const iso = d.toISOString();
    if (!seen.has(iso)) {
      seen.add(iso);
      out.push(d);
    }
  }

  out.sort((a, b) => a.getTime() - b.getTime());
  return out;
}

function average(nums) {
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function buildIntervalsInMinutes(dates) {
  const intervals = [];
  for (let i = 1; i < dates.length; i++) {
    const diffMs = dates[i].getTime() - dates[i - 1].getTime();
    if (diffMs > 0) {
      intervals.push(diffMs / 60000);
    }
  }
  return intervals;
}

function findLastEventAtOrBefore(sortedDates, targetMs) {
  let lo = 0;
  let hi = sortedDates.length - 1;
  let answer = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const time = sortedDates[mid].getTime();

    if (time <= targetMs) {
      answer = sortedDates[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return answer;
}

function buildSawtoothSeries(sortedDates, now, windowMinutes = 10, stepSeconds = 15) {
  const endMs = now.getTime();
  const startMs = endMs - windowMinutes * 60000;
  const stepMs = stepSeconds * 1000;

  const points = [];
  for (let ts = startMs; ts <= endMs; ts += stepMs) {
    const lastEvent = findLastEventAtOrBefore(sortedDates, ts);
    if (!lastEvent) {
      points.push({
        t: new Date(ts).toISOString(),
        y: null,
      });
      continue;
    }

    const minutesSince = (ts - lastEvent.getTime()) / 60000;
    points.push({
      t: new Date(ts).toISOString(),
      y: Number(minutesSince.toFixed(2)),
    });
  }

  return points;
}

function normalizeVA(page) {
  const properties = page.properties || {};

  const name =
    formatPropertyValue(
      pickProperty(properties, ["Name", "VA Name", "Title"])
    ) || "Untitled VA";

  const commissionCount = formatPropertyValue(
    pickProperty(properties, [
      "Commission Counter",
      "Commission Count",
      "commission count",
      "Total commissions",
    ])
  );

  const lastCommissionTime = formatPropertyValue(
    pickProperty(properties, [
      "Latest Created Time (Rollup)",
      "Last Commission Time",
      "last commission time",
      "Latest Time",
    ])
  );

  const lastCommissionTimeDisplay = formatPropertyValue(
    pickProperty(properties, [
      "Latest Created Time (Formula)",
      "Last Commission Time Display",
      "Last Commission Time (text)",
      "Full Date/Time Display",
      "Last Commission Time Text",
    ])
  );

  const minutesNumber = formatPropertyValue(
    pickProperty(properties, [
      "Minutes since Last Commission (number)",
      "Minutes Since Last Commission (number)",
      "Minutes Since Last Commission",
    ])
  );

  const minutesText = formatPropertyValue(
    pickProperty(properties, [
      "Minutes since Last Commission(text)",
      "Minutes since Last Commission (text)",
      "Minutes Since Last Commission (text)",
      "Elapsed Display",
    ])
  );

  const status =
    formatPropertyValue(
      pickProperty(properties, ["Status", "Off Task Status", "State"])
    ) || deriveStatus(minutesNumber);

  return {
    id: page.id,
    name,
    key: normalizeName(name),
    commissionCount: commissionCount ?? 0,
    lastCommissionTime,
    lastCommissionTimeDisplay:
      typeof lastCommissionTimeDisplay === "string" && lastCommissionTimeDisplay.trim() !== ""
        ? lastCommissionTimeDisplay
        : formatDateTime(lastCommissionTime),
    minutesSinceLastCommission:
      typeof minutesNumber === "number" ? minutesNumber : null,
    minutesSinceLastCommissionText:
      minutesText || humanizeMinutes(minutesNumber),
    status,
  };
}

function normalizeReceipt(page) {
  const properties = page.properties || {};

  const title =
    formatPropertyValue(pickProperty(properties, ["Name", "Title"])) || "";

  const personNames = formatPropertyValue(
    pickProperty(properties, ["Person"])
  );

  const vaCounterRaw = formatPropertyValue(
    pickProperty(properties, ["VA Counter"])
  );

  const relationLatestTime = formatPropertyValue(
    pickProperty(properties, ["Relation Latest Time"])
  );

  const dateValue = formatPropertyValue(
    pickProperty(properties, ["Date"])
  );

  const createdTime = formatPropertyValue(
    pickProperty(properties, ["Created time"])
  );

  const eventTime = dateValue || createdTime;
  const eventDate = safeDate(eventTime);

  let vaName = null;

  if (Array.isArray(personNames) && personNames.length) {
    vaName = personNames[0];
  } else if (typeof vaCounterRaw === "string" && vaCounterRaw.trim()) {
    vaName = vaCounterRaw.trim();
  } else if (title.trim()) {
    vaName = title.trim();
  }

  return {
    id: page.id,
    title,
    vaName,
    vaKey: normalizeName(vaName),
    eventTime: eventDate ? eventDate.toISOString() : null,
    eventDate,
    relationLatestTime,
  };
}

function enrichVAs(vas, receipts, now) {
  const receiptsByVA = new Map();

  for (const receipt of receipts) {
    if (!receipt.vaKey || !receipt.eventDate) continue;

    if (!receiptsByVA.has(receipt.vaKey)) {
      receiptsByVA.set(receipt.vaKey, []);
    }

    receiptsByVA.get(receipt.vaKey).push(receipt.eventDate);
  }

  for (const [key, dates] of receiptsByVA.entries()) {
    receiptsByVA.set(key, uniqueSortedDates(dates));
  }

  const allKeys = new Set([
    ...vas.map((v) => v.key),
    ...receiptsByVA.keys(),
  ]);

  const vaMap = new Map(vas.map((va) => [va.key, { ...va }]));
  const enriched = [];

  for (const key of allKeys) {
    const base = vaMap.get(key) || {
      id: key,
      name: key || "Unknown VA",
      key,
      commissionCount: 0,
      lastCommissionTime: null,
      lastCommissionTimeDisplay: "—",
      minutesSinceLastCommission: null,
      minutesSinceLastCommissionText: "—",
      status: "No data",
    };

    const timestamps = receiptsByVA.get(key) || [];
    const intervals = buildIntervalsInMinutes(timestamps);
    const lastEvent = timestamps.length ? timestamps[timestamps.length - 1] : null;

    const liveMinutes =
      lastEvent ? (now.getTime() - lastEvent.getTime()) / 60000 : base.minutesSinceLastCommission;

    const last10MinCutoff = now.getTime() - 10 * 60000;
    const receiptsLast10Min = timestamps.filter((d) => d.getTime() >= last10MinCutoff).length;
    const avgCycle = average(intervals);
    const medianCycle = median(intervals);
    const latestCycle = intervals.length ? intervals[intervals.length - 1] : null;

    const recentIntervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i].getTime() >= last10MinCutoff) {
        recentIntervals.push((timestamps[i].getTime() - timestamps[i - 1].getTime()) / 60000);
      }
    }
    const rollingAvg10Min = average(recentIntervals);

    const throughputMinutes =
      rollingAvg10Min ?? avgCycle ?? liveMinutes ?? null;

    const chartPoints = buildSawtoothSeries(timestamps, now, 10, 15);

    enriched.push({
      ...base,
      name: base.name,
      commissionCount: Math.max(base.commissionCount || 0, timestamps.length),
      receiptCount: timestamps.length,
      derivedLastCommissionTime: lastEvent ? lastEvent.toISOString() : base.lastCommissionTime,
      derivedLastCommissionTimeDisplay: lastEvent
        ? formatDateTime(lastEvent.toISOString())
        : base.lastCommissionTimeDisplay,
      liveMinutesSinceLastCommission:
        typeof liveMinutes === "number" ? Number(liveMinutes.toFixed(2)) : null,
      liveMinutesSinceLastCommissionText: humanizeMinutes(liveMinutes),
      derivedStatus: deriveStatus(liveMinutes),
      cycleTimeLatestMinutes:
        typeof latestCycle === "number" ? Number(latestCycle.toFixed(2)) : null,
      cycleTimeAverageMinutes:
        typeof avgCycle === "number" ? Number(avgCycle.toFixed(2)) : null,
      cycleTimeMedianMinutes:
        typeof medianCycle === "number" ? Number(medianCycle.toFixed(2)) : null,
      cycleTimeRolling10Minutes:
        typeof rollingAvg10Min === "number" ? Number(rollingAvg10Min.toFixed(2)) : null,
      throughputMinutesPerCommission:
        typeof throughputMinutes === "number" ? Number(throughputMinutes.toFixed(2)) : null,
      receiptsLast10Min,
      chartPoints,
    });
  }

  enriched.sort((a, b) => {
    const statusDiff = statusOrder(a.derivedStatus) - statusOrder(b.derivedStatus);
    if (statusDiff !== 0) return statusDiff;
    return (b.liveMinutesSinceLastCommission || 0) - (a.liveMinutesSinceLastCommission || 0);
  });

  return enriched;
}

app.get("/api/dashboard", async (_req, res) => {
  try {
    const [vaPages, receiptPages] = await Promise.all([
      queryAllRows(VA_COUNTER_DATA_SOURCE_ID, [
        {
          property: "Minutes since Last Commission (number)",
          direction: "descending",
        },
      ]),
      queryAllRows(RECEIPTS_DATA_SOURCE_ID, [
        {
          property: "Date",
          direction: "ascending",
        },
      ]),
    ]);

    const vas = vaPages.map(normalizeVA);
    const receipts = receiptPages.map(normalizeReceipt);
    const now = new Date();
    const enriched = enrichVAs(vas, receipts, now);

    const stats = {
      totalVAs: enriched.length,
      onPace: enriched.filter((v) => v.derivedStatus === "On Pace").length,
      slowingDown: enriched.filter((v) => v.derivedStatus === "Slowing Down").length,
      offTask: enriched.filter((v) => v.derivedStatus === "Off Task").length,
      totalReceiptsLast10Min: enriched.reduce((sum, v) => sum + (v.receiptsLast10Min || 0), 0),
    };

    res.json({
      refreshedAt: now.toISOString(),
      stats,
      vas: enriched,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Failed to load dashboard data.",
    });
  }
});

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VA Time Off Task Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #090d12;
      --panel: #111827;
      --panel-2: #0f1723;
      --border: rgba(255,255,255,0.08);
      --text: #eef4ff;
      --muted: #8ea0bc;
      --red: #ff5f7a;
      --red-bg: rgba(255,95,122,0.14);
      --amber: #ffbf5a;
      --amber-bg: rgba(255,191,90,0.14);
      --green: #44d38c;
      --green-bg: rgba(68,211,140,0.14);
      --shadow: 0 18px 60px rgba(0,0,0,0.34);
      --radius: 22px;
      --line1: rgba(94,168,255,1);
      --fill1: rgba(94,168,255,0.18);
      --glow1: rgba(94,168,255,0.22);
      --line2: rgba(188,120,255,1);
      --fill2: rgba(188,120,255,0.18);
      --glow2: rgba(188,120,255,0.22);
      --line3: rgba(80,227,194,1);
      --fill3: rgba(80,227,194,0.18);
      --glow3: rgba(80,227,194,0.22);
      --line4: rgba(255,160,90,1);
      --fill4: rgba(255,160,90,0.18);
      --glow4: rgba(255,160,90,0.22);
      --line5: rgba(255,99,132,1);
      --fill5: rgba(255,99,132,0.18);
      --glow5: rgba(255,99,132,0.22);
      --line6: rgba(140,220,90,1);
      --fill6: rgba(140,220,90,0.18);
      --glow6: rgba(140,220,90,0.22);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(90,110,255,0.16), transparent 22%),
        radial-gradient(circle at top right, rgba(188,120,255,0.12), transparent 18%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
    }

    .wrap {
      max-width: 1460px;
      margin: 0 auto;
      padding: 22px;
    }

    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }

    .title h1 {
      margin: 0;
      font-size: 1.85rem;
      letter-spacing: -0.04em;
    }

    .title p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .pill {
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.04);
      color: var(--muted);
      padding: 10px 14px;
      border-radius: 999px;
      font-size: 0.88rem;
      white-space: nowrap;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(0,1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .stat,
    .panel,
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.018));
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
    }

    .stat {
      border-radius: 18px;
      padding: 14px 16px;
    }

    .stat .label {
      color: var(--muted);
      font-size: 0.82rem;
      margin-bottom: 10px;
    }

    .stat .value {
      font-size: 1.6rem;
      font-weight: 800;
      letter-spacing: -0.05em;
    }

    .layout {
      display: grid;
      grid-template-columns: 1.6fr 1fr;
      gap: 16px;
      align-items: start;
    }

    .panel {
      border-radius: 24px;
      overflow: hidden;
    }

    .panel-head {
      padding: 16px 18px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }

    .panel-title {
      font-size: 1.02rem;
      font-weight: 700;
      letter-spacing: -0.03em;
    }

    .panel-sub {
      color: var(--muted);
      font-size: 0.84rem;
      margin-top: 6px;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: flex-end;
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 0.82rem;
      padding: 6px 10px;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 999px;
      background: rgba(255,255,255,0.03);
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      box-shadow: 0 0 12px currentColor;
      flex: 0 0 auto;
    }

    .chart-wrap {
      padding: 12px 16px 16px;
      height: 430px;
    }

    .cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0,1fr));
      gap: 12px;
    }

    .card {
      border-radius: 20px;
      padding: 14px;
      position: relative;
      overflow: hidden;
    }

    .card::after {
      content: "";
      position: absolute;
      inset: auto -20% -60% auto;
      width: 180px;
      height: 180px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(255,255,255,0.08), transparent 60%);
      pointer-events: none;
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .name {
      font-size: 1rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      margin: 0;
      line-height: 1.1;
    }

    .badge {
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 800;
      border: 1px solid transparent;
      line-height: 1;
      white-space: nowrap;
    }

    .badge.active {
      color: var(--green);
      background: var(--green-bg);
      border-color: rgba(68,211,140,0.22);
      box-shadow: 0 0 18px rgba(68,211,140,0.14);
    }

    .badge.slowing-down {
      color: var(--amber);
      background: var(--amber-bg);
      border-color: rgba(255,191,90,0.22);
      box-shadow: 0 0 18px rgba(255,191,90,0.14);
    }

    .badge.off-task {
      color: var(--red);
      background: var(--red-bg);
      border-color: rgba(255,95,122,0.22);
      box-shadow: 0 0 18px rgba(255,95,122,0.18);
    }

    .badge.no-data {
      color: #a8bad5;
      background: rgba(168,186,213,0.12);
      border-color: rgba(168,186,213,0.14);
    }

    .hero-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }

    .hero-box {
      background: rgba(255,255,255,0.035);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 10px 12px;
    }

    .hero-box .k {
      color: var(--muted);
      font-size: 0.74rem;
      margin-bottom: 6px;
    }

    .hero-box .v {
      font-size: 1.2rem;
      font-weight: 800;
      letter-spacing: -0.04em;
      line-height: 1.1;
    }

    .mini-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .mini {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 14px;
      padding: 9px 10px;
      min-height: 62px;
    }

    .mini .k {
      color: var(--muted);
      font-size: 0.72rem;
      margin-bottom: 6px;
    }

    .mini .v {
      font-size: 0.9rem;
      font-weight: 700;
      line-height: 1.15;
      word-break: break-word;
    }

    .empty,
    .error {
      margin-top: 18px;
      border-radius: 20px;
      padding: 18px;
      color: var(--muted);
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.03);
    }

    .error {
      color: #ffb6c0;
      border-color: rgba(255,95,122,0.22);
      background: rgba(255,95,122,0.08);
    }

    @media (max-width: 1250px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 980px) {
      .stats {
        grid-template-columns: repeat(2, minmax(0,1fr));
      }

      .cards {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      .wrap {
        padding: 16px;
      }

      .topbar {
        flex-direction: column;
        align-items: flex-start;
      }

      .stats {
        grid-template-columns: 1fr;
      }

      .panel-head {
        flex-direction: column;
        align-items: flex-start;
      }

      .legend {
        justify-content: flex-start;
      }

      .chart-wrap {
        height: 360px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="title">
        <h1>VA Time Off Task Dashboard</h1>
        <p>Live Notion-backed view with sawtooth interval trend, cycle time, and throughput.</p>
      </div>
      <div class="pill" id="refreshedAt">Loading…</div>
    </div>

    <section class="stats" id="stats"></section>

    <section id="content"></section>
  </div>

  <script>
    const statsEl = document.getElementById("stats");
    const contentEl = document.getElementById("content");
    const refreshedAtEl = document.getElementById("refreshedAt");
    let chartInstance = null;

    const palette = [
      { line: "rgba(94,168,255,1)", fill: "rgba(94,168,255,0.16)", glow: "rgba(94,168,255,0.22)" },
      { line: "rgba(188,120,255,1)", fill: "rgba(188,120,255,0.16)", glow: "rgba(188,120,255,0.22)" },
      { line: "rgba(80,227,194,1)", fill: "rgba(80,227,194,0.16)", glow: "rgba(80,227,194,0.22)" },
      { line: "rgba(255,160,90,1)", fill: "rgba(255,160,90,0.16)", glow: "rgba(255,160,90,0.22)" },
      { line: "rgba(255,99,132,1)", fill: "rgba(255,99,132,0.16)", glow: "rgba(255,99,132,0.22)" },
      { line: "rgba(140,220,90,1)", fill: "rgba(140,220,90,0.16)", glow: "rgba(140,220,90,0.22)" }
    ];

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function badgeClass(status) {
      if (status === "Off Task") return "off-task";
      if (status === "Slowing Down") return "slowing-down";
      if (status === "Active" || status === "On Pace") return "active";
      return "no-data";
    }

    function formatRefreshedAt(iso) {
      if (!iso) return "Last refresh: —";
      const date = new Date(iso);
      return "Last refresh: " + new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "medium"
      }).format(date);
    }

    function formatMinutes(value) {
      if (typeof value !== "number" || Number.isNaN(value)) return "—";
      if (value < 1) return Math.round(value * 60) + " sec";
      if (value < 60) return value.toFixed(1) + " min";
      return (value / 60).toFixed(1) + " hr";
    }

    function throughputText(value) {
      if (typeof value !== "number" || Number.isNaN(value)) return "—";
      return "1 commission / " + value.toFixed(1) + " min";
    }

    function renderStats(stats) {
      statsEl.innerHTML =
        '<div class="stat"><div class="label">Total VAs</div><div class="value">' + escapeHtml(stats.totalVAs ?? 0) + '</div></div>' +
        '<div class="stat"><div class="label">On Pace</div><div class="value">' + escapeHtml(stats.onPace ?? 0) + '</div></div>' +
        '<div class="stat"><div class="label">Slowing Down</div><div class="value">' + escapeHtml(stats.slowingDown ?? 0) + '</div></div>' +
        '<div class="stat"><div class="label">Off Task</div><div class="value">' + escapeHtml(stats.offTask ?? 0) + '</div></div>' +
        '<div class="stat"><div class="label">Receipts in Last 10 Min</div><div class="value">' + escapeHtml(stats.totalReceiptsLast10Min ?? 0) + '</div></div>';
    }

    function buildLegend(vas) {
      return vas.map(function(va, i) {
        const color = palette[i % palette.length].line;
        return '<span class="legend-item">' +
          '<span class="legend-dot" style="background:' + color + '; color:' + color + ';"></span>' +
          escapeHtml(va.name) +
        '</span>';
      }).join("");
    }

    function renderLayout(vas) {
      if (!vas.length) {
        contentEl.innerHTML = '<div class="empty">No VA rows came back. Make sure the Notion integration is shared with both databases and the property names match the script.</div>';
        return;
      }

      const cards = vas.map(function(va) {
        return '<article class="card">' +
          '<div class="card-top">' +
            '<h2 class="name">' + escapeHtml(va.name) + '</h2>' +
            '<span class="badge ' + badgeClass(va.derivedStatus) + '">' + escapeHtml(va.derivedStatus) + '</span>' +
          '</div>' +

          '<div class="hero-row">' +
            '<div class="hero-box">' +
              '<div class="k">Minutes since last commission</div>' +
              '<div class="v">' + escapeHtml(formatMinutes(va.liveMinutesSinceLastCommission)) + '</div>' +
            '</div>' +
            '<div class="hero-box">' +
              '<div class="k">Throughput</div>' +
              '<div class="v">' + escapeHtml(throughputText(va.throughputMinutesPerCommission)) + '</div>' +
            '</div>' +
          '</div>' +

          '<div class="mini-grid">' +
            '<div class="mini"><div class="k">Latest cycle time</div><div class="v">' + escapeHtml(formatMinutes(va.cycleTimeLatestMinutes)) + '</div></div>' +
            '<div class="mini"><div class="k">Avg cycle time</div><div class="v">' + escapeHtml(formatMinutes(va.cycleTimeAverageMinutes)) + '</div></div>' +
            '<div class="mini"><div class="k">10-min rolling avg</div><div class="v">' + escapeHtml(formatMinutes(va.cycleTimeRolling10Minutes)) + '</div></div>' +
            '<div class="mini"><div class="k">Receipts last 10 min</div><div class="v">' + escapeHtml(va.receiptsLast10Min ?? 0) + '</div></div>' +
            '<div class="mini"><div class="k">Receipt count</div><div class="v">' + escapeHtml(va.receiptCount ?? 0) + '</div></div>' +
            '<div class="mini"><div class="k">Last commission</div><div class="v">' + escapeHtml(va.derivedLastCommissionTimeDisplay || "—") + '</div></div>' +
          '</div>' +
        '</article>';
      }).join("");

      contentEl.innerHTML =
        '<div class="layout">' +
          '<section class="panel">' +
            '<div class="panel-head">' +
              '<div>' +
                '<div class="panel-title">Commission Interval Trend</div>' +
                '<div class="panel-sub">Past 10 minutes. Each line rises until the next commission drops it back to zero.</div>' +
              '</div>' +
              '<div class="legend">' + buildLegend(vas) + '</div>' +
            '</div>' +
            '<div class="chart-wrap"><canvas id="trendChart"></canvas></div>' +
          '</section>' +
          '<section class="cards">' + cards + '</section>' +
        '</div>';
    }

    function renderChart(vas) {
      const canvas = document.getElementById("trendChart");
      if (!canvas) return;

      if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
      }

      const datasets = vas.map(function(va, i) {
        const color = palette[i % palette.length];
        const points = (va.chartPoints || []).map(function(p) {
          return { x: p.t, y: p.y };
        });

        return {
          label: va.name,
          data: points,
          parsing: false,
          borderColor: color.line,
          backgroundColor: color.fill,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 3,
          borderWidth: 2,
          tension: 0,
          spanGaps: true
        };
      });

      chartInstance = new Chart(canvas, {
        type: "line",
        data: {
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: "nearest",
            intersect: false
          },
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: "rgba(12,18,28,0.96)",
              borderColor: "rgba(255,255,255,0.08)",
              borderWidth: 1,
              titleColor: "#eef4ff",
              bodyColor: "#d9e5fb",
              callbacks: {
                label: function(ctx) {
                  const y = ctx.parsed.y;
                  if (typeof y !== "number") return ctx.dataset.label + ": no data";
                  return ctx.dataset.label + ": " + y.toFixed(2) + " min since last commission";
                }
              }
            }
          },
          scales: {
            x: {
              type: "time",
              time: {
                unit: "minute",
                tooltipFormat: "MMM d, h:mm:ss a",
                displayFormats: {
                  minute: "h:mm a"
                }
              },
              grid: {
                color: "rgba(255,255,255,0.05)"
              },
              ticks: {
                color: "#8ea0bc",
                maxRotation: 0
              }
            },
            y: {
              beginAtZero: true,
              grid: {
                color: "rgba(255,255,255,0.05)"
              },
              ticks: {
                color: "#8ea0bc",
                callback: function(value) {
                  return value + "m";
                }
              },
              title: {
                display: true,
                text: "Minutes since last commission",
                color: "#8ea0bc"
              }
            }
          }
        }
      });
    }

    async function load() {
      try {
        const response = await fetch("/api/dashboard");
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to load dashboard data.");
        }

        refreshedAtEl.textContent = formatRefreshedAt(data.refreshedAt);
        renderStats(data.stats || {});
        renderLayout(data.vas || []);
        renderChart(data.vas || []);
      } catch (error) {
        statsEl.innerHTML = "";
        contentEl.innerHTML = '<div class="error">' + escapeHtml(error.message || "Unknown error.") + '</div>';
      }
    }

    load();
    setInterval(load, 30000);
  </script>

  <script src="https://cdn.jsdelivr.net/npm/luxon@3/build/global/luxon.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-luxon@1"></script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(html);
});

app.listen(PORT, () => {
  console.log("Dashboard running on http://localhost:" + PORT);
});