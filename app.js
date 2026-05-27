// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_LAT = 40.7644;
const DEFAULT_LON = -73.9633;
const DEFAULT_LABEL = 'New York — Upper East Side';
let windThresholdMph = 10;
const KMH_TO_MPH = 0.621371;
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// ─── State ───────────────────────────────────────────────────────────────────
let charts = [];
let currentLat = DEFAULT_LAT;
let currentLon = DEFAULT_LON;
let debounceTimer = null;
// Touch-only device (no hover capability) — used to gate tooltip behavior
// so iOS taps don't leave a sticky tooltip via synthetic mouse events.
const IS_TOUCH_ONLY = window.matchMedia('(hover: none)').matches;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const searchInput = document.getElementById('search-input');
const dropdown = document.getElementById('search-dropdown');
const locationLabel = document.getElementById('location-label');
const chartsContainer = document.getElementById('charts-container');
const loadingEl = document.getElementById('loading');
const windSelect = document.getElementById('wind-threshold');
const lastUpdatedEl = document.getElementById('last-updated');
const refreshBtn = document.getElementById('refresh-btn');
let lastForecastData = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function isToday(dateStr) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return dateStr === `${y}-${m}-${dd}`;
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
  if (val == null) return '#d94f4f';
  if (val > 25) return '#d94f4f';   // red — hot
  if (val > 15) return '#e8b84a';   // yellow — warm
  if (val > 5)  return '#4caf50';   // green — mild
  return '#4a90e2';                  // blue — cold
}

// ─── Weather icon SVGs ──────────────────────────────────────────────────────
//
// Driven by Open-Meteo's hourly WMO weather_code (the authoritative condition)
// plus the day's actual sunrise/sunset to distinguish sun vs moon. The previous
// implementation derived icons from cloud_cover/precip/temp heuristics, which
// missed fog (45/48), thunderstorms (95–99), wet snow (0–2 °C), and used a
// hardcoded 8AM–8PM day window that was wrong outside late autumn / winter.
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
    // Stacked horizontal streaks
    return `<svg ${sz}>
      <line x1="3.5" y1="7" x2="20.5" y2="7" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="5.5" y1="11" x2="18.5" y2="11" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="3.5" y1="15" x2="20.5" y2="15" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="5.5" y1="19" x2="18.5" y2="19" stroke="#a0b4d0" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
  }
  if (cat === 'thunder') {
    // Cloud above, lightning bolt below
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
      <path d="M11 4a5 5 0 0 0 0 10 5 5 0 0 0 3.4-1.3" fill="none" stroke="#a0b4d0" stroke-width="1.5"/>
      <circle cx="9" cy="9" r="4" fill="none" stroke="#a0b4d0" stroke-width="0"/>
      <path d="M9 3c-3.5 0-6 2.5-6 6s2.5 6 6 6c1 0 1.8-.2 2.6-.6" fill="#a0b4d0" opacity="0.3"/>
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

const dayNightPlugin = {
  id: 'dayNight',
  beforeDatasetsDraw(chart) {
    const cfg = chart.options.plugins.dayNight;
    const sunriseHour = cfg?.sunriseHour ?? 8;
    const sunsetHour = cfg?.sunsetHour ?? 20;
    const ctx = chart.ctx;
    const xAxis = chart.scales.x;
    const { top, bottom } = chart.chartArea;
    const xLeft = xAxis.getPixelForValue(sunriseHour);
    const xRight = xAxis.getPixelForValue(sunsetHour);
    ctx.save();
    ctx.fillStyle = 'rgba(255, 191, 105, 0.10)';
    ctx.fillRect(xLeft, top, xRight - xLeft, bottom - top);
    ctx.restore();
  }
};

const currentTimePlugin = {
  id: 'currentTime',
  afterDatasetsDraw(chart) {
    if (!chart.options.plugins.currentTime?.isToday) return;
    const hour = new Date().getHours();
    const ctx = chart.ctx;
    const xAxis = chart.scales.x;
    const { top, bottom } = chart.chartArea;
    const x = xAxis.getPixelForValue(hour);
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

const windDotPlugin = {
  id: 'windDots',
  afterDraw(chart) {
    const windData = chart.options.plugins.windDots?.data;
    if (!windData) return;

    const ctx = chart.ctx;
    const xAxis = chart.scales.x;
    const chartArea = chart.chartArea;

    // Draw dots below the x-axis labels
    const dotY = chartArea.bottom + 38;
    const dotRadius = 4;

    windData.forEach((isWindy, i) => {
      if (!isWindy) return;
      const x = xAxis.getPixelForValue(i);
      ctx.beginPath();
      ctx.arc(x, dotY, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#e07a3a';
      ctx.fill();
      ctx.closePath();
    });
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

Chart.register(dayNightPlugin, currentTimePlugin, windDotPlugin, freezingLinePlugin);

// ─── Temperature-axis sizing ─────────────────────────────────────────────────
// Standard y-axis range. When a day's data exceeds these bounds, we expand the
// y-axis (rounded to TEMP_STEP) and grow the canvas height by exactly the
// number of pixels needed to keep pixels-per-°C identical across all charts —
// so vertical distances on the y-axis are visually comparable across days.
const STANDARD_TEMP_MIN = -5;
const STANDARD_TEMP_MAX = 30;
const STANDARD_TEMP_RANGE = STANDARD_TEMP_MAX - STANDARD_TEMP_MIN; // 35 °C
const TEMP_STEP = 5; // round expansions to nearest 5 °C to keep tick labels clean
// Approx pixels of canvas height reserved for x-axis labels + layout.padding.bottom
// + top padding. Subtracting this from canvas height gives the plot-area height.
// Expansions add only plot-area pixels (chrome is constant across charts).
const CHART_CHROME_PX = 62;

// Custom tooltip positioner — anchors the tooltip at the finger/cursor
// position (not the average of active data points). Combined with
// yAlign:'bottom' and a large caretPadding, this lifts the tooltip above
// the finger so the values aren't blocked by the touch itself.
Chart.Tooltip.positioners.touchAbove = function(items, eventPosition) {
  return { x: eventPosition.x, y: eventPosition.y };
};

// ─── Data fetching ───────────────────────────────────────────────────────────

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'temperature_2m,precipitation,wind_speed_10m,cloud_cover,weather_code',
    daily: 'sunrise,sunset',
    timezone: 'auto',
    forecast_days: 5
  });
  const resp = await fetch(`${FORECAST_URL}?${params}`);
  if (!resp.ok) throw new Error(`Forecast API returned ${resp.status}`);
  return resp.json();
}

async function fetchGeocode(query) {
  if (!query || query.length < 2) return [];
  const params = new URLSearchParams({ name: query, count: 5, language: 'en' });
  const resp = await fetch(`${GEOCODE_URL}?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.results || [];
}

// ─── Data processing ─────────────────────────────────────────────────────────

function sliceIntoDays(apiData) {
  // Open-Meteo returns hourly arrays. The time array looks like:
  // ["2026-03-31T00:00", "2026-03-31T01:00", ...]
  // We group by date (the part before "T").
  const times = apiData.hourly.time;
  const temps = apiData.hourly.temperature_2m;
  const precip = apiData.hourly.precipitation;
  const wind = apiData.hourly.wind_speed_10m;
  const cloud = apiData.hourly.cloud_cover;
  const wcode = apiData.hourly.weather_code;

  const dayMap = new Map();

  times.forEach((t, i) => {
    const dateStr = t.split('T')[0];
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, {
        date: dateStr,
        temps: [], precip: [], wind: [], cloud: [], weatherCode: [], hours: [],
        sunrise: null, sunset: null
      });
    }
    const day = dayMap.get(dateStr);
    day.hours.push(parseInt(t.split('T')[1].split(':')[0], 10));
    day.temps.push(temps[i]);
    day.precip.push(precip[i]);
    day.wind.push(wind[i]); // km/h
    day.cloud.push(cloud[i]); // %
    day.weatherCode.push(wcode?.[i] ?? null);
  });

  // Attach daily sunrise/sunset to the matching day
  if (apiData.daily?.time) {
    apiData.daily.time.forEach((dateStr, i) => {
      const day = dayMap.get(dateStr);
      if (day) {
        day.sunrise = apiData.daily.sunrise[i];
        day.sunset = apiData.daily.sunset[i];
      }
    });
  }

  // Take first 5 days (in case API returns a partial 6th)
  return [...dayMap.values()].slice(0, 5);
}

// ─── Chart rendering ─────────────────────────────────────────────────────────

function destroyCharts() {
  charts.forEach(c => {
    if (c._iconResizeObserver) c._iconResizeObserver.disconnect();
    c.destroy();
  });
  charts = [];
  chartsContainer.innerHTML = '';
}

function createDayChart(dayData) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chart-card';

  const title = document.createElement('h2');
  title.className = 'chart-title';
  const label = isToday(dayData.date) ? 'Today' : formatDayLabel(dayData.date);
  title.textContent = label;
  if (isToday(dayData.date)) {
    const sub = document.createElement('span');
    sub.className = 'chart-subtitle';
    sub.textContent = ' — ' + formatDayLabel(dayData.date);
    title.appendChild(sub);
  }
  wrapper.appendChild(title);

  // Wind legend
  const windLegend = document.createElement('div');
  windLegend.className = 'wind-legend';
  windLegend.innerHTML = `<span class="wind-dot-sample"></span> Wind &gt; ${windThresholdMph} mph`;
  wrapper.appendChild(windLegend);

  // Weather icon strip (populated after chart renders)
  const iconStrip = document.createElement('div');
  iconStrip.className = 'weather-icon-strip';
  wrapper.appendChild(iconStrip);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'canvas-wrap';
  const canvas = document.createElement('canvas');
  canvasWrap.appendChild(canvas);
  wrapper.appendChild(canvasWrap);

  chartsContainer.appendChild(wrapper);

  // Prepare 24-slot arrays (pad if API returned fewer hours, e.g. partial today)
  const temps = new Array(24).fill(null);
  const precip = new Array(24).fill(0);
  const windBool = new Array(24).fill(false);
  const cloudArr = new Array(24).fill(null);
  const wCodeArr = new Array(24).fill(null);

  dayData.hours.forEach((h, i) => {
    temps[h] = dayData.temps[i];
    precip[h] = dayData.precip[i] ?? 0;
    windBool[h] = (dayData.wind[i] * KMH_TO_MPH) > windThresholdMph;
    cloudArr[h] = dayData.cloud?.[i] ?? null;
    wCodeArr[h] = dayData.weatherCode?.[i] ?? null;
  });

  // Day's actual sunrise/sunset as fractional hours (e.g. 5.48 = 5:29 AM).
  // Used by both the dayNight background and the sun/moon icon selection.
  const sunriseHour = parseHourFromISO(dayData.sunrise) ?? 8;
  const sunsetHour = parseHourFromISO(dayData.sunset) ?? 20;

  // Compute per-chart y-axis bounds. Only expand the side that clips, rounded
  // to TEMP_STEP. If data fits within the standard range, leave bounds alone.
  const validTemps = temps.filter(t => t != null);
  const dataMin = validTemps.length ? Math.min(...validTemps) : STANDARD_TEMP_MIN;
  const dataMax = validTemps.length ? Math.max(...validTemps) : STANDARD_TEMP_MAX;
  const yMin = dataMin < STANDARD_TEMP_MIN
    ? Math.floor(dataMin / TEMP_STEP) * TEMP_STEP
    : STANDARD_TEMP_MIN;
  const yMax = dataMax > STANDARD_TEMP_MAX
    ? Math.ceil(dataMax / TEMP_STEP) * TEMP_STEP
    : STANDARD_TEMP_MAX;
  const yRange = yMax - yMin;

  // Grow the canvas height by exactly the plot-area pixels needed for the
  // extra °C, so pixels-per-°C matches the standard chart's pixels-per-°C.
  if (yRange > STANDARD_TEMP_RANGE) {
    const standardHeight = parseFloat(getComputedStyle(canvasWrap).height);
    const pxPerDegree = (standardHeight - CHART_CHROME_PX) / STANDARD_TEMP_RANGE;
    const newHeight = standardHeight + (yRange - STANDARD_TEMP_RANGE) * pxPerDegree;
    canvasWrap.style.height = `${Math.round(newHeight)}px`;
  }

  // Per-bar colors: darker blue for bars exceeding 5mm
  const precipBg = precip.map(v => v > 5 ? 'rgba(30, 70, 160, 0.75)' : 'rgba(74, 144, 226, 0.55)');
  const precipBorder = precip.map(v => v > 5 ? 'rgba(30, 70, 160, 0.95)' : 'rgba(74, 144, 226, 0.8)');

  const labels = Array.from({ length: 24 }, (_, i) => formatHour12(i));

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Temperature (°C)',
          type: 'line',
          data: temps,
          borderColor: '#d94f4f',
          backgroundColor: 'rgba(217, 79, 79, 0.08)',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#d94f4f',
          tension: 0.4,
          fill: false,
          yAxisID: 'yTemp',
          spanGaps: true,
          order: 1,
          segment: {
            borderColor(ctx) {
              return tempColor(ctx.p0.parsed.y);
            }
          }
        },
        {
          label: 'Precipitation (mm)',
          type: 'bar',
          data: precip,
          backgroundColor: precipBg,
          borderColor: precipBorder,
          borderWidth: 1,
          borderRadius: 2,
          yAxisID: 'yPrecip',
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      // On touch-only devices, ignore mouse events entirely. iOS synthesizes
      // mousemove/mouseup/click after touchend, which would otherwise
      // re-activate the tooltip right after we hide it on finger-lift.
      events: IS_TOUCH_ONLY
        ? ['touchstart', 'touchmove']
        : ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
      layout: {
        padding: { bottom: 32 } // room for wind dots below x-axis labels
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(30,30,30,0.92)',
          titleFont: { family: "'DM Sans', sans-serif", size: 13 },
          bodyFont: { family: "'DM Sans', sans-serif", size: 12 },
          padding: 10,
          cornerRadius: 6,
          // On touch devices, position the tooltip above the finger so the
          // finger itself doesn't block the values. Desktop keeps defaults.
          position: IS_TOUCH_ONLY ? 'touchAbove' : 'average',
          yAlign: IS_TOUCH_ONLY ? 'bottom' : undefined,
          caretPadding: IS_TOUCH_ONLY ? 80 : 2,
          callbacks: {
            afterBody(items) {
              const idx = items[0]?.dataIndex;
              if (idx == null) return '';
              const ws = dayData.hours.includes(idx)
                ? dayData.wind[dayData.hours.indexOf(idx)]
                : null;
              if (ws == null) return '';
              const mph = (ws * KMH_TO_MPH).toFixed(1);
              return `Wind: ${mph} mph`;
            }
          }
        },
        windDots: { data: windBool },
        currentTime: { isToday: isToday(dayData.date) },
        dayNight: { sunriseHour, sunsetHour }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(150,150,150,0.1)',
            drawTicks: true,
            offset: false
          },
          ticks: {
            maxRotation: 0,
            font: { family: "'DM Mono', monospace", size: 11 },
            color: '#8a8a9a',
            autoSkip: false,
            callback(value, index) {
              // Use canvas client width (always available) minus axis gutters
              const cw = this.chart.canvas.clientWidth;
              const chartWidth = cw * 0.82; // rough usable area after y-axes
              const labelWidth = 38;
              const maxLabels = Math.floor(chartWidth / labelWidth);
              const steps = [3, 4, 6, 8, 12];
              const step = steps.find(s => Math.ceil(24 / s) <= maxLabels) || 12;
              return index % step === 0 ? this.getLabelForValue(value) : '';
            }
          }
        },
        yTemp: {
          type: 'linear',
          position: 'left',
          min: yMin,
          max: yMax,
          title: {
            display: true,
            text: '°C',
            font: { family: "'DM Sans', sans-serif", size: 12, weight: '600' },
            color: '#ccc'
          },
          grid: { color: 'rgba(150,150,150,0.08)' },
          ticks: {
            stepSize: 5,
            font: { family: "'DM Mono', monospace", size: 11 },
            color: '#ccc'
          }
        },
        yPrecip: {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 5,
          title: {
            display: true,
            text: 'mm',
            font: { family: "'DM Sans', sans-serif", size: 12, weight: '600' },
            color: '#4a90e2'
          },
          grid: { drawOnChartArea: false },
          ticks: {
            stepSize: 1,
            font: { family: "'DM Mono', monospace", size: 11 },
            color: '#4a90e2'
          }
        }
      }
    }
  });

  // Populate weather icons aligned to chart x-axis
  function populateIcons() {
    iconStrip.innerHTML = '';
    const area = chart.chartArea;
    if (!area) return;
    const chartWidth = area.right - area.left;
    const iconSize = 24; // px per icon including gap
    const maxIcons = Math.floor(chartWidth / iconSize);
    // Pick the smallest step from [1,2,3,4,6] that fits
    const steps = [1, 2, 3, 4, 6];
    const step = steps.find(s => Math.ceil(24 / s) <= maxIcons) || 6;

    for (let h = 0; h < 24; h += step) {
      if (wCodeArr[h] == null && temps[h] == null) continue;
      const x = chart.scales.x.getPixelForValue(h);
      const span = document.createElement('span');
      span.className = 'weather-icon';
      span.style.left = x + 'px';
      span.innerHTML = weatherIconSVG(h, wCodeArr[h], sunriseHour, sunsetHour);
      iconStrip.appendChild(span);
    }
  }
  // Defer first call so Chart.js layout is complete (double rAF)
  requestAnimationFrame(() => requestAnimationFrame(() => populateIcons()));

  const ro = new ResizeObserver(() => requestAnimationFrame(() => populateIcons()));
  ro.observe(canvasWrap);
  chart._iconResizeObserver = ro;

  charts.push(chart);
}

// Clear any visible tooltips across all charts. We clear synchronously,
// then again on the next animation frame, then once more shortly after —
// this catches any tooltip re-activation that Chart.js has scheduled on a
// future frame in response to the touchstart that preceded this touchend
// (otherwise a brief tap can leave the values box visible after release).
function hideAllTooltips() {
  const clear = () => charts.forEach(chart => {
    if (!chart.tooltip) return;
    chart.setActiveElements([]);
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update('none');
  });
  clear();
  requestAnimationFrame(clear);
  setTimeout(clear, 50);
}

if (IS_TOUCH_ONLY) {
  document.addEventListener('touchend', hideAllTooltips, { passive: true });
  document.addEventListener('touchcancel', hideAllTooltips, { passive: true });
}

// ─── Main render ─────────────────────────────────────────────────────────────

async function loadWeather(lat, lon) {
  loadingEl.classList.add('visible');
  destroyCharts();

  try {
    const data = await fetchForecast(lat, lon);
    lastForecastData = data;
    const now = new Date();
    lastUpdatedEl.textContent = 'Last updated: ' + now.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    const days = sliceIntoDays(data);
    days.forEach(d => createDayChart(d));
  } catch (err) {
    chartsContainer.innerHTML = `<div class="error-msg">Failed to load weather data. Please try again.<br><small>${err.message}</small></div>`;
  } finally {
    loadingEl.classList.remove('visible');
  }
}

// ─── Search / geocode ────────────────────────────────────────────────────────

function renderDropdown(results) {
  dropdown.innerHTML = '';
  if (results.length === 0) {
    dropdown.classList.remove('open');
    return;
  }

  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    const region = [r.admin1, r.country].filter(Boolean).join(', ');
    item.innerHTML = `<strong>${r.name}</strong><span class="region">${region}</span>`;
    item.addEventListener('click', () => {
      currentLat = r.latitude;
      currentLon = r.longitude;
      const label = r.admin1 ? `${r.name}, ${r.admin1}` : `${r.name}, ${r.country}`;
      locationLabel.textContent = label;
      searchInput.value = '';
      dropdown.classList.remove('open');
      loadWeather(currentLat, currentLon);
    });
    dropdown.appendChild(item);
  });

  dropdown.classList.add('open');
}

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    dropdown.classList.remove('open');
    return;
  }
  debounceTimer = setTimeout(async () => {
    const results = await fetchGeocode(q);
    renderDropdown(results);
  }, 300); // debounce 300ms to avoid hammering the geocode API
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-container')) {
    dropdown.classList.remove('open');
  }
});

// ─── Wind threshold dropdown ─────────────────────────────────────────────────
for (let i = 0; i <= 30; i++) {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = i;
  if (i === 10) opt.selected = true;
  windSelect.appendChild(opt);
}

windSelect.addEventListener('change', () => {
  windThresholdMph = parseInt(windSelect.value, 10);
  if (!lastForecastData) return;
  destroyCharts();
  const days = sliceIntoDays(lastForecastData);
  days.forEach(d => createDayChart(d));
});

// ─── Refresh button ──────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.classList.contains('spinning')) return;
  refreshBtn.classList.add('spinning');
  try {
    await loadWeather(currentLat, currentLon);
  } finally {
    refreshBtn.classList.remove('spinning');
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────
locationLabel.textContent = DEFAULT_LABEL;
loadWeather(DEFAULT_LAT, DEFAULT_LON);
