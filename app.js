/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   F1 LIVE RACE DASHBOARD  —  app.js
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const WS_URL  = 'ws://localhost:8001/ws';
const API_URL = 'http://localhost:8001';
const TYRE_MAP = { SOFT:'S', MEDIUM:'M', HARD:'H', INTERMEDIATE:'I', WET:'W' };
const F1_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

/* â”€â”€ Global State â”€â”€ */
let state = {
  DriverList: {},
  TimingData: { Lines: {} },
  SessionInfo: {},
  RaceControlMessages: { Messages: [] },
  WeatherData: {},
  TrackStatus: { Message: '', Status: '1' },
  LapCount: {},
};

let ws = null;
let isHistorical = false;
let delayMs = 0;
let messageQueue = [];

/* â”€â”€ DOM diffing â”€â”€ */
const rowMap     = new Map();
const prevRowPos = new Map();
const initialPos = new Map();

/* â”€â”€ Championship â”€â”€ */
let champData    = null;
let champLoading = false;
let whatIfPositions = {};
const seenRCMessages = new Set();

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• HELPERS â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function deepMerge(target, source) {
  if (typeof source !== 'object' || source === null) return source;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
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
  } catch (e) { console.error('Decompress failed', e); return null; }
}

function flashCell(el, newText, flashCls = 'cell-flash') {
  if (!el) return false;
  const text = String(newText ?? '');
  if (el.textContent === text) return false;
  el.textContent = text;
  el.classList.remove('cell-flash', 'cell-flash-fastest', 'cell-flash-pb');
  void el.offsetWidth;
  el.classList.add(flashCls);
  return true;
}

function hexToRgb(hex) {
  const h = (hex || '888888').replace('#', '');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• WS CONNECTION â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function connectWS() {
  setStatus('idle', 'Connecting…');
  ws = new WebSocket(WS_URL);
  ws.onopen  = () => { if (!delayMs) setStatus('live', 'Live'); };
  ws.onclose = () => { setStatus('offline', 'Disconnected'); setTimeout(connectWS, 5000); };
  ws.onerror = (err) => console.error('WebSocket error:', err);
  ws.onmessage = (event) => {
    try { messageQueue.push({ msg: JSON.parse(event.data), ts: Date.now() }); }
    catch (e) { console.error('Parse error', e); }
  };
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• DELAY QUEUE â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• DATA PROCESSING â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
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
    } else { state[topic] = val; }
  }
}

function processFeed(dataList) {
  const topic = dataList[0];
  const payloadStr = dataList[1];
  if (!payloadStr) return;
  const payload = topic.endsWith('.z') ? decodeBase64Zlib(payloadStr) : JSON.parse(payloadStr);
  if (!payload) return;

  if (topic === 'RaceControlMessages') {
    if (payload?.Messages) {
      if (!state.RaceControlMessages.Messages) state.RaceControlMessages.Messages = [];
      state.RaceControlMessages.Messages.push(...payload.Messages);
      payload.Messages.forEach(m => showRCOverlay(m));
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

function showHistoricalBanner(label) {
  const b = document.getElementById('historical-banner');
  if (!b) return;
  document.getElementById('historical-banner-text').textContent = `No live session — showing ${label} results`;
  b.classList.remove('hidden');
}
function hideHistoricalBanner() {
  document.getElementById('historical-banner')?.classList.add('hidden');
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• RENDERING â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function renderAll() {
  renderHeader();
  renderStandings();
  renderRaceControl();
}

/* â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function renderHeader() {
  const sInfo = state.SessionInfo || {};
  document.getElementById('session-label').textContent =
    `${sInfo.Meeting?.Name || 'Grand Prix'}  ·  ${sInfo.Name || 'Session'}`;

  const lc = state.LapCount || {};
  if (lc.CurrentLap) document.getElementById('current-lap').textContent = lc.CurrentLap;
  document.getElementById('total-laps').textContent = lc.TotalLaps || '—';

  const w = state.WeatherData || {};
  if (Object.keys(w).length) {
    const isRain = w.Rainfall === '1' || w.Rainfall === true || w.Rainfall === 1;
    document.getElementById('ws-track').textContent = w.TrackTemp ? `${w.TrackTemp}°` : '—°';
    document.getElementById('ws-air').textContent   = w.AirTemp   ? `${w.AirTemp}°`   : '—°';
    document.getElementById('ws-hum').textContent   = w.Humidity  ? `${w.Humidity}%`  : '—%';
    document.getElementById('ws-wind').textContent  = w.WindSpeed ? `${w.WindSpeed} m/s` : '— m/s';
    const condEl = document.getElementById('ws-cond');
    condEl.textContent = isRain ? 'WET' : 'DRY';
    condEl.className   = `ws-val ws-cond ${isRain ? 'wet' : 'dry'}`;
  }

  const statusEl = document.getElementById('track-status-pill');
  const status   = state.TrackStatus?.Status;
  const msgMap   = { '1':'ALL CLEAR','2':'YELLOW','4':'SAFETY CAR','5':'RED FLAG','6':'VSC','7':'VSC ENDING' };
  const clsMap   = { '1':'ts-green','2':'ts-yellow','4':'ts-sc','5':'ts-red','6':'ts-vsc','7':'ts-vsc' };
  statusEl.textContent = state.TrackStatus?.Message || msgMap[status] || 'ALL CLEAR';
  statusEl.className   = `track-status-pill ${clsMap[status] || 'ts-green'}`;

  updateFlagStripe();
}

/* â”€â”€ Standings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function renderStandings() {
  const tbody       = document.getElementById('timing-body');
  const lines       = state.TimingData?.Lines || {};
  const driversInfo = state.DriverList || {};

  const positions = Object.keys(lines)
    .filter(k => lines[k]?.Position)
    .map(k => ({ num: k, data: lines[k] }))
    .sort((a, b) => parseInt(a.data.Position) - parseInt(b.data.Position));

  if (!positions.length) {
    tbody.innerHTML = `<tr><td colspan="15"><div class="empty-state"><span class="empty-icon">ðŸŽï¸</span>Waiting for timing data…</div></td></tr>`;
    rowMap.clear(); prevRowPos.clear(); initialPos.clear();
    return;
  }

  const totalLaps     = parseInt(state.LapCount?.TotalLaps) || 0;
  const activeDrivers = new Set();

  positions.forEach((item, idx) => {
    const dNum  = item.num;
    const dData = item.data;
    const info  = driversInfo[dNum] || {};
    activeDrivers.add(dNum);

    const pos      = dData.Position;
    const posClass = idx === 0 ? 'pos-1' : idx === 1 ? 'pos-2' : idx === 2 ? 'pos-3' : '';
    const color    = info.TeamColour ? `#${info.TeamColour}` : '#888888';
    const rgb      = hexToRgb(color);
    const acronym  = info.Tla || `#${dNum}`;
    const fullName = `${info.FirstName || ''} ${info.LastName || ''}`.trim() || `Driver #${dNum}`;

    if (!initialPos.has(dNum)) initialPos.set(dNum, parseInt(pos));

    // Fastest lap & pit flags
    const isFastestLap = dData.BestLapTime?.OverallFastest || dData.LastLapTime?.OverallFastest;
    const isInPit      = dData.InPit === true || dData.InPit === 'true';

    // Gap columns
    const leaderRaw  = idx === 0 ? 'LEADER' : (dData.GapToLeader || dData.TimeDiffToPositionAhead || '—');
    const intervalRaw = dData.Interval || dData.TimeDiffToPositionAhead || (idx === 0 ? '—' : '—');
    const gapVal = String(leaderRaw);
    let leaderCls = 'td-gap';
    if (idx === 0)                                                                    leaderCls += ' is-leader';
    else if (gapVal.includes('LAP'))                                                  leaderCls += ' lapped';
    else if (['DNF','DNS','DSQ','Ret','Accident','Collision'].some(s=>gapVal.includes(s))) leaderCls += ' dnf';
    const intCls = idx === 0 ? 'td-gap is-interval-leader' : 'td-gap';

    // Lap times
    const lastLap        = dData.LastLapTime?.Value || '—';
    const overallFastest = dData.LastLapTime?.OverallFastest;
    const personalBest   = dData.LastLapTime?.PersonalFastest;
    const lapFlashCls    = overallFastest ? 'cell-flash-fastest' : personalBest ? 'cell-flash-pb' : 'cell-flash';
    const lapCls         = 'td-lap' + (overallFastest ? ' fastest' : personalBest ? ' personal-best' : '');

    const bestLap     = dData.BestLapTime?.Value || '—';
    const bestFastest = dData.BestLapTime?.OverallFastest;
    const bestLapCls  = 'td-bestlap' + (bestFastest ? ' fastest' : '');

    // Tyre
    let tyreLetter = '';
    if (dData.Stints?.length) {
      const stint = dData.Stints[dData.Stints.length - 1];
      if (stint?.Compound) tyreLetter = TYRE_MAP[stint.Compound.toUpperCase()] || stint.Compound[0];
    }

    // Tyre history HTML
    const tyreHistHTML = buildTyreHistory(dData.Stints || []);

    // Sectors
    const s1 = dData.LastSectors?.[0]?.Value || dData.Sectors?.[0]?.Value || '—';
    const s2 = dData.LastSectors?.[1]?.Value || dData.Sectors?.[1]?.Value || '—';
    const s3 = dData.LastSectors?.[2]?.Value || dData.Sectors?.[2]?.Value || '—';
    const bs1 = dData.BestSectors?.[0];
    const bs2 = dData.BestSectors?.[1];
    const bs3 = dData.BestSectors?.[2];
    const s1Cls = 'td-sector' + (bs1?.OverallFastest ? ' s-purple' : personalBest ? ' s-green' : ' s-white');
    const s2Cls = 'td-sector' + (bs2?.OverallFastest ? ' s-purple' : personalBest ? ' s-green' : ' s-white');
    const s3Cls = 'td-sector' + (bs3?.OverallFastest ? ' s-purple' : personalBest ? ' s-green' : ' s-white');

    const spd      = dData.Speeds?.FL?.Value || dData.TopSpeed || '—';
    const pitCount = dData.NumberOfPitStops != null ? dData.NumberOfPitStops
                   : dData.Stints ? Math.max(0, dData.Stints.length - 1) : 0;
    const pitCls   = pitCount > 0 ? 'td-pit has-pits' : 'td-pit';
    const lapsNum  = parseInt(dData.NumberOfLaps) || 0;

    let lapPct = '0%';
    if (totalLaps > 0 && lapsNum > 0) lapPct = `${Math.min(100, (lapsNum / totalLaps) * 100).toFixed(1)}%`;

    const initP    = initialPos.get(dNum) || parseInt(pos);
    const delta    = initP - parseInt(pos);
    let deltaTxt   = '—';
    let deltaCls   = 'td-delta same';
    if (delta > 0) { deltaTxt = `▲${delta}`; deltaCls = 'td-delta gained'; }
    if (delta < 0) { deltaTxt = `▼${Math.abs(delta)}`; deltaCls = 'td-delta lost'; }

    // Build driver cell top row: acronym + fastest lap icon + pit icon
    const flIcon  = isFastestLap ? '<span class="driver-fl-icon" title="Fastest Lap">⚡</span>' : '';
    const pitIcon = isInPit      ? '<span class="driver-pit-icon" title="In Pit">ðŸ”§</span>' : '';
    const driverTopHTML = `<span class="driver-acronym">${acronym}</span>${flIcon}${pitIcon}`;

    const isNew = !rowMap.has(dNum);
    let tr;

    if (isNew) {
      tr = document.createElement('tr');
      tr.className = `timing-row ${posClass}`;
      tr.dataset.dnum = dNum;
      tr.innerHTML = `
        <td class="tc-pos"><div class="tc-pos-wrap"><span class="tc-pos-num">${pos}</span></div></td>
        <td class="tc-driver">
          <div class="driver-cell" onclick="selectDriverForH2H('${dNum}')">
            <div class="driver-color-bar" style="background:${color}"></div>
            <div class="driver-info">
              <div class="driver-top">${driverTopHTML}</div>
              <span class="driver-name">${fullName}</span>
            </div>
          </div>
        </td>
        <td class="${intCls} td-gap-int">${idx === 0 ? '—' : intervalRaw}</td>
        <td class="${leaderCls} td-gap-leader">${leaderRaw}</td>
        <td class="tc-laps">${lapsNum || '—'}</td>
        <td class="tc-tyre"><span class="tyre-badge tyre-${tyreLetter}">${tyreLetter || '?'}</span></td>
        <td class="tc-hist"><div class="tyre-hist-row">${tyreHistHTML}</div></td>
        <td class="${lapCls} td-lastlap">${lastLap}</td>
        <td class="${bestLapCls} td-bestlap">${bestLap}</td>
        <td class="${pitCls} td-pit-count">${pitCount || '—'}</td>
        <td class="${s1Cls} td-s1">${s1}</td>
        <td class="${s2Cls} td-s2">${s2}</td>
        <td class="${s3Cls} td-s3">${s3}</td>
        <td class="td-spd tc-spd">${spd}</td>
        <td class="${deltaCls} td-delta-cell">${deltaTxt}</td>
      `;
      tr.classList.add('row-entering');
      tr.addEventListener('animationend', () => tr.classList.remove('row-entering'), { once: true });
      rowMap.set(dNum, tr);
    } else {
      tr = rowMap.get(dNum);
      tr.dataset.dnum = dNum;
      if (!tr.classList.contains('row-entering')) tr.className = `timing-row ${posClass}`;

      flashCell(tr.querySelector('.tc-pos-num'), pos);

      // Update driver top (icons may change)
      const topEl = tr.querySelector('.driver-top');
      if (topEl) topEl.innerHTML = driverTopHTML;

      const intCell = tr.querySelector('.td-gap-int');
      if (intCell) { intCell.className = `${intCls} td-gap-int`; flashCell(intCell, idx === 0 ? '—' : intervalRaw); }

      const ldrCell = tr.querySelector('.td-gap-leader');
      if (ldrCell) { ldrCell.className = `${leaderCls} td-gap-leader`; flashCell(ldrCell, leaderRaw); }

      flashCell(tr.querySelector('.tc-laps'), lapsNum || '—');

      const tyreBadge = tr.querySelector('.tyre-badge');
      if (tyreBadge && tyreBadge.textContent !== (tyreLetter || '?')) {
        tyreBadge.className = `tyre-badge tyre-${tyreLetter}`;
        tyreBadge.textContent = tyreLetter || '?';
      }

      const histEl = tr.querySelector('.tyre-hist-row');
      if (histEl) histEl.innerHTML = tyreHistHTML;

      const lastLapCell = tr.querySelector('.td-lastlap');
      if (lastLapCell) { lastLapCell.className = `${lapCls} td-lastlap`; flashCell(lastLapCell, lastLap, lapFlashCls); }
      const bestLapCell = tr.querySelector('.td-bestlap');
      if (bestLapCell) { bestLapCell.className = `${bestLapCls} td-bestlap`; flashCell(bestLapCell, bestLap); }

      const pitCell = tr.querySelector('.td-pit-count');
      if (pitCell) { pitCell.className = `${pitCls} td-pit-count`; flashCell(pitCell, pitCount || '—'); }

      const s1c = tr.querySelector('.td-s1');
      const s2c = tr.querySelector('.td-s2');
      const s3c = tr.querySelector('.td-s3');
      if (s1c) { s1c.className = `${s1Cls} td-s1`; flashCell(s1c, s1); }
      if (s2c) { s2c.className = `${s2Cls} td-s2`; flashCell(s2c, s2); }
      if (s3c) { s3c.className = `${s3Cls} td-s3`; flashCell(s3c, s3); }

      flashCell(tr.querySelector('.tc-spd'), spd);

      const deltaCell = tr.querySelector('.td-delta-cell');
      if (deltaCell) { deltaCell.className = `${deltaCls} td-delta-cell`; deltaCell.textContent = deltaTxt; }

      const prevP = prevRowPos.get(dNum);
      if (prevP && prevP !== pos) {
        tr.classList.remove('row-moved'); void tr.offsetWidth; tr.classList.add('row-moved');
      }
    }

    tr.style.setProperty('--team-r', rgb.r);
    tr.style.setProperty('--team-g', rgb.g);
    tr.style.setProperty('--team-b', rgb.b);
    tr.style.setProperty('--lap-pct', lapPct);

    prevRowPos.set(dNum, pos);
    tbody.appendChild(tr);
  });

  for (const [dNum, tr] of rowMap) {
    if (!activeDrivers.has(dNum)) { tr.remove(); rowMap.delete(dNum); prevRowPos.delete(dNum); }
  }
}

/* Build tyre history HTML — dots with visible lap counts */
function buildTyreHistory(stints) {
  if (!stints || !stints.length) return '<span style="color:var(--text-3);font-size:9px">—</span>';

  return stints.map((s, i) => {
    const c      = s.Compound || '';
    const letter = TYRE_MAP[c.toUpperCase()] || c[0] || '?';
    const isCurrent = i === stints.length - 1;

    // Calculate laps on this stint
    let lapsStr = '';
    if (s.LapEnd && s.LapStart) {
      lapsStr = String(s.LapEnd - s.LapStart + 1);
    } else if (s.TotalLaps) {
      lapsStr = String(s.TotalLaps);
    }

    const arrow = i < stints.length - 1 ? '<span class="th-arrow">›</span>' : '';
    return `<span class="th-stint">
      <span class="th-dot th-${letter}${isCurrent ? ' th-current' : ''}" title="${c}">${letter}</span>
      ${lapsStr ? `<span class="th-laps-label">${lapsStr}</span>` : ''}
    </span>${arrow}`;
  }).join('');
}

/* â”€â”€ Race Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
let rcFilter = 'all';
document.querySelectorAll('.rc-filter-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rc-filter-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    rcFilter = btn.dataset.filter;
    renderRaceControl();
  });
});

function renderRaceControl() {
  const list    = document.getElementById('rc-list');
  const countEl = document.getElementById('rc-count');
  if (!list) return;

  const messages = state.RaceControlMessages?.Messages || [];
  if (countEl) countEl.textContent = `${messages.length} messages`;

  if (!messages.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">🚩</span>No messages yet</div>`;
    return;
  }

  const filtered = rcFilter === 'all' ? messages : messages.filter(msg => {
    const f = (msg.Flag || msg.Category || msg.Message || '').toLowerCase();
    if (rcFilter === 'safety') return f.includes('safety') || f.includes('sc') || f.includes('virtual');
    if (rcFilter === 'flag') return f.includes('yellow') || f.includes('red') || f.includes('green') || f.includes('chequered');
    if (rcFilter === 'drs') return f.includes('drs');
    if (rcFilter === 'penalty') return f.includes('penalty') || f.includes('investigation') || f.includes('steward') || f.includes('time');
    return true;
  });
  const displayMsgs = [...filtered].reverse().slice(0, 30);
  list.innerHTML = '';
  displayMsgs.forEach(msg => {
    const flag = (msg.Flag || msg.Category || '').toLowerCase();
    let flagCls = 'flag-other';
    if (flag.includes('green') || flag.includes('clear'))       flagCls = 'flag-green';
    else if (flag.includes('yellow') || flag.includes('safety')) flagCls = 'flag-yellow';
    else if (flag.includes('red'))                               flagCls = 'flag-red';
    else if (flag.includes('drs'))                               flagCls = 'flag-drs';

    const timeStr = msg.Utc ? new Date(msg.Utc).toLocaleTimeString() : '—';
    const el = document.createElement('div');
    el.className = `rc-item ${flagCls}`;
    el.innerHTML = `<span class="rc-time">${timeStr}</span><span class="rc-msg">${msg.Message || '—'}</span>`;
    list.appendChild(el);
  });
}

/* â”€â”€ Flag Stripe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function updateFlagStripe() {
  const stripe = document.getElementById('flag-stripe');
  stripe.className = 'flag-stripe';
  const status = state.TrackStatus?.Status;
  if      (status === '1')                   stripe.classList.add('green-flag');
  else if (status === '2')                   stripe.classList.add('yellow-flag');
  else if (status === '4')                   stripe.classList.add('sc');
  else if (status === '5')                   stripe.classList.add('red-flag');
  else if (status === '6' || status === '7') stripe.classList.add('vsc');
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• RC OVERLAY â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function showRCOverlay(msg) {
  const key = msg.Utc + (msg.Message || '');
  if (seenRCMessages.has(key)) return;
  seenRCMessages.add(key);
  sendRCNotification(msg);

  const container = document.getElementById('rc-overlay-container');
  const flag = (msg.Flag || msg.Category || '').toLowerCase();
  let flagCls = 'rco-other', catLabel = 'RACE CONTROL';
  if (flag.includes('green') || flag.includes('clear'))       { flagCls = 'rco-green';  catLabel = 'GREEN FLAG'; }
  else if (flag.includes('yellow') || flag.includes('safety')) { flagCls = 'rco-yellow'; catLabel = 'YELLOW FLAG'; }
  else if (flag.includes('red'))                               { flagCls = 'rco-red';    catLabel = 'RED FLAG'; }
  else if (flag.includes('drs'))                               { flagCls = 'rco-drs';    catLabel = 'DRS'; }

  const duration = 9000;
  const el = document.createElement('div');
  el.className = `rco-item ${flagCls}`;
  el.innerHTML = `
    <div class="rco-inner">
      <div class="rco-cat">${catLabel}</div>
      <div class="rco-msg">${msg.Message || '—'}</div>
    </div>
    <div class="rco-progress-bar">
      <div class="rco-progress-fill" style="animation-duration:${duration}ms"></div>
    </div>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('rco-exiting');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• STATUS / UI â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function setStatus(type, label) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  if (dot) dot.className   = `status-dot ${type}`;
  if (txt) txt.textContent = label;
}

function showToast(msg, cls = 'toast-info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${cls}`; el.textContent = msg;
  c.appendChild(el); setTimeout(() => el.remove(), 4500);
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• DELAY UI â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function updateDelayUI() {
  const queued    = messageQueue.length;
  const bufferEl  = document.getElementById('dc-buffer');
  const countEl   = document.getElementById('dc-buffer-count');
  const controlEl = document.getElementById('delay-control');
  if (delayMs > 0) {
    controlEl?.classList.add('active');
    if (bufferEl) { bufferEl.classList.toggle('hidden', queued === 0); if (queued && countEl) countEl.textContent = queued; }
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
    messageQueue.forEach(({ msg }) => applyMessage(msg));
    messageQueue = [];
    setTimeout(renderAll, 0);
    const isOpen = ws?.readyState === WebSocket.OPEN;
    setStatus(isOpen ? 'live' : 'offline', isOpen ? 'Live' : 'Disconnected');
  }
  updateDelayUI();
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• TABS â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
    if (btn.dataset.tab === 'championship') loadChampionship();
    if (btn.dataset.tab === 'schedule')     loadSchedule();
    pushHash(btn.dataset.tab);
  });
});

document.querySelectorAll('.sub-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sub-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`sub-${btn.dataset.sub}`)?.classList.add('active');
  });
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• CHAMPIONSHIP â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function loadChampionship() {
  if (champData || champLoading) { if (champData) renderChampionship(); return; }
  champLoading = true;
  fetchChampionship();
}
function fetchChampionship() {
  fetch(`${API_URL}/api/championship`)
    .then(r => { if (r.status === 202) { setTimeout(fetchChampionship, 3000); return null; } return r.json(); })
    .then(data => { if (!data) return; champLoading = false; champData = data; renderChampionship(); })
    .catch(err => {
      console.warn('Championship fetch error:', err);
      champLoading = false;
      const el = document.getElementById('champ-loading');
      if (el) el.innerHTML = '<span style="color:var(--red);font-size:11px">Failed to load championship data</span>';
    });
}
function renderChampionship() {
  if (!champData) return;
  const loadingEl = document.getElementById('champ-loading');
  if (loadingEl) loadingEl.style.display = 'none';
  document.getElementById('champ-drivers-wrap')?.classList.remove('hidden');
  renderDriverChamp();
  renderTeamChamp();
}
function renderDriverChamp() {
  if (!champData) return;
  const tbody = document.getElementById('champ-drivers-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const allSimTotals = (champData.drivers || []).map((d, i) => {
    const sp = whatIfPositions[d.name] ?? d.last_pos ?? (i + 1);
    return d.prior_pts + (sp >= 1 && sp <= 10 ? F1_POINTS[sp - 1] : 0);
  });
  const leaderSimTotal = Math.max(...allSimTotals, 0);

  (champData.drivers || []).forEach((d, i) => {
    const simPos     = whatIfPositions[d.name] ?? d.last_pos ?? (i + 1);
    const simPts     = simPos >= 1 && simPos <= 10 ? F1_POINTS[simPos - 1] : 0;
    const simTotal   = d.prior_pts + simPts;
    const gapToLead  = leaderSimTotal - simTotal;
    const delta      = simTotal - d.points;
    const deltaStr   = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '—';
    const deltaCls   = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'zero';
    const colour     = d.colour ? `#${d.colour.replace('#','')}` : '#888';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="champ-pos-num">${i + 1}</span></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:3px;height:16px;border-radius:2px;background:${colour};flex-shrink:0"></div>
          <div><div class="champ-tla">${d.tla || d.name.split(' ').pop()}</div><div class="champ-name">${d.name}</div></div>
        </div>
      </td>
      <td style="color:var(--text-3);font-size:10px">${d.team}</td>
      <td><span class="champ-pts">${d.points}</span></td>
      <td><span class="champ-gap${gapToLead === 0 ? ' champ-gap-leader' : ''}">${gapToLead === 0 ? 'LEADER' : '-' + gapToLead}</span></td>
      <td>
        <div class="sim-pos-ctrl">
          <button class="pos-adj-btn" onclick="adjustWhatIf('${d.name}',-1)">▲</button>
          <span class="sim-pos-val">${simPos}</span>
          <button class="pos-adj-btn" onclick="adjustWhatIf('${d.name}',1)">▼</button>
        </div>
      </td>
      <td><span class="champ-simtotal">${simTotal}</span></td>
      <td><span class="champ-delta ${deltaCls}">${deltaStr}</span></td>
    `;
    tbody.appendChild(tr);
  });
}
function renderTeamChamp() {
  if (!champData) return;
  const tbody = document.getElementById('champ-teams-body');
  if (!tbody) return;
  const drivers = champData.drivers || [];
  const teams   = champData.teams   || [];
  const teamSimMap = {}, teamBaseMap = {};
  teams.forEach(t => { teamSimMap[t.name] = 0; teamBaseMap[t.name] = t.points; });
  drivers.forEach(d => {
    if (!teamSimMap.hasOwnProperty(d.team)) { teamSimMap[d.team] = 0; }
    const simPos = whatIfPositions[d.name] ?? d.last_pos ?? 21;
    const simPts = simPos >= 1 && simPos <= 10 ? F1_POINTS[simPos - 1] : 0;
    teamSimMap[d.team] += d.prior_pts + simPts;
  });
  tbody.innerHTML = '';
  teams.forEach((t, i) => {
    const simTotal = teamSimMap[t.name] ?? t.points;
    const delta    = simTotal - t.points;
    const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '—';
    const deltaCls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'zero';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="champ-pos-num">${i + 1}</span></td>
      <td style="color:var(--text-1);font-weight:600">${t.name}</td>
      <td><span class="champ-pts">${t.points}</span></td>
      <td><span class="champ-simtotal">${simTotal}</span></td>
      <td><span class="champ-delta ${deltaCls}">${deltaStr}</span></td>
    `;
    tbody.appendChild(tr);
  });
}
function adjustWhatIf(name, dir) {
  const drivers = champData?.drivers || [];
  if (!drivers.length) return;

  // Resolve every driver's current effective sim position
  const effective = {};
  drivers.forEach((d, i) => {
    effective[d.name] = whatIfPositions[d.name] ?? d.last_pos ?? (i + 1);
  });

  const currentPos = effective[name];
  const newPos = Math.max(1, Math.min(drivers.length, currentPos + dir));
  if (newPos === currentPos) return;

  // Swap with whoever occupies the target slot
  const swapped = drivers.find(d => d.name !== name && effective[d.name] === newPos);
  whatIfPositions[name] = newPos;
  if (swapped) whatIfPositions[swapped.name] = currentPos;

  renderDriverChamp(); renderTeamChamp();
}
document.getElementById('wif-reset')?.addEventListener('click', () => { whatIfPositions = {}; renderDriverChamp(); renderTeamChamp(); });

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SCHEDULE â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* Fetch circuit map — tries Wikipedia pageimages first, falls back to Wikimedia Commons */
async function fetchWikiImage(title, commonsFile) {
  if (title) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&format=json&pithumbsize=900&origin=*`;
      const r = await fetch(url);
      const data = await r.json();
      const page = Object.values(data?.query?.pages || {})[0];
      const src = page?.thumbnail?.source;
      if (src) return src;
    } catch {}
  }
  if (commonsFile) {
    try {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(commonsFile)}&prop=imageinfo&iiprop=url&iiurlwidth=900&format=json&origin=*`;
      const r = await fetch(url);
      const data = await r.json();
      const page = Object.values(data?.query?.pages || {})[0];
      return page?.imageinfo?.[0]?.thumburl || null;
    } catch {}
  }
  return null;
}

const CIRCUIT_DB = {
  'Sakhir': {
    fullName: 'Bahrain International Circuit', location: 'Sakhir, Bahrain',
    length: 5.412, corners: 15, drs: 3,
    lapRecord: { time: '1:31.447', driver: 'Pedro de la Rosa', year: 2005 },
    wikiTitle: 'Bahrain International Circuit',
    f1ImageName: 'sakhir',
    firstGp: 2004,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Hidd / Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Luff / Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},
    ],
  },
  'Jeddah': {
    fullName: 'Jeddah Corniche Circuit', location: 'Jeddah, Saudi Arabia',
    length: 6.174, corners: 27, drs: 3,
    lapRecord: { time: '1:30.734', driver: 'Lewis Hamilton', year: 2021 },
    wikiTitle: 'Jeddah Corniche Circuit',
    f1ImageName: 'jeddah',
    firstGp: 2021,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:7,name:'Turn 7'},{n:12,name:'Turn 12'},{n:13,name:'Turn 13'},{n:14,name:'Turn 14'},
      {n:20,name:'Turn 20'},{n:22,name:'Turn 22'},{n:25,name:'Turn 25'},{n:27,name:'Turn 27'},
    ],
  },
  'Melbourne': {
    fullName: 'Albert Park Circuit', location: 'Melbourne, Australia',
    length: 5.278, corners: 16, drs: 4,
    lapRecord: { time: '1:20.235', driver: 'Charles Leclerc', year: 2022 },
    wikiTitle: 'Albert Park Circuit',
    f1ImageName: 'melbourne',
    firstGp: 1996,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:9,name:'Turn 9'},{n:11,name:'Turn 11'},
      {n:12,name:'Turn 12'},{n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},
      {n:16,name:'Turn 16'},
    ],
  },
  'Suzuka': {
    fullName: 'Suzuka International Racing Course', location: 'Suzuka, Japan',
    length: 5.807, corners: 18, drs: 2,
    lapRecord: { time: '1:30.983', driver: 'Lewis Hamilton', year: 2019 },
    wikiTitle: 'Suzuka International Racing Course',
    f1ImageName: 'suzuka',
    firstGp: 1987,
    commonsFile: 'File:Suzuka Circuit 2013 001.svg',
    turns: [
      {n:1,name:'First Curve'},{n:2,name:'Second Curve'},{n:3,name:'Third Curve (S Curves)'},
      {n:4,name:'S Curves'},{n:7,name:'Dunlop'},{n:9,name:'Degner 1'},{n:10,name:'Degner 2'},
      {n:11,name:'Hairpin'},{n:13,name:'Spoon Curve'},{n:14,name:'Spoon Curve'},
      {n:15,name:'130R'},{n:16,name:'Casio Triangle (Chicane)'},{n:17,name:'Chicane'},
      {n:18,name:'Final Corner'},
    ],
  },
  'Shanghai': {
    fullName: 'Shanghai International Circuit', location: 'Shanghai, China',
    length: 5.451, corners: 16, drs: 2,
    lapRecord: { time: '1:32.238', driver: 'Michael Schumacher', year: 2004 },
    wikiTitle: 'Shanghai International Circuit',
    f1ImageName: 'shanghai',
    firstGp: 2004,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
    ],
  },
  'Miami': {
    fullName: 'Miami International Autodrome', location: 'Miami Gardens, Florida, USA',
    length: 5.412, corners: 19, drs: 3,
    lapRecord: { time: '1:29.708', driver: 'Max Verstappen', year: 2023 },
    wikiTitle: 'Miami International Autodrome',
    f1ImageName: 'miami',
    firstGp: 2022,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9 (Hairpin)'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},
      {n:12,name:'Turn 12'},{n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},
      {n:16,name:'Turn 16'},{n:17,name:'Turn 17'},{n:18,name:'Turn 18'},{n:19,name:'Turn 19'},
    ],
  },
  'Imola': {
    fullName: 'Autodromo Enzo e Dino Ferrari', location: 'Imola, Italy',
    length: 4.909, corners: 19, drs: 2,
    lapRecord: { time: '1:15.484', driver: 'Valtteri Bottas', year: 2020 },
    wikiTitle: 'Autodromo Enzo e Dino Ferrari',
    f1ImageName: 'imola',
    firstGp: 1981,
    turns: [
      {n:1,name:'Variante Tamburello'},{n:2,name:'Tamburello'},{n:3,name:'Villeneuve'},
      {n:4,name:'Tosa'},{n:5,name:'Piratella'},{n:6,name:'Acque Minerali'},
      {n:7,name:'Variante Alta'},{n:8,name:'Rivazza 1'},{n:9,name:'Rivazza 2'},
      {n:15,name:'Variante Bassa'},{n:17,name:'Traguardo'},
    ],
  },
  'Monte Carlo': {
    fullName: 'Circuit de Monaco', location: 'Monte Carlo, Monaco',
    length: 3.337, corners: 19, drs: 1,
    lapRecord: { time: '1:12.909', driver: 'Lewis Hamilton', year: 2021 },
    wikiTitle: 'Circuit de Monaco',
    f1ImageName: 'montecarlo',
    firstGp: 1950,
    turns: [
      {n:1,name:'Sainte Devote'},{n:3,name:'Beau Rivage'},{n:5,name:'Massenet'},
      {n:6,name:'Casino Square'},{n:7,name:'Mirabeau Haute'},{n:8,name:'Mirabeau Bas'},
      {n:9,name:'Grand Hotel Hairpin'},{n:10,name:'Portier'},{n:12,name:'Tunnel'},
      {n:13,name:'Nouvelle Chicane'},{n:15,name:'Tabac'},{n:16,name:'Piscine (Swimming Pool)'},
      {n:17,name:'Piscine 2'},{n:18,name:'La Rascasse'},{n:19,name:'Anthony Noghes'},
    ],
  },
  'Montreal': {
    fullName: 'Circuit Gilles Villeneuve', location: 'Montréal, Canada',
    length: 4.361, corners: 14, drs: 3,
    lapRecord: { time: '1:13.078', driver: 'Valtteri Bottas', year: 2019 },
    wikiTitle: 'Circuit Gilles Villeneuve',
    f1ImageName: 'montreal',
    firstGp: 1978,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3 – Epingle / Senna Curve'},
      {n:4,name:'Turn 4'},{n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},
      {n:8,name:'Turn 8'},{n:9,name:'Turn 9'},{n:10,name:'Turn 10'},
      {n:13,name:'Wall of Champions (Chicane)'},{n:14,name:'Pits Hairpin'},
    ],
  },
  'Catalunya': {
    fullName: 'Circuit de Barcelona-Catalunya', location: 'Montmeló, Spain',
    length: 4.657, corners: 16, drs: 2,
    lapRecord: { time: '1:18.149', driver: 'Max Verstappen', year: 2021 },
    wikiTitle: 'Circuit de Barcelona-Catalunya',
    f1ImageName: 'catalunya',
    firstGp: 1991,
    turns: [
      {n:1,name:'Elf'},{n:2,name:'Renault'},{n:3,name:'Repsol'},{n:4,name:'Würth'},
      {n:5,name:'Seat'},{n:6,name:'Turn 6'},{n:7,name:'Campsa'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'La Caixa'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'New Holland'},{n:14,name:'Banc Sabadell'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
    ],
  },
  'Spielberg': {
    fullName: 'Red Bull Ring', location: 'Spielberg, Austria',
    length: 4.318, corners: 10, drs: 3,
    lapRecord: { time: '1:05.619', driver: 'Carlos Sainz', year: 2020 },
    wikiTitle: 'Red Bull Ring',
    f1ImageName: 'spielberg',
    firstGp: 1970,
    turns: [
      {n:1,name:'Castrol Edge'},{n:2,name:'Remus'},{n:3,name:'Schlossgold'},
      {n:4,name:'Turn 4'},{n:5,name:'Rauch'},{n:6,name:'Turn 6'},
      {n:7,name:'Rindt'},{n:8,name:'Motul'},{n:9,name:'Kieser'},{n:10,name:'Weichenbach'},
    ],
  },
  'Silverstone': {
    fullName: 'Silverstone Circuit', location: 'Silverstone, Great Britain',
    length: 5.891, corners: 18, drs: 2,
    lapRecord: { time: '1:27.097', driver: 'Max Verstappen', year: 2020 },
    wikiTitle: 'Silverstone Circuit',
    f1ImageName: 'silverstone',
    firstGp: 1950,
    turns: [
      {n:1,name:'Abbey'},{n:2,name:'Farm'},{n:3,name:'Village'},{n:4,name:'The Loop'},
      {n:5,name:'Aintree'},{n:6,name:'Wellington Straight'},{n:7,name:'Brooklands'},
      {n:8,name:'Luffield'},{n:9,name:'Woodcote'},{n:10,name:'Copse'},
      {n:11,name:'Maggotts'},{n:12,name:'Becketts'},{n:13,name:'Chapel'},
      {n:14,name:'Hangar Straight'},{n:15,name:'Stowe'},{n:16,name:'Vale'},
      {n:17,name:'Club'},{n:18,name:'Abbey'},
    ],
  },
  'Hungaroring': {
    fullName: 'Hungaroring', location: 'Budapest, Hungary',
    length: 4.381, corners: 14, drs: 2,
    lapRecord: { time: '1:16.627', driver: 'Lewis Hamilton', year: 2020 },
    wikiTitle: 'Hungaroring',
    f1ImageName: 'hungaroring',
    firstGp: 1986,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},
    ],
  },
  'Spa-Francorchamps': {
    fullName: 'Circuit de Spa-Francorchamps', location: 'Stavelot, Belgium',
    length: 7.004, corners: 19, drs: 2,
    lapRecord: { time: '1:46.286', driver: 'Valtteri Bottas', year: 2018 },
    wikiTitle: 'Circuit de Spa-Francorchamps',
    f1ImageName: 'spafrancorchamps',
    firstGp: 1950,
    turns: [
      {n:1,name:'La Source'},{n:2,name:'Eau Rouge'},{n:3,name:'Raidillon'},
      {n:4,name:'Kemmel Straight'},{n:5,name:'Les Combes'},{n:6,name:'Malmedy'},
      {n:7,name:'Bruxelles'},{n:8,name:'Rivage'},{n:9,name:'Paul Frère / Double Gauche'},
      {n:10,name:'Pouhon'},{n:11,name:'Campus'},{n:12,name:'Fagnes'},
      {n:13,name:'Stavelot'},{n:14,name:'Courbe de Paul Frère'},{n:16,name:'Blanchimont'},
      {n:17,name:'Bus Stop Chicane'},{n:18,name:'Bus Stop Chicane'},
    ],
  },
  'Zandvoort': {
    fullName: 'Circuit Zandvoort', location: 'Zandvoort, Netherlands',
    length: 4.259, corners: 14, drs: 2,
    lapRecord: { time: '1:11.097', driver: 'Lewis Hamilton', year: 2021 },
    wikiTitle: 'Circuit Zandvoort',
    f1ImageName: 'zandvoort',
    firstGp: 1952,
    turns: [
      {n:1,name:'Tarzanbocht'},{n:2,name:'Gerlachbocht'},{n:3,name:'Hugenholzbocht'},
      {n:4,name:'Tunnel Oost'},{n:5,name:'Tunnel West'},{n:7,name:'Scheivlak'},
      {n:9,name:'Mastersbocht'},{n:10,name:'Kumhobocht'},{n:11,name:'Arie Luyendijkbocht'},
      {n:12,name:'Rob Slotemakersbocht'},{n:13,name:'Vodafone Audi Duinbocht'},{n:14,name:'Hans Ernst Chicane'},
    ],
  },
  'Monza': {
    fullName: 'Autodromo Nazionale Monza', location: 'Monza, Italy',
    length: 5.793, corners: 11, drs: 3,
    lapRecord: { time: '1:21.046', driver: 'Rubens Barrichello', year: 2004 },
    wikiTitle: 'Autodromo Nazionale Monza',
    f1ImageName: 'monza',
    firstGp: 1950,
    commonsFile: 'File:Monza track map.svg',
    turns: [
      {n:1,name:'Variante del Rettifilo (Prima)'},{n:2,name:'Variante del Rettifilo (Seconda)'},
      {n:3,name:'Curva Grande'},{n:4,name:'Variante della Roggia (1)'},
      {n:5,name:'Variante della Roggia (2)'},{n:6,name:'Lesmo 1'},{n:7,name:'Lesmo 2'},
      {n:8,name:'Variante Ascari (1)'},{n:9,name:'Variante Ascari (2)'},
      {n:10,name:'Variante Ascari (3)'},{n:11,name:'Curva Alboreto (Parabolica)'},
    ],
  },
  'Baku': {
    fullName: 'Baku City Circuit', location: 'Baku, Azerbaijan',
    length: 6.003, corners: 20, drs: 2,
    lapRecord: { time: '1:43.009', driver: 'Charles Leclerc', year: 2019 },
    wikiTitle: 'Baku City Circuit',
    f1ImageName: 'baku',
    firstGp: 2016,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3 / Uphill'},
      {n:4,name:'Castle Section'},{n:5,name:'Castle Corner'},{n:8,name:'Turn 8'},
      {n:10,name:'Turn 10'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
      {n:17,name:'Harbour Straight'},{n:18,name:'Turn 18'},{n:19,name:'Turn 19'},{n:20,name:'Turn 20'},
    ],
  },
  'Singapore': {
    fullName: 'Marina Bay Street Circuit', location: 'Singapore',
    length: 4.940, corners: 23, drs: 3,
    lapRecord: { time: '1:35.867', driver: 'Kevin Magnussen', year: 2018 },
    wikiTitle: 'Marina Bay Street Circuit',
    f1ImageName: 'singapore',
    firstGp: 2008,
    turns: [
      {n:1,name:'Turn 1'},{n:3,name:'Turn 3'},{n:5,name:'Anderson Bridge'},
      {n:7,name:'Esplanade Underpass'},{n:8,name:'Esplanade Corner'},{n:10,name:'Turn 10'},
      {n:11,name:'Turn 11'},{n:13,name:'Turn 13'},{n:14,name:'Stamford Hairpin'},
      {n:18,name:'Turn 18'},{n:20,name:'St Andrew\'s Road'},{n:23,name:'Turn 23'},
    ],
  },
  'Austin': {
    fullName: 'Circuit of the Americas', location: 'Austin, Texas, USA',
    length: 5.513, corners: 20, drs: 2,
    lapRecord: { time: '1:36.169', driver: 'Charles Leclerc', year: 2019 },
    wikiTitle: 'Circuit of the Americas',
    f1ImageName: 'austin',
    firstGp: 2012,
    turns: [
      {n:1,name:'Turn 1 (Uphill)'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},
      {n:4,name:'Turn 4'},{n:5,name:'Turn 5'},{n:6,name:'Turn 6'},
      {n:7,name:'Turn 7'},{n:8,name:'Turn 8'},{n:9,name:'Turn 9 (Hairpin)'},
      {n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},
      {n:16,name:'Turn 16'},{n:17,name:'Turn 17'},{n:18,name:'Turn 18'},
      {n:19,name:'Turn 19'},{n:20,name:'Turn 20'},
    ],
  },
  'Mexico City': {
    fullName: 'Autodromo Hermanos Rodriguez', location: 'Mexico City, Mexico',
    length: 4.304, corners: 17, drs: 3,
    lapRecord: { time: '1:17.774', driver: 'Valtteri Bottas', year: 2021 },
    wikiTitle: 'Autodromo Hermanos Rodriguez',
    f1ImageName: 'mexicocity',
    firstGp: 1963,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Esses'},
      {n:4,name:'Esses'},{n:5,name:'Esses'},{n:6,name:'Turn 6'},
      {n:7,name:'Turn 7'},{n:8,name:'Horquilla (Hairpin)'},{n:9,name:'Turn 9'},
      {n:11,name:'Turn 11'},{n:12,name:'Peraltada Entry'},{n:13,name:'Foro Sol / Stadium'},
      {n:14,name:' Stadium Section'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},{n:17,name:'Turn 17'},
    ],
  },
  'Interlagos': {
    fullName: 'Autodromo Jose Carlos Pace', location: 'São Paulo, Brazil',
    length: 4.309, corners: 15, drs: 2,
    lapRecord: { time: '1:10.540', driver: 'Valtteri Bottas', year: 2018 },
    wikiTitle: 'Autodromo Jose Carlos Pace',
    f1ImageName: 'interlagos',
    firstGp: 1973,
    turns: [
      {n:1,name:'Curva 1 (Senna S)'},{n:2,name:'Curva 2 (Senna S)'},{n:3,name:'Curva do Sol'},
      {n:4,name:'Descida do Lago'},{n:5,name:'Ferradura'},{n:6,name:'Laranjinha'},
      {n:7,name:'Pinheirinho'},{n:8,name:'Bico de Pato'},{n:9,name:'Mergulho'},
      {n:10,name:'Junção'},{n:11,name:'Subida dos Boxes'},{n:12,name:'Curva do Leque'},
      {n:13,name:'Arquibancadas'},{n:14,name:'Reta Oposta'},{n:15,name:'Junção'},
    ],
  },
  'Las Vegas': {
    fullName: 'Las Vegas Street Circuit', location: 'Las Vegas, Nevada, USA',
    length: 6.201, corners: 17, drs: 3,
    lapRecord: { time: '1:35.490', driver: 'Oscar Piastri', year: 2024 },
    wikiTitle: 'Las Vegas Street Circuit',
    f1ImageName: 'lasvegas',
    firstGp: 2023,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Koval'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Harmon'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Sands'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},
      {n:16,name:'Vegas'},{n:17,name:'Turn 17'},
    ],
  },
  'Lusail': {
    fullName: 'Losail International Circuit', location: 'Lusail, Qatar',
    length: 5.380, corners: 16, drs: 2,
    lapRecord: { time: '1:24.319', driver: 'Max Verstappen', year: 2023 },
    wikiTitle: 'Losail International Circuit',
    f1ImageName: 'lusail',
    firstGp: 2021,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
    ],
  },
  'Yas Marina Circuit': {
    fullName: 'Yas Marina Circuit', location: 'Yas Island, Abu Dhabi, UAE',
    length: 5.281, corners: 16, drs: 2,
    lapRecord: { time: '1:26.103', driver: 'Max Verstappen', year: 2021 },
    wikiTitle: 'Yas Marina Circuit',
    f1ImageName: 'yasmarina',
    firstGp: 2009,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
    ],
  },
  'Madring': {
    fullName: 'Madrid Street Circuit', location: 'Madrid, Spain',
    length: 5.476, corners: 20, drs: 3,
    lapRecord: { time: '—', driver: '—', year: 2026 },
    f1ImageName: 'madrid',
    firstGp: 2026,
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
      {n:17,name:'Turn 17'},{n:18,name:'Turn 18'},{n:19,name:'Turn 19'},{n:20,name:'Turn 20'},
    ],
  },
};

let scheduleData  = null;
let scheduleLoading = false;
let selectedMeeting = null;
let mapFetchToken = 0;

function loadSchedule() {
  if (scheduleData) { renderScheduleList(); return; }
  if (scheduleLoading) return;
  scheduleLoading = true;
  const view = document.getElementById('schedule-view');
  view.innerHTML = `<div class="schedule-loading"><div class="spinner"></div><span>Loading race schedule…</span></div>`;
  fetch(`${API_URL}/api/schedule`)
    .then(r => r.json())
    .then(data => {
      scheduleLoading = false;
      scheduleData = data;
      renderScheduleList();
      startCountdown();
    })
    .catch(err => {
      scheduleLoading = false;
      const view = document.getElementById('schedule-view');
      if (view) view.innerHTML = `<div class="schedule-loading" style="color:var(--red)">Failed to load schedule: ${err.message}</div>`;
    });
}

function renderScheduleList() {
  selectedMeeting = null;
  pushHash('schedule');
  const view = document.getElementById('schedule-view');
  if (!view || !scheduleData) return;

  const meetings = scheduleData.meetings || [];
  const year     = scheduleData.year || new Date().getFullYear();

  const html = `
    <div id="sched-countdown" class="sched-countdown" style="display:none"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:11px;color:var(--text-3);letter-spacing:1px;font-weight:700">${year} FORMULA 1 CALENDAR</span>
      <span style="font-size:10px;color:var(--text-3)">${meetings.length} rounds</span>
    </div>
    <div class="schedule-grid">
      ${meetings.map((m, i) => {
        const raceDate = m.race_date ? new Date(m.race_date) : null;
        const dateStr  = raceDate ? raceDate.toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '—';
        const cls = m.is_past ? 'sched-card past' : m.is_next ? 'sched-card next-race' : 'sched-card';
        const nextBadge = m.is_next ? '<span class="sched-next-badge">NEXT</span>' : '';
        const shortName = m.circuit_short_name || m.country_name || '';
        return `<div class="${cls}" onclick="showTrackDetail(${i})">
          <div class="sched-round">RD ${i + 1} · ${m.country_name || ''}${nextBadge}</div>
          <div class="sched-name">${(m.meeting_name || '').replace(' Grand Prix','').replace(' GRAND PRIX','')}<br><small style="font-weight:400;font-size:10px;color:var(--text-3)">Grand Prix</small></div>
          <div class="sched-circuit">${shortName}</div>
          <div class="sched-date">${dateStr}</div>
        </div>`;
      }).join('')}
    </div>
  `;
  view.innerHTML = html;
}

function showTrackDetail(idx) {
  pushHash('schedule', idx);
  const meetings = scheduleData?.meetings || [];
  const m = meetings[idx];
  if (!m) return;
  selectedMeeting = m;

  const shortName = m.circuit_short_name || '';
  const circuit   = CIRCUIT_DB[shortName] || {};

  const raceDate = m.race_date ? new Date(m.race_date) : null;
  const raceDateFull = raceDate
    ? raceDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'long', year:'numeric' })
    : '—';

  const roundNum = (scheduleData?.meetings || []).indexOf(m) + 1;

  // Sessions list
  const now = new Date();
  const sessionsHTML = (m.sessions || []).map(s => {
    const d = s.date_start ? new Date(s.date_start) : null;
    const timeStr = d ? d.toLocaleString('en-GB', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
    const tzAbbr = d ? Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '' : '';
    const isRace = s.session_type === 'Race';
    const isPast = d && d < now;
    const sk = s.session_key;
    const histBtn = sk && isPast ? `<button class="session-hist-btn" onclick="loadSessionHistory(${sk},'${(s.session_name||s.session_type).replace(/'/g,"\\'")}')">Load</button>` : '';
    const chartBtn = sk && isPast && isRace ? `<button class="session-chart-btn" onclick="loadAndShowChart(${sk})">Chart</button>` : '';
    return `<div class="track-session-item">
      <span class="track-session-name${isRace ? ' is-race' : ''}">${s.session_name || s.session_type}</span>
      <span class="track-session-date">${timeStr} <span style="color:var(--text-3);font-size:9px">${tzAbbr}</span></span>
      <span style="display:flex;gap:4px">${histBtn}${chartBtn}</span>
    </div>`;
  }).join('');

  // Stats
  const statsHTML = `
    <div class="track-stats">
      <div class="track-stat">
        <div class="track-stat-label">CIRCUIT LENGTH</div>
        <div class="track-stat-value">${circuit.length || '—'}<span class="track-stat-unit"> km</span></div>
      </div>
      <div class="track-stat">
        <div class="track-stat-label">CORNERS</div>
        <div class="track-stat-value">${circuit.corners || '—'}</div>
      </div>
      <div class="track-stat">
        <div class="track-stat-label">DRS ZONES</div>
        <div class="track-stat-value">${circuit.drs || '—'}</div>
      </div>
      <div class="track-stat">
        <div class="track-stat-label">FIRST GP</div>
        <div class="track-stat-value" style="font-size:11px">${circuit.firstGp || (raceDate ? raceDate.getFullYear() : '—')}</div>
      </div>
    </div>
  `;

  // Lap record
  const lr = circuit.lapRecord;
  const lapRecordHTML = lr ? `
    <div class="track-lap-record">
      <div class="track-lr-label">⚡ LAP RECORD</div>
      <div class="track-lr-time">${lr.time}</div>
      <div class="track-lr-driver">${lr.driver} · ${lr.year}</div>
    </div>
  ` : '';

  // Corners
  const corners = circuit.turns || [];
  const cornersHTML = corners.length ? `
    <div class="track-corners">
      <div class="track-corners-title">🔀 Corner Names</div>
      <div class="track-corners-grid">
        ${corners.map(c => `
          <div class="track-corner-item">
            <span class="track-corner-num">T${c.n}</span>
            <span class="track-corner-name">${c.name}</span>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  // Map placeholder — filled asynchronously after render
  const mapPlaceholder = `<div class="track-map-loading"><div class="spinner"></div><span>Loading circuit map…</span></div>`;

  const view = document.getElementById('schedule-view');
  view.innerHTML = `
    <div class="track-detail">
      <button class="track-detail-back" onclick="renderScheduleList()">← Back to Calendar</button>

      <div class="track-detail-header">
        <div class="track-detail-titles">
          <div class="track-detail-round">ROUND ${roundNum} · ${scheduleData.year}</div>
          <div class="track-detail-name">${(m.meeting_name || '').replace(' Grand Prix', '')} Grand Prix</div>
          <div class="track-detail-circuit">${circuit.fullName || shortName}</div>
          <div class="track-detail-location">📍 ${circuit.location || m.location || m.country_name}</div>
        </div>
        <div class="track-detail-date-block">
          <div class="track-detail-race-date">${raceDate ? raceDate.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—'}</div>
          <div class="track-detail-race-label">RACE DAY</div>
          <div style="font-size:9px;color:var(--text-3);margin-top:2px">${raceDate ? raceDate.toLocaleDateString('en-GB',{year:'numeric'}) : ''}</div>
          <button class="track-cal-btn" onclick="downloadCalendar(${roundNum - 1})">📅 Add to Calendar</button>
        </div>
      </div>

      <div class="track-detail-body">
        <div>
          <div class="track-map-wrap" id="circuit-map-wrap">${mapPlaceholder}</div>
          ${cornersHTML}
        </div>
        <div class="track-info-panel">
          ${statsHTML}
          ${lapRecordHTML}
          <div class="track-sessions">
            <div class="track-session-title">SESSION SCHEDULE</div>
            ${sessionsHTML || '<div class="track-session-item"><span class="track-session-name" style="color:var(--text-3)">No sessions found</span></div>'}
          </div>
          <div class="track-weather-section" id="track-weather-section" style="display:none">
            <div class="track-session-title">RACE WEATHER</div>
            <div id="track-weather-chart" style="position:relative;height:120px">
              <canvas id="weather-canvas"></canvas>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const myToken = ++mapFetchToken;
  const F1_MAP_BASE = 'https://media.formula1.com/image/upload/c_fit,h_704/q_auto/v0/common/f1/2026/track/2026track';
  if (circuit.f1ImageName) {
    // Use F1.com directly — no async fetch needed
    const wrap = document.getElementById('circuit-map-wrap');
    if (wrap) wrap.innerHTML = `<img class="track-map-img" src="${F1_MAP_BASE}${circuit.f1ImageName}detailed.webp" alt="${circuit.fullName || shortName} circuit map" onerror="this.parentElement.innerHTML='<div class=\\'track-map-fallback\\'>No circuit map available</div>'">`;
  } else if (circuit.wikiTitle || circuit.commonsFile) {
    fetchWikiImage(circuit.wikiTitle, circuit.commonsFile).then(imgUrl => {
      if (myToken !== mapFetchToken) return;
      const wrap = document.getElementById('circuit-map-wrap');
      if (!wrap) return;
      if (imgUrl) {
        wrap.innerHTML = `<img class="track-map-img" src="${imgUrl}" alt="${circuit.fullName || shortName} circuit map" onerror="this.parentElement.innerHTML='<div class=\\'track-map-fallback\\'>No circuit map available</div>'">`;
      } else {
        wrap.innerHTML = `<div class="track-map-fallback">No circuit map available</div>`;
      }
    });
  } else {
    const wrap = document.getElementById('circuit-map-wrap');
    if (wrap) wrap.innerHTML = `<div class="track-map-fallback">No circuit map available</div>`;
  }

  // Load weather chart for past race sessions
  const raceSession = (m.sessions || []).find(s => s.session_type === 'Race');
  if (raceSession?.session_key) {
    const now2 = new Date();
    const raceEnd = raceSession.date_end ? new Date(raceSession.date_end) : (raceSession.date_start ? new Date(raceSession.date_start) : null);
    if (raceEnd && raceEnd < now2) {
      fetch(`${API_URL}/api/weather-history/${raceSession.session_key}`)
        .then(r => r.json()).then(d => {
          if (!d.data?.length) return;
          const weatherSection = document.getElementById('track-weather-section');
          if (weatherSection) weatherSection.style.display = '';
          const data = d.data;
          const step = Math.max(1, Math.floor(data.length / 40));
          const samples = data.filter((_, i) => i % step === 0);
          const labels = samples.map((_, i) => i);
          const isLight = document.body.classList.contains('light');
          const gridCol = isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
          const textCol = isLight ? '#7a7a9a' : '#5a5a72';
          const canvas = document.getElementById('weather-canvas');
          if (!canvas) return;
          new Chart(canvas, {
            type: 'line',
            data: { labels, datasets: [
              { label: 'Track°C', data: samples.map(w => w.track), borderColor: '#e10600', borderWidth: 1.5, pointRadius: 0, tension: 0.4 },
              { label: 'Air°C', data: samples.map(w => w.air), borderColor: '#3498db', borderWidth: 1.5, pointRadius: 0, tension: 0.4 },
            ]},
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { labels: { color: textCol, font: { size: 9 }, boxWidth: 10 }, position: 'bottom' } },
              scales: {
                x: { display: false },
                y: { ticks: { color: textCol, font: { size: 9 } }, grid: { color: gridCol } }
              }
            }
          });
        }).catch(() => {});
    }
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• BOOT â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
/* ════════════════════════ STANDINGS SUB-TABS ══════════════════════════════ */
document.querySelectorAll('.standings-sub-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.standings-sub-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.standings-sub').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`sub-${btn.dataset.sub}`)?.classList.add('active');
    if (btn.dataset.sub === 'strategy') renderStrategy();
    if (btn.dataset.sub === 'gapchart') loadGapChart();
    if (btn.dataset.sub === 'speed') renderSpeedTrap();
  });
});

/* ════════════════════════ DARK / LIGHT MODE ═══════════════════════════════ */
function initTheme() {
  if ((localStorage.getItem('f1-theme') || 'dark') === 'light') document.body.classList.add('light');
  updateThemeBtn();
}
function toggleTheme() {
  document.body.classList.toggle('light');
  localStorage.setItem('f1-theme', document.body.classList.contains('light') ? 'light' : 'dark');
  updateThemeBtn();
  if (gapChartInstance) buildChart();
}
function updateThemeBtn() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = document.body.classList.contains('light') ? '🌙' : '☀️';
}
document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
initTheme();

/* ════════════════════════ PUSH NOTIFICATIONS ══════════════════════════════ */
let notificationsEnabled = false;
async function toggleNotifications() {
  if (notificationsEnabled) {
    notificationsEnabled = false;
    updateNotifBtn();
    showToast('Race control notifications disabled', 'toast-info');
    return;
  }
  if (!('Notification' in window)) { showToast('Notifications not supported', 'toast-info'); return; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { showToast('Notification permission denied', 'toast-info'); return; }
  notificationsEnabled = true;
  updateNotifBtn();
  showToast('Race control notifications enabled', 'toast-info');
}
function updateNotifBtn() {
  const btn = document.getElementById('notif-toggle');
  if (!btn) return;
  btn.classList.toggle('active', notificationsEnabled);
  btn.title = notificationsEnabled ? 'Disable notifications' : 'Enable race control notifications';
}
function sendRCNotification(msg) {
  if (!notificationsEnabled || Notification.permission !== 'granted') return;
  const flag = (msg.Flag || msg.Category || '').toLowerCase();
  if (!flag.includes('safety') && !flag.includes('red') && !flag.includes('yellow') && !flag.includes('drs')) return;
  try { new Notification('F1 Race Control', { body: msg.Message || '—' }); } catch {}
}
document.getElementById('notif-toggle')?.addEventListener('click', toggleNotifications);

/* ════════════════════════ COUNTDOWN TIMER ═════════════════════════════════ */
let countdownInterval = null;
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdown, 1000);
  updateCountdown();
}
function updateCountdown() {
  const el = document.getElementById('sched-countdown');
  if (!el || !scheduleData) return;
  const now = Date.now();
  let nextSession = null, nextMeeting = null;
  for (const m of (scheduleData.meetings || [])) {
    for (const s of (m.sessions || [])) {
      if (!s.date_start) continue;
      const t = new Date(s.date_start).getTime();
      if (t > now && (!nextSession || t < new Date(nextSession.date_start).getTime())) {
        nextSession = s; nextMeeting = m;
      }
    }
  }
  if (!nextSession) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const diff = new Date(nextSession.date_start).getTime() - now;
  const dd = Math.floor(diff / 86400000);
  const hh = Math.floor((diff % 86400000) / 3600000);
  const mm = Math.floor((diff % 3600000) / 60000);
  const ss = Math.floor((diff % 60000) / 1000);
  const gpName = (nextMeeting.meeting_name || '').replace(' Grand Prix', '');
  const sesName = nextSession.session_name || nextSession.session_type;
  el.innerHTML = `<span class="cd-icon">&#9201;</span><span class="cd-label">NEXT: ${gpName} ${sesName}</span><span class="cd-time">${dd > 0 ? `${dd}d ` : ''}${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}</span>`;
}

/* ════════════════════════ TYRE STRATEGY ═══════════════════════════════════ */
const STRAT_COLOURS = { S:'#e10600', M:'#f5c518', H:'#d0d0d0', I:'#27c16a', W:'#3498db' };
function renderStrategy() {
  const wrap = document.getElementById('strategy-body');
  if (!wrap) return;
  const lines = state.TimingData?.Lines || {};
  const driverInfo = state.DriverList || {};
  const totalLaps = parseInt(state.LapCount?.TotalLaps) || 0;
  const positions = Object.keys(lines)
    .filter(k => lines[k]?.Position)
    .map(k => ({ num: k, data: lines[k] }))
    .sort((a, b) => parseInt(a.data.Position) - parseInt(b.data.Position));
  if (!positions.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px">No stint data available</div>';
    return;
  }
  const maxLap = totalLaps || Math.max(...positions.map(p => parseInt(p.data.NumberOfLaps) || 0), 50);
  wrap.innerHTML = positions.map(({ num, data }) => {
    const info = driverInfo[num] || {};
    const color = info.TeamColour ? `#${info.TeamColour}` : '#888';
    const name = info.Tla || `#${num}`;
    const stints = data.Stints || [];
    const bars = stints.map(s => {
      const letter = TYRE_MAP[(s.Compound || '').toUpperCase()] || '?';
      const lapStart = s.LapStart || 0;
      const lapEnd = s.LapEnd || lapStart;
      const leftPct = (lapStart / maxLap * 100).toFixed(1);
      const widthPct = Math.max(1.5, (lapEnd - lapStart + 1) / maxLap * 100).toFixed(1);
      const col = STRAT_COLOURS[letter] || '#888';
      return `<div class="strat-bar" style="left:${leftPct}%;width:${widthPct}%;background:${col}" title="${s.Compound || '?'} L${lapStart}-${lapEnd}">${letter}</div>`;
    }).join('');
    const pitMarkers = stints.slice(1).map(s => {
      const lapStart = s.LapStart || 0;
      const leftPct = (lapStart / maxLap * 100).toFixed(1);
      return `<div class="strat-pit-marker" style="left:${leftPct}%" title="Pit stop L${lapStart}"></div>`;
    }).join('');
    return `<div class="strat-row">
      <div class="strat-name" style="border-left-color:${color}">${name}</div>
      <div class="strat-track">${bars || '<span style="color:var(--text-3);font-size:9px;padding:4px 6px">—</span>'}${pitMarkers}</div>
    </div>`;
  }).join('');
}

/* ════════════════════════ RACE HISTORY CHART ══════════════════════════════ */
let gapChartInstance = null;
let gapChartData = null;
let gapChartMode = 'position';
let gapChartSessionKey = null;

async function loadGapChart(sessionKey) {
  const wrap = document.getElementById('gap-chart-wrap');
  if (!wrap) return;
  const sk = sessionKey || gapChartSessionKey;
  if (!sk) {
    wrap.innerHTML = '<div class="empty-state" style="padding:30px">Open a race from the Schedule tab and click "Chart" to load</div>';
    return;
  }
  gapChartSessionKey = sk;
  if (gapChartInstance) { gapChartInstance.destroy(); gapChartInstance = null; }
  wrap.innerHTML = '<div class="schedule-loading"><div class="spinner"></div><span>Loading race history…</span></div>';
  try {
    const r = await fetch(`${API_URL}/api/race-history/${sk}`);
    gapChartData = await r.json();
    if (gapChartData.error) throw new Error(gapChartData.error);
    wrap.innerHTML = '<div style="position:relative;height:320px"><canvas id="race-chart"></canvas></div>';
    buildChart();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state" style="padding:30px;color:var(--red)">Failed: ${e.message}</div>`;
  }
}

function buildChart() {
  const canvas = document.getElementById('race-chart');
  if (!canvas || !gapChartData) return;
  if (gapChartInstance) { gapChartInstance.destroy(); gapChartInstance = null; }
  const { gap_data, drivers, max_lap } = gapChartData;
  if (!gap_data || !max_lap) return;
  const labels = Array.from({ length: max_lap }, (_, i) => i + 1);
  const isPos = gapChartMode === 'position';
  const sorted = Object.keys(gap_data).sort((a, b) => {
    const al = gap_data[a], bl = gap_data[b];
    return (al[al.length-1]?.pos ?? 99) - (bl[bl.length-1]?.pos ?? 99);
  }).slice(0, 10);
  const isLight = document.body.classList.contains('light');
  const gridCol = isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
  const textCol = isLight ? '#7a7a9a' : '#5a5a72';
  gapChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: sorted.map(num => {
        const info = drivers[num] || {};
        const col = `#${info.colour || '888888'}`;
        return {
          label: info.name || `#${num}`,
          data: labels.map(lap => { const e = gap_data[num]?.find(x => x.lap === lap); return e ? (isPos ? e.pos : e.gap) : null; }),
          borderColor: col, backgroundColor: col + '18',
          borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true,
        };
      }),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: textCol, font: { size: 10, family: 'JetBrains Mono' }, boxWidth: 12 }, position: 'bottom' },
        tooltip: { backgroundColor: isLight ? '#fff' : '#14141f', borderColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)', borderWidth: 1, titleColor: isLight ? '#0a0a14' : '#f0f0f5', bodyColor: textCol },
      },
      scales: {
        x: { title: { display: true, text: 'LAP', color: textCol, font: { size: 9 } }, ticks: { color: textCol, font: { size: 9 }, maxTicksLimit: 20 }, grid: { color: gridCol } },
        y: {
          reverse: isPos, min: isPos ? 1 : 0,
          max: isPos ? Object.keys(gap_data).length : undefined,
          title: { display: true, text: isPos ? 'POSITION' : 'GAP (s)', color: textCol, font: { size: 9 } },
          ticks: { color: textCol, font: { size: 9 }, ...(isPos ? { stepSize: 1 } : {}) },
          grid: { color: gridCol },
        },
      },
    },
  });
}

function setChartMode(mode) {
  gapChartMode = mode;
  document.getElementById('chart-pos-btn')?.classList.toggle('active', mode === 'position');
  document.getElementById('chart-gap-btn')?.classList.toggle('active', mode === 'gap');
  buildChart();
}
document.getElementById('chart-pos-btn')?.addEventListener('click', () => setChartMode('position'));
document.getElementById('chart-gap-btn')?.addEventListener('click', () => setChartMode('gap'));
document.getElementById('chart-reload-btn')?.addEventListener('click', () => { gapChartData = null; loadGapChart(); });

/* ════════════════════════ SESSION HISTORY LOADER ══════════════════════════ */
async function loadSessionHistory(sessionKey, sessionName) {
  showToast(`Loading ${sessionName}…`, 'toast-info');
  try {
    const r = await fetch(`${API_URL}/api/session-history/${sessionKey}`);
    const msg = await r.json();
    if (msg.error) throw new Error(msg.error);
    if (msg.type === 'historical') {
      processHistorical(msg.data);
      setTimeout(renderAll, 0);
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('.tab-btn[data-tab="standings"]')?.classList.add('active');
      document.getElementById('tab-standings')?.classList.add('active');
      gapChartSessionKey = sessionKey;
      gapChartData = null;
      if (gapChartInstance) { gapChartInstance.destroy(); gapChartInstance = null; }
      showToast(`Loaded: ${sessionName}`, 'toast-info');
    }
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'toast-rc');
  }
}

async function loadAndShowChart(sessionKey) {
  gapChartSessionKey = sessionKey;
  gapChartData = null;
  if (gapChartInstance) { gapChartInstance.destroy(); gapChartInstance = null; }
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="standings"]')?.classList.add('active');
  document.getElementById('tab-standings')?.classList.add('active');
  document.querySelectorAll('.standings-sub-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.standings-sub').forEach(c => c.classList.remove('active'));
  document.querySelector('.standings-sub-btn[data-sub="gapchart"]')?.classList.add('active');
  document.getElementById('sub-gapchart')?.classList.add('active');
  loadGapChart(sessionKey);
}

document.getElementById('historical-banner-close')?.addEventListener('click', hideHistoricalBanner);

/* ════════════════════════ CALENDAR DOWNLOAD ══════════════════════════════ */
function downloadCalendar(idx) {
  const m = scheduleData?.meetings?.[idx];
  if (!m) return;
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//F1 Dashboard//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  (m.sessions || []).forEach(s => {
    if (!s.date_start) return;
    const start = new Date(s.date_start);
    const end = s.date_end ? new Date(s.date_end) : new Date(start.getTime() + 7200000);
    const fmt = d => d.toISOString().replace(/[-:.]/g,'').slice(0,15)+'Z';
    lines.push('BEGIN:VEVENT',`DTSTART:${fmt(start)}`,`DTEND:${fmt(end)}`,
      `SUMMARY:F1 ${m.meeting_name} – ${s.session_name||s.session_type}`,
      `LOCATION:${CIRCUIT_DB[m.circuit_short_name||'']?.location||m.country_name||''}`,
      'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n')],{type:'text/calendar'}));
  a.download = `f1-${(m.meeting_name||'race').toLowerCase().replace(/\s+/g,'-')}.ics`;
  a.click(); URL.revokeObjectURL(a.href);
}

/* ════════════════════════ SPEED TRAP ══════════════════════════════════════ */
function renderSpeedTrap() {
  const wrap = document.getElementById('speed-trap-body');
  if (!wrap) return;
  const lines = state.TimingData?.Lines || {};
  const driverInfo = state.DriverList || {};
  const entries = Object.keys(lines)
    .map(num => ({
      num,
      name: driverInfo[num]?.Tla || `#${num}`,
      fullName: `${driverInfo[num]?.FirstName||''} ${driverInfo[num]?.LastName||''}`.trim(),
      team: driverInfo[num]?.TeamName || '',
      color: driverInfo[num]?.TeamColour ? `#${driverInfo[num].TeamColour}` : '#888',
      speed: parseFloat(lines[num]?.Speeds?.FL?.Value || lines[num]?.TopSpeed || 0),
      pos: parseInt(lines[num]?.Position || 99),
    }))
    .filter(e => e.speed > 0)
    .sort((a, b) => b.speed - a.speed);

  if (!entries.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px">No speed data available</div>';
    return;
  }
  const maxSpeed = entries[0].speed;
  wrap.innerHTML = `
    <div class="spd-header">
      <span class="spd-h-rank">RANK</span>
      <span class="spd-h-driver">DRIVER</span>
      <span class="spd-h-speed">TOP SPEED</span>
    </div>
    ${entries.map((e, i) => {
      const barPct = (e.speed / maxSpeed * 100).toFixed(1);
      return `<div class="spd-row">
        <span class="spd-rank">${i + 1}</span>
        <div class="spd-driver">
          <div class="spd-bar-bg"><div class="spd-bar-fill" style="width:${barPct}%;background:${e.color}"></div></div>
          <div class="spd-name"><span class="spd-tla" style="border-left:3px solid ${e.color}">${e.name}</span><span class="spd-full">${e.fullName}</span></div>
        </div>
        <span class="spd-val">${e.speed.toFixed(0)} <span class="spd-unit">km/h</span></span>
      </div>`;
    }).join('')}
  `;
}

/* ════════════════════════ DRIVER H2H COMPARISON ══════════════════════════ */
let h2hSelection = null;

function selectDriverForH2H(num) {
  if (!h2hSelection) {
    h2hSelection = num;
    document.querySelector(`[data-dnum="${num}"]`)?.classList.add('h2h-selected');
    showToast('Select a second driver to compare', 'toast-info');
    return;
  }
  if (h2hSelection === num) {
    document.querySelector(`[data-dnum="${h2hSelection}"]`)?.classList.remove('h2h-selected');
    h2hSelection = null;
    return;
  }
  openH2H(h2hSelection, num);
  document.querySelector(`[data-dnum="${h2hSelection}"]`)?.classList.remove('h2h-selected');
  h2hSelection = null;
}

function openH2H(numA, numB) {
  const lines = state.TimingData?.Lines || {};
  const driverInfo = state.DriverList || {};
  const a = { num: numA, data: lines[numA]||{}, info: driverInfo[numA]||{} };
  const b = { num: numB, data: lines[numB]||{}, info: driverInfo[numB]||{} };

  const color = d => d.info.TeamColour ? `#${d.info.TeamColour}` : '#888';
  const name = d => `${d.info.FirstName||''} ${d.info.LastName||''}`.trim() || `#${d.num}`;
  const tla = d => d.info.Tla || `#${d.num}`;

  function statRow(label, va, vb) {
    return `<tr><td class="h2h-label">${label}</td><td class="h2h-val-a">${va}</td><td class="h2h-val-b">${vb}</td></tr>`;
  }

  const content = `
    <div class="h2h-header">
      <div class="h2h-driver-a" style="border-bottom:3px solid ${color(a)}">
        <div class="h2h-tla">${tla(a)}</div>
        <div class="h2h-name">${name(a)}</div>
        <div class="h2h-team">${a.info.TeamName||''}</div>
      </div>
      <div class="h2h-vs">VS</div>
      <div class="h2h-driver-b" style="border-bottom:3px solid ${color(b)}">
        <div class="h2h-tla">${tla(b)}</div>
        <div class="h2h-name">${name(b)}</div>
        <div class="h2h-team">${b.info.TeamName||''}</div>
      </div>
    </div>
    <table class="h2h-table">
      ${statRow('Position', a.data.Position||'—', b.data.Position||'—')}
      ${statRow('Best Lap', a.data.BestLapTime?.Value||'—', b.data.BestLapTime?.Value||'—')}
      ${statRow('Last Lap', a.data.LastLapTime?.Value||'—', b.data.LastLapTime?.Value||'—')}
      ${statRow('Best S1', a.data.BestSectors?.[0]?.Value||'—', b.data.BestSectors?.[0]?.Value||'—')}
      ${statRow('Best S2', a.data.BestSectors?.[1]?.Value||'—', b.data.BestSectors?.[1]?.Value||'—')}
      ${statRow('Best S3', a.data.BestSectors?.[2]?.Value||'—', b.data.BestSectors?.[2]?.Value||'—')}
      ${statRow('Pit Stops', a.data.NumberOfPitStops??'—', b.data.NumberOfPitStops??'—')}
      ${statRow('Laps', a.data.NumberOfLaps||'—', b.data.NumberOfLaps||'—')}
      ${statRow('Gap to Leader', a.data.GapToLeader||'—', b.data.GapToLeader||'—')}
      ${statRow('Top Speed', a.data.Speeds?.FL?.Value ? a.data.Speeds.FL.Value+' km/h' : '—', b.data.Speeds?.FL?.Value ? b.data.Speeds.FL.Value+' km/h' : '—')}
    </table>
  `;

  document.getElementById('h2h-content').innerHTML = content;
  document.getElementById('h2h-modal').classList.remove('hidden');
}

function closeH2H() {
  document.getElementById('h2h-modal').classList.add('hidden');
  h2hSelection = null;
  document.querySelectorAll('.h2h-selected').forEach(el => el.classList.remove('h2h-selected'));
}

document.getElementById('h2h-close')?.addEventListener('click', closeH2H);
document.getElementById('h2h-backdrop')?.addEventListener('click', closeH2H);

/* ════════════════════════ URL HASH STATE ══════════════════════════════════ */
function pushHash(tab, detail) {
  const h = detail != null ? `${tab}/${detail}` : tab;
  if (location.hash !== '#' + h) history.replaceState(null, '', '#' + h);
}

function restoreFromHash() {
  const parts = location.hash.replace('#','').split('/');
  const tab = parts[0];
  const detail = parts[1];
  if (!tab) return;
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) return;
  btn.click();
  if (tab === 'schedule' && detail != null) {
    const tryShow = () => {
      if (scheduleData) { showTrackDetail(parseInt(detail)); }
      else setTimeout(tryShow, 500);
    };
    setTimeout(tryShow, 100);
  }
}

/* ════════════════════════ KEYBOARD SHORTCUTS ══════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case '1': document.querySelector('.tab-btn[data-tab="standings"]')?.click(); break;
    case '2': document.querySelector('.tab-btn[data-tab="championship"]')?.click(); break;
    case '3': document.querySelector('.tab-btn[data-tab="schedule"]')?.click(); break;
    case 't': case 'T': {
      document.querySelector('.tab-btn[data-tab="standings"]')?.click();
      setTimeout(() => document.querySelector('.standings-sub-btn[data-sub="strategy"]')?.click(), 50);
      break;
    }
    case 'g': case 'G': {
      document.querySelector('.tab-btn[data-tab="standings"]')?.click();
      setTimeout(() => document.querySelector('.standings-sub-btn[data-sub="gapchart"]')?.click(), 50);
      break;
    }
    case 's': case 'S': {
      document.querySelector('.tab-btn[data-tab="standings"]')?.click();
      setTimeout(() => document.querySelector('.standings-sub-btn[data-sub="speed"]')?.click(), 50);
      break;
    }
    case 'Escape': {
      if (!document.getElementById('h2h-modal')?.classList.contains('hidden')) { closeH2H(); break; }
      if (!document.getElementById('kb-help')?.classList.contains('hidden')) { document.getElementById('kb-help').classList.add('hidden'); break; }
      if (selectedMeeting) { renderScheduleList(); break; }
      break;
    }
    case '?': document.getElementById('kb-help')?.classList.toggle('hidden'); break;
  }
});

document.getElementById('kb-help-btn')?.addEventListener('click', () => document.getElementById('kb-help')?.classList.toggle('hidden'));
document.getElementById('kb-backdrop')?.addEventListener('click', () => document.getElementById('kb-help')?.classList.add('hidden'));
document.getElementById('kb-help-close')?.addEventListener('click', () => document.getElementById('kb-help')?.classList.add('hidden'));

connectWS();
restoreFromHash();

setTimeout(async () => {
  if (Object.keys(state.DriverList).length > 0) return;
  try {
    const r = await fetch(`${API_URL}/api/historical`);
    if (!r.ok) return;
    const msg = await r.json();
    if (msg.type === 'historical') { processHistorical(msg.data); setTimeout(renderAll, 0); }
  } catch (e) { console.warn('Historical HTTP fetch failed:', e); }
}, 2000);

