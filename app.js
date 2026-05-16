/* ═══════════════════════════════════════════════════════════════════
   F1 LIVE RACE DASHBOARD  —  app.js
   ═══════════════════════════════════════════════════════════════════ */

const WS_URL = 'ws://localhost:8001/ws';
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

let ws = null;
let isHistorical = false;

/* ── Delay Queue ── */
let delayMs = 0;
let messageQueue = []; // { msg, ts }[]

/* ── DOM diffing state ── */
const rowMap = new Map();         // driverNum → <tr>
const prevRowPos = new Map();     // driverNum → last rendered position string
let prevWeatherBuilt = false;     // whether weather cells exist with data-wkey

/* ══════════════════════════ HELPERS ════════════════════════════════ */
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

function decodeBase64Zlib(base64Str) {
  try {
    const decoded = atob(base64Str);
    const compressed = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) compressed[i] = decoded.charCodeAt(i);
    return JSON.parse(window.pako.inflate(compressed, { to: 'string' }));
  } catch (e) {
    console.error('Decompress failed', e);
    return null;
  }
}

/* Update an element's text and flash it if the value changed. */
function flashCell(el, newText, flashCls = 'cell-flash') {
  if (!el) return false;
  const text = String(newText);
  if (el.textContent === text) return false;
  el.textContent = text;
  el.classList.remove('cell-flash', 'cell-flash-fastest', 'cell-flash-pb');
  void el.offsetWidth; // restart animation
  el.classList.add(flashCls);
  return true;
}

/* ══════════════════════════ WS CONNECTION ══════════════════════════ */
function connectWS() {
  setStatus('idle', 'Connecting…');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    if (!delayMs) setStatus('live', 'Live');
    console.log('WebSocket connected.');
  };

  ws.onclose = () => {
    setStatus('offline', 'Disconnected');
    console.log('WebSocket disconnected, reconnecting in 5s…');
    setTimeout(connectWS, 5000);
  };

  ws.onerror = (err) => console.error('WebSocket error:', err);

  ws.onmessage = (event) => {
    try {
      messageQueue.push({ msg: JSON.parse(event.data), ts: Date.now() });
    } catch (e) {
      console.error('Error parsing message', e);
    }
  };
}

/* ══════════════════════════ DELAY QUEUE ════════════════════════════ */
function drainQueue() {
  const now = Date.now();
  let didUpdate = false;

  while (messageQueue.length && now - messageQueue[0].ts >= delayMs) {
    applyMessage(messageQueue.shift().msg);
    didUpdate = true;
  }

  if (didUpdate) setTimeout(renderAll, 0);
  updateDelayUI();
}

setInterval(drainQueue, 50);

/* ══════════════════════════ DATA PROCESSING ════════════════════════ */
function applyMessage(msg) {
  if (msg.type === 'init') {
    if (isHistorical) { isHistorical = false; hideHistoricalBanner(); }
    if (!delayMs) setStatus('live', 'Live');
    processInit(msg.data);
  } else if (msg.type === 'feed') {
    if (isHistorical) { isHistorical = false; hideHistoricalBanner(); }
    if (!delayMs) setStatus('live', 'Live');
    processFeed(msg.data);
  } else if (msg.type === 'historical') {
    processHistorical(msg.data);
  }
}

function processInit(data) {
  for (const topic in data) {
    const val = data[topic];
    if (topic.endsWith('.z') && typeof val === 'string') {
      const d = decodeBase64Zlib(val);
      if (d) state[topic.replace('.z', '')] = d;
    } else {
      state[topic] = val;
    }
  }
}

function processFeed(dataList) {
  const topic = dataList[0];
  const payloadStr = dataList[1];
  if (!payloadStr) return;

  const payload = topic.endsWith('.z')
    ? decodeBase64Zlib(payloadStr)
    : JSON.parse(payloadStr);

  if (topic === 'RaceControlMessages') {
    if (payload?.Messages) {
      if (!state.RaceControlMessages.Messages) state.RaceControlMessages.Messages = [];
      state.RaceControlMessages.Messages.push(...payload.Messages);
      const last = payload.Messages[payload.Messages.length - 1];
      if (last) showToast(`🚩 ${last.Message || 'Race Control update'}`, 'toast-rc');
    }
  } else {
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
  if (lc.CurrentLap) document.getElementById('current-lap').textContent = lc.CurrentLap;
  document.getElementById('total-laps').textContent = lc.TotalLaps || '—';

  updateFlagStripe();
}

/* ── Standings (DOM-diffing) ─────────────────────────────────────── */
function renderStandings() {
  const tbody = document.getElementById('standings-body');
  document.getElementById('standings-loading').classList.add('hidden');

  const driversInfo = state.DriverList || {};
  const lines = state.TimingData?.Lines || {};

  const positions = Object.keys(lines)
    .filter(k => lines[k].Position)
    .map(k => ({ num: k, data: lines[k] }))
    .sort((a, b) => parseInt(a.data.Position) - parseInt(b.data.Position));

  if (!positions.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><span class="empty-icon">🏎️</span>Waiting for timing data...</div></td></tr>`;
    rowMap.clear();
    prevRowPos.clear();
    return;
  }

  const activeDrivers = new Set();

  positions.forEach((item, idx) => {
    const dNum = item.num;
    const dData = item.data;
    const info  = driversInfo[dNum] || {};
    activeDrivers.add(dNum);

    const pos      = dData.Position;
    const posClass = idx === 0 ? 'pos-1' : idx === 1 ? 'pos-2' : idx === 2 ? 'pos-3' : '';
    const color    = info.TeamColour ? `#${info.TeamColour}` : '#888';
    const acronym  = info.Tla || `#${dNum}`;
    const fullName = `${info.FirstName || ''} ${info.LastName || ''}`.trim();
    const team     = info.TeamName || '—';

    const gapTxt  = idx === 0 ? 'LEADER' : (dData.GapToLeader || dData.TimeDiffToPositionAhead || '—');
    const gapClass = idx === 0 ? 'td-gap is-leader' : 'td-gap';

    const lastLap       = dData.LastLapTime?.Value || '—';
    const overallFastest = dData.LastLapTime?.OverallFastest;
    const personalBest   = dData.LastLapTime?.PersonalFastest;
    const lapClass = 'td-lap' + (overallFastest ? ' fastest' : personalBest ? ' personal-best' : '');

    let tyreLetter = '';
    if (dData.Stints?.length) {
      const stint = dData.Stints[dData.Stints.length - 1];
      if (stint?.Compound) tyreLetter = TYRE_MAP[stint.Compound.toUpperCase()] || stint.Compound[0];
    }
    const tyreClass = `tyre-badge tyre-${tyreLetter}`;

    const pitCount = dData.NumberOfPitStops || (dData.Stints ? dData.Stints.length - 1 : 0);
    const pitTxt   = pitCount > 0 ? String(pitCount) : '—';

    const isNew = !rowMap.has(dNum);
    let tr;

    if (isNew) {
      // Build full row once for new drivers
      tr = document.createElement('tr');
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
        <td class="td-pit">${pitTxt}</td>
      `;
      tr.classList.add('row-entering');
      tr.addEventListener('animationend', () => tr.classList.remove('row-entering'), { once: true });
      rowMap.set(dNum, tr);
    } else {
      tr = rowMap.get(dNum);

      // Flash position number if it changed
      flashCell(tr.querySelector('.td-pos-num'), pos, 'cell-flash');

      // Gap
      const gapCell = tr.cells[3];
      if (gapCell) {
        gapCell.className = gapClass;
        flashCell(gapCell, gapTxt, 'cell-flash');
      }

      // Lap time — flash colour depends on whether it's fastest/personal best
      const lapCell = tr.cells[4];
      if (lapCell) {
        const lapFlash = overallFastest ? 'cell-flash-fastest' : personalBest ? 'cell-flash-pb' : 'cell-flash';
        lapCell.className = lapClass;
        flashCell(lapCell, lastLap, lapFlash);
      }

      // Tyre compound
      const tyreBadge = tr.querySelector('.tyre-badge');
      if (tyreBadge && (tyreBadge.textContent !== (tyreLetter || '?') || tyreBadge.className !== tyreClass)) {
        tyreBadge.className = tyreClass;
        tyreBadge.textContent = tyreLetter || '?';
        const tyreCell = tr.cells[5];
        if (tyreCell) {
          tyreCell.classList.remove('cell-flash');
          void tyreCell.offsetWidth;
          tyreCell.classList.add('cell-flash');
        }
      }

      // Pit count
      flashCell(tr.cells[6], pitTxt, 'cell-flash');

      // Brief row highlight on position change
      const prevPos = prevRowPos.get(dNum);
      if (prevPos && prevPos !== pos) {
        tr.classList.remove('row-moved');
        void tr.offsetWidth;
        tr.classList.add('row-moved');
      }
    }

    // Keep row highlight class in sync (preserve animation classes)
    if (!tr.classList.contains('row-entering')) tr.className = posClass;

    prevRowPos.set(dNum, pos);

    // Append in sorted order — moves existing rows without destroying them
    tbody.appendChild(tr);
  });

  // Remove rows for drivers no longer in the timing feed
  for (const [dNum, tr] of rowMap) {
    if (!activeDrivers.has(dNum)) {
      tr.remove();
      rowMap.delete(dNum);
      prevRowPos.delete(dNum);
    }
  }

  renderPitStops(positions, driversInfo);
}

function renderPitStops(positions, driversInfo) {
  const list = document.getElementById('pit-list');
  document.getElementById('pits-loading').classList.add('hidden');

  const recentPits = positions
    .filter(item => item.data.InPit && item.data.PitOut === false)
    .map(item => ({
      tla:   driversInfo[item.num]?.Tla || `#${item.num}`,
      stops: item.data.NumberOfPitStops || '1'
    }));

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

/* ── Weather (DOM-diffing) ───────────────────────────────────────── */
function renderWeather() {
  const grid = document.getElementById('weather-grid');
  document.getElementById('weather-loading').classList.add('hidden');

  const w = state.WeatherData || {};

  if (!Object.keys(w).length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:span 3"><span class="empty-icon">🌦️</span>No weather data</div>`;
    prevWeatherBuilt = false;
    return;
  }

  const isRaining = w.Rainfall === '1';
  const cells = [
    { key: 'AirTemp',       icon: '🌡️', value: `${w.AirTemp || '—'}°C`,       label: 'Air Temp' },
    { key: 'TrackTemp',     icon: '🏎️', value: `${w.TrackTemp || '—'}°C`,     label: 'Track Temp' },
    { key: 'Rainfall',      icon: isRaining ? '🌧️' : '☀️', value: isRaining ? 'Rain' : 'Dry', label: 'Conditions' },
    { key: 'Humidity',      icon: '💧', value: `${w.Humidity || '—'}%`,        label: 'Humidity' },
    { key: 'WindSpeed',     icon: '🌬️', value: `${w.WindSpeed || '—'} m/s`,   label: 'Wind' },
    { key: 'WindDirection', icon: '🧭', value: `${w.WindDirection || '—'}°`,  label: 'Wind Dir' },
  ];

  if (!prevWeatherBuilt) {
    grid.innerHTML = cells.map(c => `
      <div class="weather-cell" data-wkey="${c.key}">
        <span class="wc-icon">${c.icon}</span>
        <span class="wc-value">${c.value}</span>
        <span class="wc-label">${c.label}</span>
      </div>
    `).join('');
    prevWeatherBuilt = true;
    return;
  }

  cells.forEach(c => {
    const cellEl = grid.querySelector(`[data-wkey="${c.key}"]`);
    if (!cellEl) return;
    const valueEl = cellEl.querySelector('.wc-value');
    const iconEl  = cellEl.querySelector('.wc-icon');
    if (iconEl) iconEl.textContent = c.icon;
    if (valueEl && valueEl.textContent !== c.value) {
      valueEl.textContent = c.value;
      cellEl.classList.remove('cell-flash');
      void cellEl.offsetWidth;
      cellEl.classList.add('cell-flash');
    }
  });
}

/* ── Race Control ────────────────────────────────────────────────── */
function renderRaceControl() {
  const list    = document.getElementById('rc-list');
  const countEl = document.getElementById('rc-count');
  document.getElementById('rc-loading').classList.add('hidden');

  const messages = state.RaceControlMessages?.Messages || [];
  countEl.textContent = `${messages.length} messages`;

  if (!messages.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">🚩</span>No messages yet</div>`;
    return;
  }

  const displayMsgs = [...messages].reverse().slice(0, 30);

  list.innerHTML = '';
  displayMsgs.forEach(msg => {
    const flag = (msg.Flag || msg.Category || '').toLowerCase();
    let cls = 'rc-item ';
    if      (flag.includes('green') || flag.includes('clear'))      cls += 'flag-green';
    else if (flag.includes('yellow') || flag.includes('safety car')) cls += 'flag-yellow';
    else if (flag.includes('red'))                                   cls += 'flag-red';
    else if (flag.includes('drs'))                                   cls += 'flag-drs';
    else                                                             cls += 'flag-other';

    const timeStr = msg.Utc ? new Date(msg.Utc).toLocaleTimeString() : '—';
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = `<span class="rc-time">${timeStr}</span><span class="rc-msg">${msg.Message || '—'}</span>`;
    list.appendChild(el);
  });

  const msgsText = displayMsgs.slice(0, 15).map(m => m.Message).filter(Boolean);
  if (msgsText.length) {
    document.getElementById('ticker-content').textContent = msgsText.join('   ·   ');
  }
}

/* ── Fastest Lap ─────────────────────────────────────────────────── */
function renderFastestLap() {
  const lines = state.TimingData?.Lines || {};
  for (const num in lines) {
    if (lines[num].BestLapTime?.OverallFastest) {
      const info = state.DriverList[num] || {};
      document.getElementById('fastlap-time').textContent   = lines[num].BestLapTime.Value;
      document.getElementById('fastlap-driver').textContent = info.Tla || `#${num}`;
      document.getElementById('fastlap-meta').textContent   = `Team ${info.TeamName || '—'}`;
      break;
    }
  }
}

/* ── Flag Stripe ─────────────────────────────────────────────────── */
function updateFlagStripe() {
  const stripe = document.getElementById('flag-stripe');
  stripe.className = 'flag-stripe';
  const status = state.TrackStatus?.Status;
  if      (status === '1')              stripe.classList.add('green-flag');
  else if (status === '2')              stripe.classList.add('yellow-flag');
  else if (status === '4')              stripe.classList.add('sc');
  else if (status === '5')              stripe.classList.add('red-flag');
  else if (status === '6' || status === '7') stripe.classList.add('vsc');
}

/* ══════════════════════════ STATUS / UI ════════════════════════════ */
function setStatus(type, label) {
  document.getElementById('status-dot').className  = `status-dot ${type}`;
  document.getElementById('status-text').textContent = label;
}

function showToast(msg, cls = 'toast-info') {
  const c  = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className   = `toast ${cls}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/* ══════════════════════════ DELAY UI ═══════════════════════════════ */
function updateDelayUI() {
  const queued    = messageQueue.length;
  const bufferEl  = document.getElementById('dc-buffer');
  const countEl   = document.getElementById('dc-buffer-count');
  const controlEl = document.getElementById('delay-control');

  if (delayMs > 0) {
    controlEl?.classList.add('active');
    if (bufferEl) {
      const show = queued > 0;
      bufferEl.classList.toggle('hidden', !show);
      if (show && countEl) countEl.textContent = queued;
    }
    setStatus('delayed', `+${delayMs / 1000}s delay`);
  } else {
    controlEl?.classList.remove('active');
    bufferEl?.classList.add('hidden');
  }
}

document.getElementById('delay-input')?.addEventListener('change', (e) => {
  const secs = Math.max(0, Math.min(120, parseInt(e.target.value, 10) || 0));
  e.target.value = secs;

  const wasDelayed = delayMs > 0;
  delayMs = secs * 1000;

  if (secs === 0 && wasDelayed) {
    // Flush all buffered messages immediately
    messageQueue.forEach(({ msg }) => applyMessage(msg));
    messageQueue = [];
    setTimeout(renderAll, 0);
    const isOpen = ws?.readyState === WebSocket.OPEN;
    setStatus(isOpen ? 'live' : 'offline', isOpen ? 'Live' : 'Disconnected');
  }

  updateDelayUI();
});

/* ══════════════════════════ BOOT ═══════════════════════════════════ */
document.getElementById('btn-refresh').style.display = 'none';
document.querySelector('.refresh-info').style.display = 'none';

document.getElementById('historical-banner-close')
  ?.addEventListener('click', hideHistoricalBanner);

connectWS();

// Fallback: fetch historical data if WebSocket hasn't delivered anything yet
setTimeout(async () => {
  if (Object.keys(state.DriverList).length > 0) return;
  try {
    const r = await fetch('http://localhost:8001/api/historical');
    if (!r.ok) return;
    const msg = await r.json();
    if (msg.type === 'historical') {
      processHistorical(msg.data);
      setTimeout(renderAll, 0);
    }
  } catch (e) {
    console.warn('Historical HTTP fetch failed:', e);
  }
}, 2000);
