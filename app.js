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

function tempColor(val) {
  if (val == null) return '#d94f4f';
  if (val > 25) return '#d94f4f';   // red — hot
  if (val > 15) return '#e8b84a';   // yellow — warm
  if (val > 5)  return '#4caf50';   // green — mild
  return '#4a90e2';                  // blue — cold
}

// ─── Weather icon SVGs ──────────────────────────────────────────────────────

function weatherIconSVG(hour, cloudCover, precip, temp) {
  const isDay = hour >= 8 && hour < 20;
  const sz = 'viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';

  if (precip > 0 && temp < 0) {
    // Snow
    return `<svg ${sz}>
      <path d="M6 14c0-2 2-3.5 4.5-3.5S13 10 14 10c2.5 0 4 1.5 4 3.5S16 17 14 17H6.5C4.5 17 3 15.8 6 14z" fill="#7a7a8a"/>
      <circle cx="8" cy="20" r="1" fill="#e0e8f0"/><circle cx="12" cy="21" r="1" fill="#e0e8f0"/><circle cx="16" cy="20" r="1" fill="#e0e8f0"/>
      <circle cx="10" cy="23" r="0.8" fill="#e0e8f0"/><circle cx="14" cy="23" r="0.8" fill="#e0e8f0"/>
    </svg>`;
  }
  if (precip > 0) {
    // Rain
    return `<svg ${sz}>
      <path d="M6 12c0-2 2-3.5 4.5-3.5S13 8 14 8c2.5 0 4 1.5 4 3.5S16 15 14 15H6.5C4.5 15 3 13.8 6 12z" fill="#7a7a8a"/>
      <line x1="9" y1="17" x2="8" y2="21" stroke="#4a90e2" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="13" y1="17" x2="12" y2="21" stroke="#4a90e2" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="17" y1="17" x2="16" y2="20" stroke="#4a90e2" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }
  if (cloudCover > 75) {
    // Full cloud
    return `<svg ${sz}>
      <path d="M5 14c0-2.5 2.5-4 5-4 .5-2 2.5-3.5 5-3.5 3 0 5 2 5 4.5 0 .3 0 .6-.1.9C21.5 12.5 22 13.5 22 15c0 2-1.5 3.5-3.5 3.5H6c-2 0-3.5-1.5-3.5-3.5 0-1.5 1-2.8 2.5-3z" fill="#7a7a8a"/>
    </svg>`;
  }
  if (cloudCover >= 25) {
    // Partial cloud
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
  if (isDay) {
    // Full sun
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
  // Moon
  return `<svg ${sz}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#a0b4d0"/>
  </svg>`;
}

// ─── Chart.js plugins ───────────────────────────────────────────────────────

const dayNightPlugin = {
  id: 'dayNight',
  beforeDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const xAxis = chart.scales.x;
    const { top, bottom } = chart.chartArea;
    const xLeft = xAxis.getPixelForValue(8);
    const xRight = xAxis.getPixelForValue(20);
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

Chart.register(dayNightPlugin, currentTimePlugin, windDotPlugin);

// ─── Data fetching ───────────────────────────────────────────────────────────

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'temperature_2m,precipitation,wind_speed_10m,cloud_cover',
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

  const dayMap = new Map();

  times.forEach((t, i) => {
    const dateStr = t.split('T')[0];
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, { date: dateStr, temps: [], precip: [], wind: [], cloud: [], hours: [] });
    }
    const day = dayMap.get(dateStr);
    day.hours.push(parseInt(t.split('T')[1].split(':')[0], 10));
    day.temps.push(temps[i]);
    day.precip.push(precip[i]);
    day.wind.push(wind[i]); // km/h
    day.cloud.push(cloud[i]); // %
  });

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

  dayData.hours.forEach((h, i) => {
    temps[h] = dayData.temps[i];
    precip[h] = dayData.precip[i] ?? 0;
    windBool[h] = (dayData.wind[i] * KMH_TO_MPH) > windThresholdMph;
    cloudArr[h] = dayData.cloud?.[i] ?? null;
  });

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
        currentTime: { isToday: isToday(dayData.date) }
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
          min: -5,
          max: 30,
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
      if (cloudArr[h] == null && temps[h] == null) continue;
      const x = chart.scales.x.getPixelForValue(h);
      const span = document.createElement('span');
      span.className = 'weather-icon';
      span.style.left = x + 'px';
      span.innerHTML = weatherIconSVG(h, cloudArr[h] ?? 0, precip[h], temps[h] ?? 0);
      iconStrip.appendChild(span);
    }
  }
  // Defer first call so Chart.js layout is complete (double rAF)
  requestAnimationFrame(() => requestAnimationFrame(() => populateIcons()));

  const ro = new ResizeObserver(() => requestAnimationFrame(() => populateIcons()));
  ro.observe(canvasWrap);
  chart._iconResizeObserver = ro;

  // Hide tooltip as soon as finger lifts on touch devices so the chart
  // stays legible when scrolling down the page after a tap.
  const hideTooltip = () => {
    chart.setActiveElements([]);
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update('none');
  };
  canvas.addEventListener('touchend', hideTooltip);
  canvas.addEventListener('touchcancel', hideTooltip);

  charts.push(chart);
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
