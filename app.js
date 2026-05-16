/* ═══════════════════════════════════════════════════════════════════
   F1 LIVE RACE DASHBOARD  —  app.js (SignalR WebSocket version)
   ═══════════════════════════════════════════════════════════════════ */

// Connect to our local Python FastF1 WebSocket server
const WS_URL = 'ws://localhost:8001/ws';

/* ── tyre compound → letter ── */
const TYRE_MAP = { SOFT:'S', MEDIUM:'M', HARD:'H', INTERMEDIATE:'I', WET:'W' };

/* ── Global State ── */
let state = {
  DriverList: {},
  TimingData: { Lines: {} },
  SessionInfo: {},
  RaceControlMessages: { Messages: [] },
  WeatherData: {},
  TrackStatus: { Message: '', Status: '1' },
  LapCount: {},
  TopThree: { Lines: [] }
};

let pitStops = []; // F1 TimingData gives Stints, we can derive pits
let ws = null;
let isHistorical = false;

/* ══════════════════════════ HELPER: DEEP MERGE ═════════════════════ */
function deepMerge(target, source) {
  if (typeof source !== 'object' || source === null) return source;
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  return target;
}

/* ══════════════════════════ HELPER: DECOMPRESS ═════════════════════ */
function decodeBase64Zlib(base64Str) {
  try {
    const decoded = atob(base64Str);
    const compressed = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) compressed[i] = decoded.charCodeAt(i);
    const decompressed = window.pako.inflate(compressed, { to: 'string' });
    return JSON.parse(decompressed);
  } catch (e) {
    console.error("Failed to decompress data", e);
    return null;
  }
}

/* ══════════════════════════ WS CONNECTION ══════════════════════════ */
function connectWS() {
  setStatus('idle', 'Connecting…');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('live', 'Live');
    console.log("WebSocket connected.");
  };

  ws.onclose = () => {
    setStatus('offline', 'Disconnected');
    console.log("WebSocket disconnected, reconnecting in 5s...");
    setTimeout(connectWS, 5000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init') {
        if (isHistorical) {
          isHistorical = false;
          hideHistoricalBanner();
          setStatus('live', 'Live');
        }
        processInit(msg.data);
      } else if (msg.type === 'feed') {
        if (isHistorical) {
          isHistorical = false;
          hideHistoricalBanner();
          setStatus('live', 'Live');
        }
        processFeed(msg.data);
      } else if (msg.type === 'historical') {
        processHistorical(msg.data);
      }
      requestAnimationFrame(renderAll);
    } catch (e) {
      console.error("Error processing message", e);
    }
  };
}

/* ══════════════════════════ DATA PROCESSING ════════════════════════ */
function processInit(data) {
  for (const topic in data) {
    const val = data[topic];
    if (topic.endsWith('.z') && typeof val === 'string') {
      const decompressed = decodeBase64Zlib(val);
      if (decompressed) state[topic.replace('.z', '')] = decompressed;
    } else {
      state[topic] = val;
    }
  }
}

function processFeed(dataList) {
  // dataList is usually [topic, jsonDataStr, timestamp]
  const topic = dataList[0];
  const payloadStr = dataList[1];
  
  if (!payloadStr) return;
  
  let payload;
  if (topic.endsWith('.z')) {
    payload = decodeBase64Zlib(payloadStr);
  } else {
    payload = JSON.parse(payloadStr);
  }

  if (topic === 'RaceControlMessages') {
    // Append messages rather than merge
    if (payload.Messages) {
      const newMsgs = payload.Messages;
      if (!state.RaceControlMessages.Messages) state.RaceControlMessages.Messages = [];
      state.RaceControlMessages.Messages.push(...newMsgs);
      // Show toast for latest
      if (newMsgs.length > 0) {
        showToast(`🚩 ${newMsgs[newMsgs.length-1].Message || 'Race Control update'}`, 'toast-rc');
      }
    }
  } else {
    // Deep merge delta updates
    const cleanTopic = topic.replace('.z', '');
    if (!state[cleanTopic]) state[cleanTopic] = {};
    deepMerge(state[cleanTopic], payload);
  }
}

function processHistorical(data) {
  isHistorical = true;
  state.DriverList          = data.DriverList          || {};
  state.TimingData          = data.TimingData          || { Lines: {} };
  state.WeatherData         = data.WeatherData         || {};
  state.RaceControlMessages = data.RaceControlMessages || { Messages: [] };
  state.SessionInfo         = data.SessionInfo         || {};
  state.LapCount            = data.LapCount            || {};
  state.TrackStatus         = data.TrackStatus         || { Status: '1', Message: '' };

  const meta = data._meta || {};
  const label = `${meta.year || ''} ${meta.eventName || data.SessionInfo?.Meeting?.Name || 'last race'}`.trim();
  showHistoricalBanner(label);
  setStatus('historical', 'Historical');
}

function showHistoricalBanner(raceLabel) {
  const banner = document.getElementById('historical-banner');
  if (!banner) return;
  document.getElementById('historical-banner-text').textContent =
    `No live session — showing ${raceLabel} results`;
  banner.classList.remove('hidden');
}

function hideHistoricalBanner() {
  document.getElementById('historical-banner')?.classList.add('hidden');
}

/* ══════════════════════════ RENDERING ══════════════════════════════ */
function renderAll() {
  renderHeader();
  renderStandings();
  renderWeather();
  renderRaceControl();
  renderFastestLap();
}

function renderHeader() {
  const sInfo = state.SessionInfo || {};
  document.getElementById('session-label').textContent = 
    `${sInfo.Meeting?.Name || 'Grand Prix'}  ·  ${sInfo.Name || 'Session'}`;
    
  const lc = state.LapCount || {};
  if (lc.CurrentLap) {
    document.getElementById('current-lap').textContent = lc.CurrentLap;
  }
  
  document.getElementById('total-laps').textContent = lc.TotalLaps || '—';
  
  // Track Status flag stripe
  updateFlagStripe();
}

function renderStandings() {
  const tbody = document.getElementById('standings-body');
  document.getElementById('standings-loading').classList.add('hidden');
  
  const driversInfo = state.DriverList || {};
  const lines = state.TimingData?.Lines || {};
  
  // Convert lines to array and sort by position
  const positions = Object.keys(lines)
    .filter(k => lines[k].Position)
    .map(k => ({ num: k, data: lines[k] }))
    .sort((a, b) => parseInt(a.data.Position) - parseInt(b.data.Position));

  if (!positions.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="empty-icon">🏎️</span>Waiting for timing data...</div></td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  positions.forEach((item, idx) => {
    const dNum = item.num;
    const dData = item.data;
    const info = driversInfo[dNum] || {};
    
    const pos = dData.Position;
    const posClass = idx === 0 ? 'pos-1' : idx === 1 ? 'pos-2' : idx === 2 ? 'pos-3' : '';
    const color = info.TeamColour ? `#${info.TeamColour}` : '#888';
    const acronym = info.Tla || `#${dNum}`;
    const fullName = `${info.FirstName || ''} ${info.LastName || ''}`.trim();
    const team = info.TeamName || '—';
    
    // Gap
    let gapTxt = idx === 0 ? 'LEADER' : (dData.GapToLeader || dData.TimeDiffToPositionAhead || '—');
    const gapClass = idx === 0 ? 'td-gap is-leader' : 'td-gap';

    // Lap time
    const lastLap = dData.LastLapTime?.Value || '—';
    const personalBest = dData.LastLapTime?.PersonalFastest;
    const overallFastest = dData.LastLapTime?.OverallFastest;
    let lapClass = 'td-lap';
    if (overallFastest) lapClass += ' fastest';
    else if (personalBest) lapClass += ' personal-best';

    // Tyre
    let tyreLetter = '';
    if (dData.Stints && dData.Stints.length > 0) {
      const currentStint = dData.Stints[dData.Stints.length - 1];
      if (currentStint && currentStint.Compound) {
        tyreLetter = TYRE_MAP[currentStint.Compound.toUpperCase()] || currentStint.Compound[0];
      }
    }
    const tyreClass = `tyre-badge tyre-${tyreLetter}`;

    // Pit count
    const pitCount = dData.NumberOfPitStops || (dData.Stints ? dData.Stints.length - 1 : 0);

    const tr = document.createElement('tr');
    tr.className = posClass;
    tr.innerHTML = `
      <td class="td-pos"><span class="td-pos-num">${pos}</span></td>
      <td>
        <div class="driver-cell">
          <div class="driver-color-bar" style="background:${color}"></div>
          <div class="driver-info">
            <span class="driver-acronym">${acronym}</span>
            <span class="driver-name">${fullName}</span>
          </div>
        </div>
      </td>
      <td class="td-team">${team}</td>
      <td class="${gapClass}">${gapTxt}</td>
      <td class="${lapClass}">${lastLap}</td>
      <td class="td-tyre"><span class="${tyreClass}">${tyreLetter || '?'}</span></td>
      <td class="td-pit">${pitCount > 0 ? pitCount : '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  // Render pits summary
  renderPitStops(positions, driversInfo);
}

function renderPitStops(positions, driversInfo) {
  const list = document.getElementById('pit-list');
  document.getElementById('pits-loading').classList.add('hidden');
  
  // Extract all stints and filter those in pit
  let recentPits = [];
  positions.forEach(item => {
    if (item.data.InPit && item.data.PitOut === false) {
      recentPits.push({
        num: item.num,
        tla: driversInfo[item.num]?.Tla || `#${item.num}`,
        stops: item.data.NumberOfPitStops || '1'
      });
    }
  });

  document.getElementById('pit-count').textContent = `${recentPits.length} currently in pit`;

  if (!recentPits.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">🛞</span>No cars in pit</div>`;
    return;
  }

  list.innerHTML = '';
  recentPits.forEach(p => {
    const el = document.createElement('div');
    el.className = 'pit-item';
    el.innerHTML = `
      <span class="pit-lap-badge">IN PIT</span>
      <span class="pit-driver">${p.tla}</span>
      <span class="pit-stop-num">Stop ${p.stops}</span>
      <span class="pit-duration ok">...</span>
    `;
    list.appendChild(el);
  });
}

function renderWeather() {
  const grid = document.getElementById('weather-grid');
  document.getElementById('weather-loading').classList.add('hidden');
  
  const w = state.WeatherData || {};

  if (!Object.keys(w).length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:span 3"><span class="empty-icon">🌦️</span>No weather data</div>`;
    return;
  }

  const isRaining = w.Rainfall === '1';
  const cells = [
    { icon: '🌡️', value: `${w.AirTemp || '—'}°C`, label: 'Air Temp' },
    { icon: '🏎️', value: `${w.TrackTemp || '—'}°C`, label: 'Track Temp' },
    { icon: isRaining ? '🌧️' : '☀️', value: isRaining ? 'Rain' : 'Dry', label: 'Conditions' },
    { icon: '💧', value: `${w.Humidity || '—'}%`, label: 'Humidity' },
    { icon: '🌬️', value: `${w.WindSpeed || '—'} m/s`, label: 'Wind' },
    { icon: '🧭', value: `${w.WindDirection || '—'}°`, label: 'Wind Dir' },
  ];

  grid.innerHTML = cells.map(c => `
    <div class="weather-cell">
      <span class="wc-icon">${c.icon}</span>
      <span class="wc-value">${c.value}</span>
      <span class="wc-label">${c.label}</span>
    </div>
  `).join('');
}

function renderRaceControl() {
  const list = document.getElementById('rc-list');
  const countEl = document.getElementById('rc-count');
  document.getElementById('rc-loading').classList.add('hidden');

  const messages = state.RaceControlMessages?.Messages || [];
  countEl.textContent = `${messages.length} messages`;

  if (!messages.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">🚩</span>No messages yet</div>`;
    return;
  }

  // Show most recent first
  const displayMsgs = [...messages].reverse().slice(0, 30);
  
  list.innerHTML = '';
  displayMsgs.forEach((msg, i) => {
    const flag = (msg.Flag || msg.Category || '').toLowerCase();
    let cls = 'rc-item ';
    if (flag.includes('green') || flag.includes('clear')) cls += 'flag-green';
    else if (flag.includes('yellow') || flag.includes('safety car')) cls += 'flag-yellow';
    else if (flag.includes('red')) cls += 'flag-red';
    else if (flag.includes('drs')) cls += 'flag-drs';
    else cls += 'flag-other';

    // F1 time string is often in 'UTC' Date format or 'Utc' property
    let timeStr = msg.Utc ? new Date(msg.Utc).toLocaleTimeString() : '—';
    
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = `
      <span class="rc-time">${timeStr}</span>
      <span class="rc-msg">${msg.Message || '—'}</span>
    `;
    list.appendChild(el);
  });
  
  // Update Ticker
  const msgsText = displayMsgs.slice(0, 15).map(m => m.Message).filter(Boolean);
  if (msgsText.length) {
    document.getElementById('ticker-content').textContent = msgsText.join('   ·   ');
  }
}

function renderFastestLap() {
  const lines = state.TimingData?.Lines || {};
  let fastestVal = null;
  let fastestDriver = null;
  
  // Simple scan for OverallFastest flag in LastLapTime or BestLapTime
  for (const num in lines) {
    const d = lines[num];
    if (d.BestLapTime?.OverallFastest) {
      fastestVal = d.BestLapTime.Value;
      fastestDriver = num;
      break;
    }
  }
  
  if (fastestVal && fastestDriver) {
    const info = state.DriverList[fastestDriver] || {};
    document.getElementById('fastlap-time').textContent = fastestVal;
    document.getElementById('fastlap-driver').textContent = info.Tla || `#${fastestDriver}`;
    document.getElementById('fastlap-meta').textContent = `Team ${info.TeamName || '—'}`;
  }
}

function updateFlagStripe() {
  const stripe = document.getElementById('flag-stripe');
  stripe.className = 'flag-stripe';
  
  const status = state.TrackStatus?.Status;
  // Status mapping typically: 1=Clear, 2=Yellow, 4=SC, 5=Red, 6=VSC, 7=VSC ending
  if (status === '1') stripe.classList.add('green-flag');
  else if (status === '2') stripe.classList.add('yellow-flag');
  else if (status === '4') stripe.classList.add('sc');
  else if (status === '5') stripe.classList.add('red-flag');
  else if (status === '6' || status === '7') stripe.classList.add('vsc');
}

/* ══════════════════════════ STATUS / UI ════════════════════════════ */
function setStatus(type, label) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  dot.className = `status-dot ${type}`;
  txt.textContent = label;
}

function showToast(msg, cls = 'toast-info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// Remove the manual refresh button logic since we are WebSocket streaming now
document.getElementById('btn-refresh').style.display = 'none';
document.querySelector('.refresh-info').style.display = 'none';

/* ══════════════════════════ BOOT ═══════════════════════════════════ */
document.getElementById('historical-banner-close')
  ?.addEventListener('click', hideHistoricalBanner);

connectWS();

// Fetch historical data via HTTP on load.
// If the WebSocket already delivered data (isHistorical or live), skip it.
setTimeout(async () => {
  if (Object.keys(state.DriverList).length > 0) return; // WS already has data
  try {
    const r = await fetch('http://localhost:8001/api/historical');
    if (!r.ok) return;
    const msg = await r.json();
    if (msg.type === 'historical') {
      processHistorical(msg.data);
      requestAnimationFrame(renderAll);
    }
  } catch (e) {
    console.warn('Historical HTTP fetch failed:', e);
  }
}, 2000);
