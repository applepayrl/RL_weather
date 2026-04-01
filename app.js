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

// ─── Wind dot plugin (Chart.js) ──────────────────────────────────────────────
// This is a custom Chart.js plugin. Plugins let you hook into the chart
// lifecycle and draw custom graphics. "afterDraw" fires after Chart.js has
// finished rendering everything else, so we can paint dots on top.

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

Chart.register(windDotPlugin);

// ─── Data fetching ───────────────────────────────────────────────────────────

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'temperature_2m,precipitation,wind_speed_10m',
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

  const dayMap = new Map();

  times.forEach((t, i) => {
    const dateStr = t.split('T')[0];
    if (!dayMap.has(dateStr)) {
      dayMap.set(dateStr, { date: dateStr, temps: [], precip: [], wind: [], hours: [] });
    }
    const day = dayMap.get(dateStr);
    day.hours.push(parseInt(t.split('T')[1].split(':')[0], 10));
    day.temps.push(temps[i]);
    day.precip.push(precip[i]);
    day.wind.push(wind[i]); // km/h
  });

  // Take first 5 days (in case API returns a partial 6th)
  return [...dayMap.values()].slice(0, 5);
}

// ─── Chart rendering ─────────────────────────────────────────────────────────

function destroyCharts() {
  charts.forEach(c => c.destroy());
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

  dayData.hours.forEach((h, i) => {
    temps[h] = dayData.temps[i];
    precip[h] = dayData.precip[i] ?? 0;
    windBool[h] = (dayData.wind[i] * KMH_TO_MPH) > windThresholdMph;
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
          tension: 0.35,
          fill: true,
          yAxisID: 'yTemp',
          spanGaps: true,
          order: 1
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
        windDots: { data: windBool }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(150,150,150,0.1)',
            drawTicks: true
          },
          ticks: {
            maxRotation: 0,
            font: { family: "'DM Mono', monospace", size: 11 },
            color: '#8a8a9a',
            autoSkip: false,
            callback(value, index) {
              return index % 3 === 0 ? this.getLabelForValue(value) : '';
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
            color: '#d94f4f'
          },
          grid: { color: 'rgba(150,150,150,0.08)' },
          ticks: {
            stepSize: 5,
            font: { family: "'DM Mono', monospace", size: 11 },
            color: '#d94f4f'
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

  charts.push(chart);
}

// ─── Main render ─────────────────────────────────────────────────────────────

async function loadWeather(lat, lon) {
  loadingEl.classList.add('visible');
  destroyCharts();

  try {
    const data = await fetchForecast(lat, lon);
    lastForecastData = data;
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

// ─── Init ────────────────────────────────────────────────────────────────────
locationLabel.textContent = DEFAULT_LABEL;
loadWeather(DEFAULT_LAT, DEFAULT_LON);
