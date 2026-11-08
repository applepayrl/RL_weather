// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_LOCATION = { lat: 40.7644, lon: -73.9633, label: 'New York — Upper East Side' };
const DEFAULT_WIND_MPH = 10;
const STRONG_GUST_MPH = 30;          // wind dots turn red when gusts reach this
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const STORAGE_KEY = 'rlweather:v1';  // { lat, lon, label, wind }
const STALE_ON_REOPEN_MS = 10 * 60 * 1000; // refetch when the app comes back after this long
const MAX_AGE_MS = 30 * 60 * 1000;         // refetch while open once data is this old

const FONT_SANS = "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, sans-serif";
const FONT_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const COLORS = {
  temp: '#d94f4f',
  feels: 'rgba(185, 188, 205, 0.85)',
  precip: '#5a9ae6',
  wind: '#e07a3a',
  gust: '#ef4444',
  tick: '#9a9aab',
  axisTitle: '#c8c8d2',
  bg: '#0f1117'
};
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

// ─── State ───────────────────────────────────────────────────────────────────
let cards = [];                 // one per day: { chart, slots, isToday, selected, ... }
const cardOf = new WeakMap();   // canvas → card, read by the Chart.js plugins
let current = { ...DEFAULT_LOCATION };
let windThresholdMph = DEFAULT_WIND_MPH;
let debounceTimer = null;
let geocodeController = null;   // aborts superseded city searches
let lastResults = [];           // results currently shown in the dropdown
let loadSeq = 0;                // increments per forecast request; stale responses are dropped
let loadInFlight = false;
let lastUpdatedAt = null;
let lastForecastData = null;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const dropdown = document.getElementById('search-dropdown');
const locationLabel = document.getElementById('location-label');
const chartsContainer = document.getElementById('charts-container');
const loadingEl = document.getElementById('loading');
const windSelect = document.getElementById('wind-threshold');
const lastUpdatedEl = document.getElementById('last-updated');
const refreshBtn = document.getElementById('refresh-btn');

// If the Chart.js CDN script failed to load, say so instead of leaving a
// blank page (everything below depends on the global `Chart`).
if (typeof Chart === 'undefined') {
  showError("Couldn't load the charting library.", 'Check your connection and try again.',
    () => location.reload());
  throw new Error('Chart.js failed to load');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showError(message, detail, onRetry) {
  chartsContainer.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'error-msg';
  box.setAttribute('role', 'alert');
  const msg = document.createElement('p');
  msg.textContent = message;
  box.appendChild(msg);
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    box.appendChild(small);
  }
  if (onRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'retry-btn';
    btn.textContent = 'Try again';
    btn.addEventListener('click', onRetry);
    box.appendChild(btn);
  }
  chartsContainer.appendChild(box);
}

function formatUpdated(date) {
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + time;
}

function formatHour12(hour) {
  if (hour === 0) return '12AM';
  if (hour < 12) return hour + 'AM';
  if (hour === 12) return '12PM';
  return (hour - 12) + 'PM';
}

function formatDayLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone edge
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
}

const fmtTemp = v => (v == null ? '–' : `${Math.round(v)}°`);
const fmtMm = v => (v == null ? '–' : v === 0 ? '0 mm' : `${v.toFixed(1)} mm`);
const fmtMph = v => (v == null ? '–' : `${Math.round(v)}`);
const maxOf = arr => { const v = arr.filter(x => x != null); return v.length ? Math.max(...v) : null; };
const minOf = arr => { const v = arr.filter(x => x != null); return v.length ? Math.min(...v) : null; };

// Current date and fractional hour at the forecast location (not the device).
// Open-Meteo returns utc_offset_seconds for the location when timezone=auto.
function locationNow(offsetSec) {
  const offset = offsetSec ?? -new Date().getTimezoneOffset() * 60;
  const d = new Date(Date.now() + offset * 1000);
  return {
    dateStr: d.toISOString().slice(0, 10),
    hour: d.getUTCHours() + d.getUTCMinutes() / 60
  };
}

// X-axis label spacing, shared by the tick labels and the icon strip so the
// two always line up. Prefers every 3 hours; widens only when labels won't fit.
const LABEL_STEPS = [3, 4, 6, 8, 12];
const LABEL_MIN_SPACING_PX = 32; // "12AM" in 11px monospace is ~27px wide
function hourLabelStep(canvasWidth) {
  const usable = canvasWidth * 0.82; // rough plot width after both y-axes
  const maxLabels = Math.floor(usable / LABEL_MIN_SPACING_PX);
  return LABEL_STEPS.find(s => Math.ceil(24 / s) <= maxLabels) || 12;
}

// Parse an ISO datetime string (e.g. "2026-05-27T05:29") into a fractional
// hour (5.483 for 5:29 AM). Used for sunrise/sunset positions on the x-axis.
function parseHourFromISO(iso) {
  if (!iso) return null;
  const t = iso.split('T')[1] ?? '';
  const [h, m] = t.split(':').map(Number);
  return (h || 0) + ((m || 0) / 60);
}

function tempColor(val) {
  if (val == null) return COLORS.temp;
  if (val > 25) return '#d94f4f';   // red — hot
  if (val > 15) return '#e8b84a';   // yellow — warm
  if (val > 5)  return '#4caf50';   // green — mild
  return '#4a90e2';                  // blue — cold
}

// 0 = calm, 1 = wind above the user's threshold, 2 = strong gusts
function windLevels(wind, gust) {
  return wind.map((w, h) => {
    if ((gust[h] ?? 0) >= STRONG_GUST_MPH) return 2;
    if ((w ?? 0) > windThresholdMph) return 1;
    return 0;
  });
}

// ─── Saved settings ──────────────────────────────────────────────────────────

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!p) return;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon) && typeof p.label === 'string') {
      current = { lat: p.lat, lon: p.lon, label: p.label };
    }
    if (Number.isInteger(p.wind) && p.wind >= 0 && p.wind <= 30) windThresholdMph = p.wind;
  } catch { /* storage unavailable (private mode) — use defaults */ }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, wind: windThresholdMph }));
  } catch { /* ignore */ }
}

// ─── Weather icon SVGs ──────────────────────────────────────────────────────
//
// Driven by Open-Meteo's hourly WMO weather_code plus the day's actual
// sunrise/sunset to distinguish sun vs moon.
//
// WMO codes Open-Meteo can return:
//   0       Clear sky
//   1       Mainly clear
//   2       Partly cloudy
//   3       Overcast
//   45, 48  Fog / depositing fog
//   51–57   Drizzle (incl. freezing)
//   61–67   Rain (incl. freezing)
//   71–77   Snow / snow grains
//   80–82   Rain showers
//   85, 86  Snow showers
//   95–99   Thunderstorm (with hail)

function weatherCategory(code) {
  if (code == null) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 71 || code === 73 || code === 75 || code === 77 ||
      code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunder';
  return 'clear'; // covers 0, 1, and any unexpected fallback
}

function weatherIconSVG(hour, weatherCode, sunriseHour, sunsetHour) {
  const sr = sunriseHour ?? 8;
  const ss = sunsetHour ?? 20;
  const isDay = hour >= sr && hour < ss;
  const cat = weatherCategory(weatherCode);
  const sz = 'viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';

  if (cat === 'snow') {
    return `<svg ${sz}>
      <path d="M6 14c0-2 2-3.5 4.5-3.5S13 10 14 10c2.5 0 4 1.5 4 3.5S16 17 14 17H6.5C4.5 17 3 15.8 6 14z" fill="#7a7a8a"/>
      <circle cx="8" cy="20" r="1" fill="#e0e8f0"/><circle cx="12" cy="21" r="1" fill="#e0e8f0"/><circle cx="16" cy="20" r="1" fill="#e0e8f0"/>
      <circle cx="10" cy="23" r="0.8" fill="#e0e8f0"/><circle cx="14" cy="23" r="0.8" fill="#e0e8f0"/>
    </svg>`;
  }
  if (cat === 'rain') {
    return `<svg ${sz}>
      <path d="M6 12c0-2 2-3.5 4.5-3.5S13 8 14 8c2.5 0 4 1.5 4 3.5S16 15 14 15H6.5C4.5 15 3 13.8 6 12z" fill="#7a7a8a"/>
      <line x1="9" y1="17" x2="8" y2="21" stroke="#4a90e2" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="13" y1="17" x2="12" y2="21" stroke="#4a90e2" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="17" y1="17" x2="16" y2="20" stroke="#4a90e2" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }
  if (cat === 'fog') {
    return `<svg ${sz}>
      <line x1="3.5" y1="7" x2="20.5" y2="7" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="5.5" y1="11" x2="18.5" y2="11" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="3.5" y1="15" x2="20.5" y2="15" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="5.5" y1="19" x2="18.5" y2="19" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
  }
  if (cat === 'thunder') {
    return `<svg ${sz}>
      <path d="M5 11c0-2.5 2.5-4 5-4 .5-2 2.5-3.5 5-3.5 3 0 5 2 5 4.5 0 .3 0 .6-.1.9C21.5 9.5 22 10.5 22 12c0 2-1.5 3.5-3.5 3.5H6c-2 0-3.5-1.5-3.5-3.5 0-1.5 1-2.8 2.5-3z" fill="#7a7a8a"/>
      <path d="M13 14 L8.5 19.5 L11.5 19.5 L10 23 L15.5 17 L12.5 17 Z" fill="#f0c050"/>
    </svg>`;
  }
  if (cat === 'overcast') {
    return `<svg ${sz}>
      <path d="M5 14c0-2.5 2.5-4 5-4 .5-2 2.5-3.5 5-3.5 3 0 5 2 5 4.5 0 .3 0 .6-.1.9C21.5 12.5 22 13.5 22 15c0 2-1.5 3.5-3.5 3.5H6c-2 0-3.5-1.5-3.5-3.5 0-1.5 1-2.8 2.5-3z" fill="#7a7a8a"/>
    </svg>`;
  }
  if (cat === 'partly') {
    if (isDay) {
      return `<svg ${sz}>
        <circle cx="10" cy="8" r="4" fill="#f0c050"/>
        <line x1="10" y1="2" x2="10" y2="3.5" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="4" y1="8" x2="5.5" y2="8" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="5.8" y1="3.8" x2="6.8" y2="4.8" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M8 16c0-2 2-3 4-3 .3-1.5 2-2.5 4-2.5 2.5 0 4 1.5 4 3.5S18 17.5 16 17.5H8.5C7 17.5 6 16.8 8 16z" fill="#7a7a8a"/>
      </svg>`;
    }
    return `<svg ${sz}>
      <path transform="translate(1.5 0.5) scale(0.6)" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#a0b4d0"/>
      <path d="M8 16c0-2 2-3 4-3 .3-1.5 2-2.5 4-2.5 2.5 0 4 1.5 4 3.5S18 17.5 16 17.5H8.5C7 17.5 6 16.8 8 16z" fill="#7a7a8a"/>
    </svg>`;
  }
  // cat === 'clear'
  if (isDay) {
    return `<svg ${sz}>
      <circle cx="12" cy="12" r="5" fill="#f0c050"/>
      <line x1="12" y1="3" x2="12" y2="5" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="12" y1="19" x2="12" y2="21" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="3" y1="12" x2="5" y2="12" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="19" y1="12" x2="21" y2="12" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="5.6" y1="5.6" x2="7" y2="7" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="17" y1="17" x2="18.4" y2="18.4" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="5.6" y1="18.4" x2="7" y2="17" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="17" y1="7" x2="18.4" y2="5.6" stroke="#f0c050" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }
  return `<svg ${sz}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#a0b4d0"/>
  </svg>`;
}

// ─── Chart.js plugins ───────────────────────────────────────────────────────
// Per-card state (sunrise, today flag, selection, wind levels) lives on the
// card object, looked up by canvas, so it can change without chart.update().

const dayNightPlugin = {
  id: 'dayNight',
  beforeDatasetsDraw(chart) {
    const card = cardOf.get(chart.canvas);
    if (!card) return;
    const ctx = chart.ctx;
    const xAxis = chart.scales.x;
    const { top, bottom } = chart.chartArea;
    const xLeft = xAxis.getPixelForValue(card.sunriseHour);
    const xRight = xAxis.getPixelForValue(card.sunsetHour);
    ctx.save();
    ctx.fillStyle = 'rgba(255, 191, 105, 0.10)';
    ctx.fillRect(xLeft, top, xRight - xLeft, bottom - top);
    ctx.restore();
  }
};

// Solid horizontal line at 0 °C — visual freezing reference.
// Skipped when 0 is outside the chart's y range.
const freezingLinePlugin = {
  id: 'freezingLine',
  beforeDatasetsDraw(chart) {
    const yScale = chart.scales.yTemp;
    if (!yScale) return;
    if (0 < yScale.min || 0 > yScale.max) return;
    const { left, right } = chart.chartArea;
    const y = yScale.getPixelForValue(0);
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(140, 190, 235, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.restore();
  }
};

// Today only: darken the part of the chart that is already in the past.
const pastHoursPlugin = {
  id: 'pastHours',
  afterDatasetsDraw(chart) {
    const card = cardOf.get(chart.canvas);
    if (!card?.isToday) return;
    const { left, right, top, bottom } = chart.chartArea;
    const x = Math.min(right, chart.scales.x.getPixelForValue(locationNow(card.offsetSec).hour));
    if (x <= left) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(15, 17, 23, 0.55)';
    ctx.fillRect(left, top, x - left, bottom - top);
    ctx.restore();
  }
};

// Today only: dashed line at the current time (location time, to the minute).
const currentTimePlugin = {
  id: 'currentTime',
  afterDatasetsDraw(chart) {
    const card = cardOf.get(chart.canvas);
    if (!card?.isToday) return;
    const x = chart.scales.x.getPixelForValue(locationNow(card.offsetSec).hour);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  }
};

// The hour picked by tap / drag / hover: a vertical guide plus markers on
// the temperature and feels-like lines. Replaces the floating tooltip.
const selectionPlugin = {
  id: 'selection',
  afterDatasetsDraw(chart) {
    const card = cardOf.get(chart.canvas);
    const idx = card?.selected;
    if (idx == null) return;
    const x = chart.scales.x.getPixelForValue(idx);
    const { top, bottom } = chart.chartArea;
    const yScale = chart.scales.yTemp;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    const marks = [
      [card.slots.feels[idx], 'rgb(185, 188, 205)'],
      [card.slots.temps[idx], tempColor(card.slots.temps[idx])]
    ];
    marks.forEach(([v, color]) => {
      if (v == null) return;
      ctx.beginPath();
      ctx.arc(x, yScale.getPixelForValue(v), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.bg;
      ctx.stroke();
    });
    ctx.restore();
  }
};

// Dots below the x-axis labels: orange = wind above threshold,
// red = strong gusts. Faded for hours already past.
const windDotPlugin = {
  id: 'windDots',
  afterDraw(chart) {
    const card = cardOf.get(chart.canvas);
    if (!card) return;
    const ctx = chart.ctx;
    const xAxis = chart.scales.x;
    const dotY = xAxis.bottom + 9;
    const nowHour = card.isToday ? locationNow(card.offsetSec).hour : -1;
    ctx.save();
    card.levels.forEach((level, i) => {
      if (!level) return;
      ctx.globalAlpha = i < nowHour ? 0.35 : 1;
      ctx.beginPath();
      ctx.arc(xAxis.getPixelForValue(i), dotY, 4, 0, Math.PI * 2);
      ctx.fillStyle = level === 2 ? COLORS.gust : COLORS.wind;
      ctx.fill();
    });
    ctx.restore();
  }
};

Chart.register(dayNightPlugin, freezingLinePlugin, pastHoursPlugin,
  currentTimePlugin, selectionPlugin, windDotPlugin);

// ─── Temperature-axis sizing ─────────────────────────────────────────────────
// Standard y-axis range. When a day's data exceeds these bounds, we expand the
// y-axis (rounded to TEMP_STEP) and grow the canvas height by exactly the
// number of pixels needed to keep pixels-per-°C identical across all charts —
// so vertical distances on the y-axis are visually comparable across days.
const STANDARD_TEMP_MIN = -5;
const STANDARD_TEMP_MAX = 30;
const STANDARD_TEMP_RANGE = STANDARD_TEMP_MAX - STANDARD_TEMP_MIN; // 35 °C
const TEMP_STEP = 5; // round expansions to nearest 5 °C to keep tick labels clean
// Pixels of canvas height outside the plot area (x-axis labels, wind-dot
// padding, top padding). Expansions add only plot-area pixels.
const CHART_CHROME_PX = 55; // measured: canvas height − plot-area height

// ─── Data fetching ───────────────────────────────────────────────────────────

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m,weather_code',
    daily: 'sunrise,sunset',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: 5
  });
  const resp = await fetch(`${FORECAST_URL}?${params}`);
  if (!resp.ok) throw new Error(`Forecast API returned ${resp.status}`);
  return resp.json();
}

async function fetchGeocode(query, signal) {
  if (!query || query.length < 2) return [];
  const params = new URLSearchParams({ name: query, count: 5, language: 'en' });
  const resp = await fetch(`${GEOCODE_URL}?${params}`, { signal });
  if (!resp.ok) throw new Error(`Geocoding API returned ${resp.status}`);
  const data = await resp.json();
  return data.results || [];
}

// ─── Data processing ─────────────────────────────────────────────────────────

// Groups Open-Meteo's hourly arrays by date into 24-slot arrays per day.
function sliceIntoDays(apiData) {
  const H = apiData.hourly;
  const dayMap = new Map();
  const slot = fill => new Array(24).fill(fill);

  H.time.forEach((t, i) => {
    const [dateStr, clock] = t.split('T');
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        date: dateStr,
        temps: slot(null), feels: slot(null), precip: slot(0),
        wind: slot(null), gust: slot(null), code: slot(null),
        sunrise: null, sunset: null
      });
    }
    const day = dayMap.get(dateStr);
    const h = parseInt(clock.split(':')[0], 10);
    day.temps[h] = H.temperature_2m[i];
    day.feels[h] = H.apparent_temperature?.[i] ?? null;
    day.precip[h] = H.precipitation[i] ?? 0;
    day.wind[h] = H.wind_speed_10m[i];       // mph
    day.gust[h] = H.wind_gusts_10m?.[i] ?? null;
    day.code[h] = H.weather_code?.[i] ?? null;
  });

  if (apiData.daily?.time) {
    apiData.daily.time.forEach((dateStr, i) => {
      const day = dayMap.get(dateStr);
      if (day) {
        day.sunrise = apiData.daily.sunrise[i];
        day.sunset = apiData.daily.sunset[i];
      }
    });
  }

  return [...dayMap.values()].slice(0, 5);
}

// ─── Readout row ─────────────────────────────────────────────────────────────
// Fixed row above each chart. Shows the selected hour; when nothing is
// selected it shows "Now" on today's card and a day summary on the others.

function buildReadout() {
  const el = document.createElement('div');
  el.className = 'readout';
  el.setAttribute('aria-live', 'polite');
  const time = document.createElement('div');
  time.className = 'ro-time';
  el.appendChild(time);
  const cells = ['temp', 'feels', 'rain', 'wind'].map(kind => {
    const cell = document.createElement('div');
    cell.className = `ro-cell ${kind}`;
    const label = document.createElement('span');
    label.className = 'ro-label';
    const value = document.createElement('span');
    value.className = 'ro-value';
    cell.append(label, value);
    el.appendChild(cell);
    return { label, value };
  });
  return { el, time, cells };
}

function renderReadout(card) {
  const s = card.slots;
  const { time, cells } = card.readout;
  let h = card.selected;
  let timeText = h != null ? formatHour12(h) : null;
  if (h == null && card.isToday) {
    h = Math.min(23, Math.round(locationNow(card.offsetSec).hour));
    timeText = 'Now';
  }
  const rows = h != null
    ? [['Temp', fmtTemp(s.temps[h])], ['Feels', fmtTemp(s.feels[h])],
       ['Rain', fmtMm(s.precip[h])], ['Wind / gust', `${fmtMph(s.wind[h])} / ${fmtMph(s.gust[h])} mph`]]
    : [['High', fmtTemp(maxOf(s.temps))], ['Low', fmtTemp(minOf(s.temps))],
       ['Rain', fmtMm(s.precip.reduce((a, b) => a + (b ?? 0), 0))], ['Max gust', `${fmtMph(maxOf(s.gust))} mph`]];
  time.textContent = timeText ?? 'Day';
  rows.forEach(([label, value], i) => {
    cells[i].label.textContent = label;
    cells[i].value.textContent = value;
  });
}

function setSelection(card, idx) {
  if (idx != null) {
    cards.forEach(c => { if (c !== card && c.selected != null) setSelection(c, null); });
  }
  if (card.selected === idx) return;
  card.selected = idx;
  card.chart.draw();
  renderReadout(card);
}

// ─── Chart rendering ─────────────────────────────────────────────────────────

function destroyCharts() {
  cards.forEach(c => {
    c.destroyed = true;
    c.resizeObserver.disconnect();
    c.chart.destroy();
  });
  cards = [];
  chartsContainer.innerHTML = '';
}

function describeDay(label, s) {
  const rain = s.precip.reduce((a, b) => a + (b ?? 0), 0);
  return `${label}. High ${fmtTemp(maxOf(s.temps))}C, low ${fmtTemp(minOf(s.temps))}C. ` +
    `Rain total ${fmtMm(rain)}. Wind up to ${fmtMph(maxOf(s.wind))} mph, gusts up to ${fmtMph(maxOf(s.gust))} mph.`;
}

function createDayCard(dayData, offsetSec) {
  const isToday = dayData.date === locationNow(offsetSec).dateStr;
  const wrapper = document.createElement('article');
  wrapper.className = 'chart-card';

  const title = document.createElement('h2');
  title.className = 'chart-title';
  title.textContent = isToday ? 'Today' : formatDayLabel(dayData.date);
  if (isToday) {
    const sub = document.createElement('span');
    sub.className = 'chart-subtitle';
    sub.textContent = ' — ' + formatDayLabel(dayData.date);
    title.appendChild(sub);
  }
  wrapper.appendChild(title);

  const readout = buildReadout();
  wrapper.appendChild(readout.el);

  const iconStrip = document.createElement('div');
  iconStrip.className = 'weather-icon-strip';
  iconStrip.setAttribute('aria-hidden', 'true');
  wrapper.appendChild(iconStrip);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.tabIndex = 0; // arrow keys move the selected hour
  canvasWrap.appendChild(canvas);
  wrapper.appendChild(canvasWrap);

  chartsContainer.appendChild(wrapper);

  const s = dayData; // 24-slot arrays from sliceIntoDays
  const card = {
    date: dayData.date,
    slots: s,
    isToday,
    offsetSec,
    sunriseHour: parseHourFromISO(dayData.sunrise) ?? 8,
    sunsetHour: parseHourFromISO(dayData.sunset) ?? 20,
    levels: windLevels(s.wind, s.gust),
    selected: null,
    readout,
    destroyed: false
  };
  cardOf.set(canvas, card);
  canvas.setAttribute('aria-label', describeDay(title.textContent, s) +
    ' Use left and right arrow keys to step through hours.');

  // Y-axis bounds: only expand the side that clips (temperature or
  // feels-like), rounded to TEMP_STEP.
  const allTemps = [...s.temps, ...s.feels].filter(t => t != null);
  const dataMin = allTemps.length ? Math.min(...allTemps) : STANDARD_TEMP_MIN;
  const dataMax = allTemps.length ? Math.max(...allTemps) : STANDARD_TEMP_MAX;
  const yMin = dataMin < STANDARD_TEMP_MIN ? Math.floor(dataMin / TEMP_STEP) * TEMP_STEP : STANDARD_TEMP_MIN;
  const yMax = dataMax > STANDARD_TEMP_MAX ? Math.ceil(dataMax / TEMP_STEP) * TEMP_STEP : STANDARD_TEMP_MAX;
  const yRange = yMax - yMin;

  // Grow the canvas height by exactly the plot-area pixels needed for the
  // extra °C, so pixels-per-°C matches the standard chart's pixels-per-°C.
  if (yRange > STANDARD_TEMP_RANGE) {
    const standardHeight = parseFloat(getComputedStyle(canvasWrap).height);
    const pxPerDegree = (standardHeight - CHART_CHROME_PX) / STANDARD_TEMP_RANGE;
    const newHeight = standardHeight + (yRange - STANDARD_TEMP_RANGE) * pxPerDegree;
    canvasWrap.style.height = `${Math.round(newHeight)}px`;
  }

  // Rain axis: 0–5 mm normally; grows to fit heavier hours so they aren't
  // clipped, with a step that keeps about 5 tick labels.
  const precipPeak = Math.max(0, ...s.precip);
  const precipMax = precipPeak > 5 ? Math.ceil(precipPeak / 5) * 5 : 5;
  const precipBg = s.precip.map(v => v > 5 ? 'rgba(30, 70, 160, 0.75)' : 'rgba(74, 144, 226, 0.55)');
  const precipBorder = s.precip.map(v => v > 5 ? 'rgba(30, 70, 160, 0.95)' : 'rgba(74, 144, 226, 0.8)');

  const tickFont = { family: FONT_MONO, size: 11 };
  const axisTitleFont = { family: FONT_SANS, size: 12, weight: '600' };

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: Array.from({ length: 24 }, (_, i) => formatHour12(i)),
      datasets: [
        {
          label: 'Temperature (°C)',
          type: 'line',
          data: s.temps,
          borderColor: COLORS.temp,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.4,
          fill: false,
          yAxisID: 'yTemp',
          spanGaps: true,
          order: 1,
          segment: { borderColor: ctx => tempColor(ctx.p0.parsed.y) }
        },
        {
          label: 'Feels like (°C)',
          type: 'line',
          data: s.feels,
          borderColor: COLORS.feels, // always gray
          borderWidth: 1.25,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.4,
          fill: false,
          yAxisID: 'yTemp',
          spanGaps: true,
          order: 2
        },
        {
          label: 'Precipitation (mm)',
          type: 'bar',
          data: s.precip,
          backgroundColor: precipBg,
          borderColor: precipBorder,
          borderWidth: 1,
          borderRadius: 2,
          yAxisID: 'yPrecip',
          order: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: REDUCED_MOTION.matches ? false : { duration: 500 },
      // Chart.js gets no pointer events at all: hour selection is handled by
      // our own pointer listeners below, so scrolling over a chart never
      // pops up a tooltip and touches don't trigger chart redraws.
      events: [],
      layout: { padding: { bottom: 18 } }, // room for wind dots below x labels
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      },
      scales: {
        x: {
          grid: { color: 'rgba(150,150,150,0.1)', drawTicks: true, offset: false },
          ticks: {
            maxRotation: 0,
            font: tickFont,
            color: COLORS.tick,
            autoSkip: false,
            callback(value, index) {
              const step = hourLabelStep(this.chart.canvas.clientWidth);
              return index % step === 0 ? this.getLabelForValue(value) : '';
            }
          }
        },
        yTemp: {
          type: 'linear',
          position: 'left',
          min: yMin,
          max: yMax,
          title: { display: true, text: '°C', font: axisTitleFont, color: COLORS.axisTitle },
          grid: { color: 'rgba(150,150,150,0.08)' },
          ticks: { stepSize: 5, autoSkip: false, font: tickFont, color: COLORS.axisTitle }
        },
        yPrecip: {
          type: 'linear',
          position: 'right',
          min: 0,
          max: precipMax,
          title: { display: true, text: 'mm', font: axisTitleFont, color: COLORS.precip },
          grid: { drawOnChartArea: false },
          ticks: { stepSize: precipMax / 5, font: tickFont, color: COLORS.precip }
        }
      }
    }
  });
  card.chart = chart;

  // Weather icons aligned to the chart's x-axis; past hours faded on today.
  card.populateIcons = function populateIcons() {
    // A redraw queued by the ResizeObserver can run after the chart was
    // destroyed (re-render on new location) — skip it.
    if (card.destroyed || !chart.canvas) return;
    iconStrip.innerHTML = '';
    const area = chart.chartArea;
    if (!area) return;
    const maxIcons = Math.floor((area.right - area.left) / 24); // 24px per icon incl. gap
    // Icons must land on every labelled hour, so the icon step is the
    // smallest divisor of the label step that fits.
    const labelStep = hourLabelStep(chart.canvas.clientWidth);
    let step = labelStep;
    for (let d = 1; d <= labelStep; d++) {
      if (labelStep % d === 0 && Math.ceil(24 / d) <= maxIcons) { step = d; break; }
    }
    const nowHour = card.isToday ? locationNow(card.offsetSec).hour : -1;
    for (let h = 0; h < 24; h += step) {
      if (s.code[h] == null && s.temps[h] == null) continue;
      const span = document.createElement('span');
      span.className = 'weather-icon';
      if (h < nowHour) span.classList.add('past');
      span.style.left = chart.scales.x.getPixelForValue(h) + 'px';
      span.innerHTML = weatherIconSVG(h, s.code[h], card.sunriseHour, card.sunsetHour);
      iconStrip.appendChild(span);
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(card.populateIcons));
  card.resizeObserver = new ResizeObserver(() => requestAnimationFrame(card.populateIcons));
  card.resizeObserver.observe(canvasWrap);

  attachScrub(card, canvas);
  renderReadout(card);
  cards.push(card);
}

// ─── Hour selection: tap, horizontal drag, hover, arrow keys ────────────────
// The canvas has `touch-action: pan-y`, so vertical swipes scroll the page
// natively (the browser sends pointercancel) while horizontal drags reach us.

function hourAt(chart, clientX) {
  const rect = chart.canvas.getBoundingClientRect();
  const v = chart.scales.x.getValueForPixel(clientX - rect.left);
  return Math.max(0, Math.min(23, Math.round(v)));
}

function attachScrub(card, canvas) {
  let gesture = null;
  const chart = () => card.chart;

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, scrubbing: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') {
      setSelection(card, hourAt(chart(), e.clientX));
      return;
    }
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (!gesture.scrubbing && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
      gesture.scrubbing = true;
    }
    if (gesture.scrubbing) setSelection(card, hourAt(chart(), e.clientX));
  });
  canvas.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse' || !gesture || e.pointerId !== gesture.id) return;
    const moved = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y);
    if (!gesture.scrubbing && moved < 10) {
      // Tap: select that hour; tapping the selected hour again clears it.
      const idx = hourAt(chart(), e.clientX);
      setSelection(card, card.selected === idx ? null : idx);
    }
    gesture = null;
  });
  canvas.addEventListener('pointercancel', () => { gesture = null; }); // page scroll took over
  canvas.addEventListener('pointerleave', e => {
    if (e.pointerType === 'mouse') setSelection(card, null);
  });
  canvas.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const start = card.selected ??
        (card.isToday ? Math.round(locationNow(card.offsetSec).hour) : (e.key === 'ArrowRight' ? -1 : 24));
      const next = Math.max(0, Math.min(23, start + (e.key === 'ArrowRight' ? 1 : -1)));
      setSelection(card, next);
    } else if (e.key === 'Escape') {
      setSelection(card, null);
    }
  });
}

// Touching anywhere outside a chart clears any selected hour.
document.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  if (!e.target.closest?.('.canvas-wrap')) cards.forEach(c => setSelection(c, null));
}, { passive: true });

// ─── Main render ─────────────────────────────────────────────────────────────

function renderForecast(data) {
  destroyCharts();
  sliceIntoDays(data).forEach(d => createDayCard(d, data.utc_offset_seconds));
}

// Fetches and renders a forecast. The current charts stay on screen (dimmed)
// until the new data arrives, so a failed refresh never wipes the forecast.
// Each call takes a sequence number; if a newer call has started by the time
// this one resolves, its result is discarded (prevents duplicate cards and
// an older location overwriting a newer one).
async function loadWeather(lat, lon, label) {
  const seq = ++loadSeq;
  loadInFlight = true;
  if (cards.length === 0) {
    chartsContainer.innerHTML = '';
    loadingEl.classList.add('visible');
  }
  chartsContainer.classList.add('is-loading');
  chartsContainer.setAttribute('aria-busy', 'true');

  try {
    const data = await fetchForecast(lat, lon);
    if (seq !== loadSeq) return;
    lastForecastData = data;
    current = { lat, lon, label: label ?? current.label };
    locationLabel.textContent = current.label;
    savePrefs();
    lastUpdatedAt = new Date();
    lastUpdatedEl.textContent = 'Updated ' + formatUpdated(lastUpdatedAt);
    renderForecast(data);
  } catch (err) {
    if (seq !== loadSeq) return;
    if (cards.length > 0) {
      const what = label ? `Couldn't load ${label}` : "Couldn't refresh";
      lastUpdatedEl.textContent = `${what} · showing ${formatUpdated(lastUpdatedAt)} forecast`;
    } else {
      showError("Couldn't load the forecast.", err.message,
        () => loadWeather(lat, lon, label));
    }
  } finally {
    if (seq === loadSeq) {
      loadInFlight = false;
      loadingEl.classList.remove('visible');
      chartsContainer.classList.remove('is-loading');
      chartsContainer.removeAttribute('aria-busy');
    }
  }
}

function refresh() {
  return loadWeather(current.lat, current.lon);
}

// ─── Keeping it current (home-screen app stays in memory for days) ──────────

// Every minute: move the time line / past-hours shading / "Now" readout, and
// refetch if the location's date has rolled over or the data is old.
function tickClock() {
  if (!lastForecastData || !cards.length || loadInFlight) return;
  const rolledOver = locationNow(lastForecastData.utc_offset_seconds).dateStr !== cards[0].date;
  if (rolledOver || Date.now() - lastUpdatedAt > MAX_AGE_MS) {
    refresh();
    return;
  }
  cards.forEach(c => {
    if (!c.isToday) return;
    c.chart.draw();
    c.populateIcons();
    renderReadout(c);
  });
}

setInterval(() => {
  if (document.visibilityState === 'visible') tickClock();
}, 60 * 1000);

function onResume() {
  if (document.visibilityState !== 'visible' || !lastUpdatedAt || loadInFlight) return;
  if (Date.now() - lastUpdatedAt > STALE_ON_REOPEN_MS) refresh();
  else tickClock();
}
document.addEventListener('visibilitychange', onResume);
window.addEventListener('pageshow', e => { if (e.persisted) onResume(); });

// ─── Search / geocode ────────────────────────────────────────────────────────

function closeDropdown() {
  dropdown.classList.remove('open');
}

function dropdownMessage(text) {
  dropdown.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'dropdown-empty';
  msg.textContent = text;
  dropdown.appendChild(msg);
  dropdown.classList.add('open');
}

function chooseResult(r) {
  cancelPendingSearch();
  const label = r.admin1 ? `${r.name}, ${r.admin1}` : `${r.name}, ${r.country}`;
  searchInput.value = '';
  lastResults = [];
  closeDropdown();
  searchInput.blur(); // dismiss the iOS keyboard
  loadWeather(r.latitude, r.longitude, label);
}

function renderDropdown(results, query) {
  lastResults = results;
  dropdown.innerHTML = '';
  if (results.length === 0) {
    dropdownMessage(`No cities match “${query}”`);
    return;
  }
  results.forEach(r => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dropdown-item';
    const name = document.createElement('strong');
    name.textContent = r.name;
    const region = document.createElement('span');
    region.className = 'region';
    region.textContent = [r.admin1, r.country].filter(Boolean).join(', ');
    item.append(name, region);
    item.addEventListener('click', () => chooseResult(r));
    dropdown.appendChild(item);
  });
  dropdown.classList.add('open');
}

// Cancels both a not-yet-fired debounce and an in-flight geocode request, so a
// slow older response can't overwrite newer results or reopen the dropdown.
function cancelPendingSearch() {
  clearTimeout(debounceTimer);
  if (geocodeController) {
    geocodeController.abort();
    geocodeController = null;
  }
}

async function runSearch(q, { pickFirst = false } = {}) {
  cancelPendingSearch();
  const controller = new AbortController();
  geocodeController = controller;
  try {
    const results = await fetchGeocode(q, controller.signal);
    if (controller.signal.aborted) return;
    if (pickFirst && results.length) chooseResult(results[0]);
    else renderDropdown(results, q);
  } catch (err) {
    if (err.name !== 'AbortError') dropdownMessage("Search isn't available right now. Check your connection.");
  }
}

searchInput.addEventListener('input', () => {
  cancelPendingSearch();
  lastResults = [];
  const q = searchInput.value.trim();
  if (q.length < 2) {
    closeDropdown();
    return;
  }
  debounceTimer = setTimeout(() => runSearch(q), 300); // debounce to spare the API
});

// Return / the keyboard's Search key picks the first result.
searchForm.addEventListener('submit', e => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (lastResults.length) chooseResult(lastResults[0]);
  else if (q.length >= 2) runSearch(q, { pickFirst: true });
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeDropdown();
    searchInput.blur();
  }
});

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.search-container')) closeDropdown();
});

// ─── Wind threshold dropdown ─────────────────────────────────────────────────

// Recolors the dots in place — no chart rebuild needed.
function applyWindThreshold() {
  cards.forEach(c => {
    c.levels = windLevels(c.slots.wind, c.slots.gust);
    c.chart.draw();
  });
}

windSelect.addEventListener('change', () => {
  windThresholdMph = parseInt(windSelect.value, 10);
  savePrefs();
  applyWindThreshold();
});

// ─── Refresh button ──────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.classList.contains('spinning')) return;
  refreshBtn.classList.add('spinning');
  try {
    await refresh();
  } finally {
    refreshBtn.classList.remove('spinning');
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────
loadPrefs();
for (let i = 0; i <= 30; i++) {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = i;
  opt.selected = i === windThresholdMph;
  windSelect.appendChild(opt);
}
document.getElementById('gust-threshold').textContent = STRONG_GUST_MPH;
locationLabel.textContent = current.label;
loadWeather(current.lat, current.lon, current.label);
