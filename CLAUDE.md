# Weather App — Project Instructions

## Overview
A static weather dashboard (no backend) that shows a 5-day hourly forecast using Open-Meteo's free API. Default location is 10065 (Upper East Side, NYC). Users can search for any city via the geocoding dropdown.

## Tech stack
- HTML5 + CSS3 + vanilla JavaScript (ES6+)
- Chart.js v4 via CDN (mixed line+bar charts, dual y-axes)
- Custom Chart.js plugin for wind dots
- No build step, no npm, no framework

## File structure
```
index.html  — entry point, loads CSS + JS
style.css   — layout, theming, responsive rules
app.js      — fetch, process, render charts
CLAUDE.md   — this file
```

## Run
```
python3 -m http.server 8080
```
Then open http://localhost:8080

## Verify checklist
Open http://localhost:8080 in the browser and confirm ALL of the following:

- [ ] Page loads without console errors
- [ ] Default location shows "New York — Upper East Side"
- [ ] 5 chart cards render, one per day (today + next 4 days)
- [ ] Today's card is labeled "Today — [Day, Mon DD]"
- [ ] Each chart has 24 x-axis tick marks
- [ ] X-axis labels appear every 3 hours in 12h format (12AM, 3AM, 6AM, 9AM, 12PM, 3PM, 6PM, 9PM)
- [ ] Red temperature line uses left y-axis labeled "°C"
- [ ] Blue precipitation bars use right y-axis labeled "mm"
- [ ] Orange wind dots appear below x-axis for hours where wind > 10 mph
- [ ] Hovering a chart shows tooltip with temp, precip, and wind speed
- [ ] Search input triggers dropdown with up to 5 city results
- [ ] Clicking a city reloads all charts with new location data
- [ ] Page scrolls smoothly between chart cards
- [ ] Layout looks good at both desktop (900px+) and mobile (375px) widths

## Fix loop
If any check fails, fix the relevant file and re-verify ALL checks.
Do not move on until every box is ticked.
