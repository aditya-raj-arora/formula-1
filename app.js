/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   F1 LIVE RACE DASHBOARD  â€”  app.js
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
  setStatus('idle', 'Connectingâ€¦');
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
  document.getElementById('historical-banner-text').textContent = `No live session â€” showing ${label} results`;
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
    `${sInfo.Meeting?.Name || 'Grand Prix'}  Â·  ${sInfo.Name || 'Session'}`;

  const lc = state.LapCount || {};
  if (lc.CurrentLap) document.getElementById('current-lap').textContent = lc.CurrentLap;
  document.getElementById('total-laps').textContent = lc.TotalLaps || 'â€”';

  const w = state.WeatherData || {};
  if (Object.keys(w).length) {
    const isRain = w.Rainfall === '1' || w.Rainfall === true || w.Rainfall === 1;
    document.getElementById('ws-track').textContent = w.TrackTemp ? `${w.TrackTemp}Â°` : 'â€”Â°';
    document.getElementById('ws-air').textContent   = w.AirTemp   ? `${w.AirTemp}Â°`   : 'â€”Â°';
    document.getElementById('ws-hum').textContent   = w.Humidity  ? `${w.Humidity}%`  : 'â€”%';
    document.getElementById('ws-wind').textContent  = w.WindSpeed ? `${w.WindSpeed} m/s` : 'â€” m/s';
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
    tbody.innerHTML = `<tr><td colspan="15"><div class="empty-state"><span class="empty-icon">ðŸŽï¸</span>Waiting for timing dataâ€¦</div></td></tr>`;
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
    const leaderRaw  = idx === 0 ? 'LEADER' : (dData.GapToLeader || dData.TimeDiffToPositionAhead || 'â€”');
    const intervalRaw = dData.Interval || dData.TimeDiffToPositionAhead || (idx === 0 ? 'â€”' : 'â€”');
    const gapVal = String(leaderRaw);
    let leaderCls = 'td-gap';
    if (idx === 0)                                                                    leaderCls += ' is-leader';
    else if (gapVal.includes('LAP'))                                                  leaderCls += ' lapped';
    else if (['DNF','DNS','DSQ','Ret','Accident','Collision'].some(s=>gapVal.includes(s))) leaderCls += ' dnf';
    const intCls = idx === 0 ? 'td-gap is-interval-leader' : 'td-gap';

    // Lap times
    const lastLap        = dData.LastLapTime?.Value || 'â€”';
    const overallFastest = dData.LastLapTime?.OverallFastest;
    const personalBest   = dData.LastLapTime?.PersonalFastest;
    const lapFlashCls    = overallFastest ? 'cell-flash-fastest' : personalBest ? 'cell-flash-pb' : 'cell-flash';
    const lapCls         = 'td-lap' + (overallFastest ? ' fastest' : personalBest ? ' personal-best' : '');

    const bestLap     = dData.BestLapTime?.Value || 'â€”';
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
    const s1 = dData.LastSectors?.[0]?.Value || dData.Sectors?.[0]?.Value || 'â€”';
    const s2 = dData.LastSectors?.[1]?.Value || dData.Sectors?.[1]?.Value || 'â€”';
    const s3 = dData.LastSectors?.[2]?.Value || dData.Sectors?.[2]?.Value || 'â€”';
    const bs1 = dData.BestSectors?.[0];
    const bs2 = dData.BestSectors?.[1];
    const bs3 = dData.BestSectors?.[2];
    const s1Cls = 'td-sector' + (bs1?.OverallFastest ? ' s-purple' : personalBest ? ' s-green' : ' s-white');
    const s2Cls = 'td-sector' + (bs2?.OverallFastest ? ' s-purple' : personalBest ? ' s-green' : ' s-white');
    const s3Cls = 'td-sector' + (bs3?.OverallFastest ? ' s-purple' : personalBest ? ' s-green' : ' s-white');

    const spd      = dData.Speeds?.FL?.Value || dData.TopSpeed || 'â€”';
    const pitCount = dData.NumberOfPitStops != null ? dData.NumberOfPitStops
                   : dData.Stints ? Math.max(0, dData.Stints.length - 1) : 0;
    const pitCls   = pitCount > 0 ? 'td-pit has-pits' : 'td-pit';
    const lapsNum  = parseInt(dData.NumberOfLaps) || 0;

    let lapPct = '0%';
    if (totalLaps > 0 && lapsNum > 0) lapPct = `${Math.min(100, (lapsNum / totalLaps) * 100).toFixed(1)}%`;

    const initP    = initialPos.get(dNum) || parseInt(pos);
    const delta    = initP - parseInt(pos);
    let deltaTxt   = 'â€”';
    let deltaCls   = 'td-delta same';
    if (delta > 0) { deltaTxt = `â–²${delta}`; deltaCls = 'td-delta gained'; }
    if (delta < 0) { deltaTxt = `â–¼${Math.abs(delta)}`; deltaCls = 'td-delta lost'; }

    // Build driver cell top row: acronym + fastest lap icon + pit icon
    const flIcon  = isFastestLap ? '<span class="driver-fl-icon" title="Fastest Lap">âš¡</span>' : '';
    const pitIcon = isInPit      ? '<span class="driver-pit-icon" title="In Pit">ðŸ”§</span>' : '';
    const driverTopHTML = `<span class="driver-acronym">${acronym}</span>${flIcon}${pitIcon}`;

    const isNew = !rowMap.has(dNum);
    let tr;

    if (isNew) {
      tr = document.createElement('tr');
      tr.className = `timing-row ${posClass}`;
      tr.innerHTML = `
        <td class="tc-pos"><div class="tc-pos-wrap"><span class="tc-pos-num">${pos}</span></div></td>
        <td class="tc-driver">
          <div class="driver-cell">
            <div class="driver-color-bar" style="background:${color}"></div>
            <div class="driver-info">
              <div class="driver-top">${driverTopHTML}</div>
              <span class="driver-name">${fullName}</span>
            </div>
          </div>
        </td>
        <td class="${intCls} td-gap-int">${idx === 0 ? 'â€”' : intervalRaw}</td>
        <td class="${leaderCls} td-gap-leader">${leaderRaw}</td>
        <td class="tc-laps">${lapsNum || 'â€”'}</td>
        <td class="tc-tyre"><span class="tyre-badge tyre-${tyreLetter}">${tyreLetter || '?'}</span></td>
        <td class="tc-hist"><div class="tyre-hist-row">${tyreHistHTML}</div></td>
        <td class="${lapCls} td-lastlap">${lastLap}</td>
        <td class="${bestLapCls} td-bestlap">${bestLap}</td>
        <td class="${pitCls} td-pit-count">${pitCount || 'â€”'}</td>
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
      if (!tr.classList.contains('row-entering')) tr.className = `timing-row ${posClass}`;

      flashCell(tr.querySelector('.tc-pos-num'), pos);

      // Update driver top (icons may change)
      const topEl = tr.querySelector('.driver-top');
      if (topEl) topEl.innerHTML = driverTopHTML;

      const intCell = tr.querySelector('.td-gap-int');
      if (intCell) { intCell.className = `${intCls} td-gap-int`; flashCell(intCell, idx === 0 ? 'â€”' : intervalRaw); }

      const ldrCell = tr.querySelector('.td-gap-leader');
      if (ldrCell) { ldrCell.className = `${leaderCls} td-gap-leader`; flashCell(ldrCell, leaderRaw); }

      flashCell(tr.querySelector('.tc-laps'), lapsNum || 'â€”');

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
      if (pitCell) { pitCell.className = `${pitCls} td-pit-count`; flashCell(pitCell, pitCount || 'â€”'); }

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

/* Build tyre history HTML â€” dots with visible lap counts */
function buildTyreHistory(stints) {
  if (!stints || !stints.length) return '<span style="color:var(--text-3);font-size:9px">â€”</span>';

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

    const arrow = i < stints.length - 1 ? '<span class="th-arrow">â€º</span>' : '';
    return `<span class="th-stint">
      <span class="th-dot th-${letter}${isCurrent ? ' th-current' : ''}" title="${c}">${letter}</span>
      ${lapsStr ? `<span class="th-laps-label">${lapsStr}</span>` : ''}
    </span>${arrow}`;
  }).join('');
}

/* â”€â”€ Race Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function renderRaceControl() {
  const list    = document.getElementById('rc-list');
  const countEl = document.getElementById('rc-count');
  if (!list) return;

  const messages = state.RaceControlMessages?.Messages || [];
  if (countEl) countEl.textContent = `${messages.length} messages`;

  if (!messages.length) {
    list.innerHTML = `<div class="empty-state"><span class="empty-icon">ðŸš©</span>No messages yet</div>`;
    return;
  }

  const displayMsgs = [...messages].reverse().slice(0, 30);
  list.innerHTML = '';
  displayMsgs.forEach(msg => {
    const flag = (msg.Flag || msg.Category || '').toLowerCase();
    let flagCls = 'flag-other';
    if (flag.includes('green') || flag.includes('clear'))       flagCls = 'flag-green';
    else if (flag.includes('yellow') || flag.includes('safety')) flagCls = 'flag-yellow';
    else if (flag.includes('red'))                               flagCls = 'flag-red';
    else if (flag.includes('drs'))                               flagCls = 'flag-drs';

    const timeStr = msg.Utc ? new Date(msg.Utc).toLocaleTimeString() : 'â€”';
    const el = document.createElement('div');
    el.className = `rc-item ${flagCls}`;
    el.innerHTML = `<span class="rc-time">${timeStr}</span><span class="rc-msg">${msg.Message || 'â€”'}</span>`;
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
      <div class="rco-msg">${msg.Message || 'â€”'}</div>
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
  document.getElementById('champ-loading')?.classList.add('hidden');
  document.getElementById('champ-drivers-wrap')?.classList.remove('hidden');
  renderDriverChamp();
  renderTeamChamp();
}
function renderDriverChamp() {
  if (!champData) return;
  const tbody = document.getElementById('champ-drivers-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  (champData.drivers || []).forEach((d, i) => {
    const simPos     = whatIfPositions[d.name] ?? d.last_pos ?? (i + 1);
    const simPts     = simPos >= 1 && simPos <= 10 ? F1_POINTS[simPos - 1] : 0;
    const simTotal   = d.prior_pts + simPts;
    const delta      = simTotal - d.points;
    const deltaStr   = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : 'â€”';
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
      <td>
        <div class="sim-pos-ctrl">
          <button class="pos-adj-btn" onclick="adjustWhatIf('${d.name}',-1)">â–²</button>
          <span class="sim-pos-val">${simPos}</span>
          <button class="pos-adj-btn" onclick="adjustWhatIf('${d.name}',1)">â–¼</button>
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
    const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : 'â€”';
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
  const idx = (champData?.drivers || []).findIndex(d => d.name === name);
  if (idx < 0) return;
  const current = whatIfPositions[name] ?? (champData.drivers[idx].last_pos || idx + 1);
  whatIfPositions[name] = Math.max(1, Math.min(22, current + dir));
  renderDriverChamp(); renderTeamChamp();
}
document.getElementById('wif-reset')?.addEventListener('click', () => { whatIfPositions = {}; renderDriverChamp(); renderTeamChamp(); });

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SCHEDULE â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* Fetch circuit map from Wikipedia Pageimages API (CORS-enabled) */
async function fetchWikiImage(title) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&format=json&pithumbsize=900&origin=*`;
    const r = await fetch(url);
    const data = await r.json();
    const pages = data?.query?.pages || {};
    const page  = Object.values(pages)[0];
    return page?.thumbnail?.source || null;
  } catch { return null; }
}

const CIRCUIT_DB = {
  'Sakhir': {
    fullName: 'Bahrain International Circuit', location: 'Sakhir, Bahrain',
    length: 5.412, corners: 15, drs: 3,
    lapRecord: { time: '1:31.447', driver: 'Pedro de la Rosa', year: 2005 },
    wikiTitle: 'Bahrain International Circuit',
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
    turns: [
      {n:1,name:'Sainte Devote'},{n:3,name:'Beau Rivage'},{n:5,name:'Massenet'},
      {n:6,name:'Casino Square'},{n:7,name:'Mirabeau Haute'},{n:8,name:'Mirabeau Bas'},
      {n:9,name:'Grand Hotel Hairpin'},{n:10,name:'Portier'},{n:12,name:'Tunnel'},
      {n:13,name:'Nouvelle Chicane'},{n:15,name:'Tabac'},{n:16,name:'Piscine (Swimming Pool)'},
      {n:17,name:'Piscine 2'},{n:18,name:'La Rascasse'},{n:19,name:'Anthony Noghes'},
    ],
  },
  'MontrÃ©al': {
    fullName: 'Circuit Gilles Villeneuve', location: 'MontrÃ©al, Canada',
    length: 4.361, corners: 14, drs: 3,
    lapRecord: { time: '1:13.078', driver: 'Valtteri Bottas', year: 2019 },
    wikiTitle: 'Circuit Gilles Villeneuve',
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3 â€” Epingle / Senna Curve'},
      {n:4,name:'Turn 4'},{n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},
      {n:8,name:'Turn 8'},{n:9,name:'Turn 9'},{n:10,name:'Turn 10'},
      {n:13,name:'Wall of Champions (Chicane)'},{n:14,name:'Pits Hairpin'},
    ],
  },
  'Barcelona': {
    fullName: 'Circuit de Barcelona-Catalunya', location: 'MontmelÃ³, Spain',
    length: 4.657, corners: 16, drs: 2,
    lapRecord: { time: '1:18.149', driver: 'Max Verstappen', year: 2021 },
    wikiTitle: 'Circuit de Barcelona-Catalunya',
    turns: [
      {n:1,name:'Elf'},{n:2,name:'Renault'},{n:3,name:'Repsol'},{n:4,name:'WÃ¼rth'},
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
    turns: [
      {n:1,name:'Abbey'},{n:2,name:'Farm'},{n:3,name:'Village'},{n:4,name:'The Loop'},
      {n:5,name:'Aintree'},{n:6,name:'Wellington Straight'},{n:7,name:'Brooklands'},
      {n:8,name:'Luffield'},{n:9,name:'Woodcote'},{n:10,name:'Copse'},
      {n:11,name:'Maggotts'},{n:12,name:'Becketts'},{n:13,name:'Chapel'},
      {n:14,name:'Hangar Straight'},{n:15,name:'Stowe'},{n:16,name:'Vale'},
      {n:17,name:'Club'},{n:18,name:'Abbey'},
    ],
  },
  'Budapest': {
    fullName: 'Hungaroring', location: 'Budapest, Hungary',
    length: 4.381, corners: 14, drs: 2,
    lapRecord: { time: '1:16.627', driver: 'Lewis Hamilton', year: 2020 },
    wikiTitle: 'Hungaroring',
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
    turns: [
      {n:1,name:'La Source'},{n:2,name:'Eau Rouge'},{n:3,name:'Raidillon'},
      {n:4,name:'Kemmel Straight'},{n:5,name:'Les Combes'},{n:6,name:'Malmedy'},
      {n:7,name:'Bruxelles'},{n:8,name:'Rivage'},{n:9,name:'Paul FrÃ¨re / Double Gauche'},
      {n:10,name:'Pouhon'},{n:11,name:'Campus'},{n:12,name:'Fagnes'},
      {n:13,name:'Stavelot'},{n:14,name:'Courbe de Paul FrÃ¨re'},{n:16,name:'Blanchimont'},
      {n:17,name:'Bus Stop Chicane'},{n:18,name:'Bus Stop Chicane'},
    ],
  },
  'Zandvoort': {
    fullName: 'Circuit Zandvoort', location: 'Zandvoort, Netherlands',
    length: 4.259, corners: 14, drs: 2,
    lapRecord: { time: '1:11.097', driver: 'Lewis Hamilton', year: 2021 },
    wikiTitle: 'Circuit Zandvoort',
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
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3 / Uphill'},
      {n:4,name:'Castle Section'},{n:5,name:'Castle Corner'},{n:8,name:'Turn 8'},
      {n:10,name:'Turn 10'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
      {n:17,name:'Harbour Straight'},{n:18,name:'Turn 18'},{n:19,name:'Turn 19'},{n:20,name:'Turn 20'},
    ],
  },
  'Marina Bay': {
    fullName: 'Marina Bay Street Circuit', location: 'Singapore',
    length: 4.940, corners: 23, drs: 3,
    lapRecord: { time: '1:35.867', driver: 'Kevin Magnussen', year: 2018 },
    wikiTitle: 'Marina Bay Street Circuit',
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
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Esses'},
      {n:4,name:'Esses'},{n:5,name:'Esses'},{n:6,name:'Turn 6'},
      {n:7,name:'Turn 7'},{n:8,name:'Horquilla (Hairpin)'},{n:9,name:'Turn 9'},
      {n:11,name:'Turn 11'},{n:12,name:'Peraltada Entry'},{n:13,name:'Foro Sol / Stadium'},
      {n:14,name:' Stadium Section'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},{n:17,name:'Turn 17'},
    ],
  },
  'SÃ£o Paulo': {
    fullName: 'Autodromo Jose Carlos Pace', location: 'SÃ£o Paulo, Brazil',
    length: 4.309, corners: 15, drs: 2,
    lapRecord: { time: '1:10.540', driver: 'Valtteri Bottas', year: 2018 },
    wikiTitle: 'Autodromo Jose Carlos Pace',
    turns: [
      {n:1,name:'Curva 1 (Senna S)'},{n:2,name:'Curva 2 (Senna S)'},{n:3,name:'Curva do Sol'},
      {n:4,name:'Descida do Lago'},{n:5,name:'Ferradura'},{n:6,name:'Laranjinha'},
      {n:7,name:'Pinheirinho'},{n:8,name:'Bico de Pato'},{n:9,name:'Mergulho'},
      {n:10,name:'JunÃ§Ã£o'},{n:11,name:'Subida dos Boxes'},{n:12,name:'Curva do Leque'},
      {n:13,name:'Arquibancadas'},{n:14,name:'Reta Oposta'},{n:15,name:'JuncÃ£o'},
    ],
  },
  'Las Vegas': {
    fullName: 'Las Vegas Street Circuit', location: 'Las Vegas, Nevada, USA',
    length: 6.201, corners: 17, drs: 3,
    lapRecord: { time: '1:35.490', driver: 'Oscar Piastri', year: 2024 },
    wikiTitle: 'Las Vegas Street Circuit',
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
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
    ],
  },
  'Abu Dhabi': {
    fullName: 'Yas Marina Circuit', location: 'Yas Island, Abu Dhabi, UAE',
    length: 5.281, corners: 16, drs: 2,
    lapRecord: { time: '1:26.103', driver: 'Max Verstappen', year: 2021 },
    wikiTitle: 'Yas Marina Circuit',
    turns: [
      {n:1,name:'Turn 1'},{n:2,name:'Turn 2'},{n:3,name:'Turn 3'},{n:4,name:'Turn 4'},
      {n:5,name:'Turn 5'},{n:6,name:'Turn 6'},{n:7,name:'Turn 7'},{n:8,name:'Turn 8'},
      {n:9,name:'Turn 9'},{n:10,name:'Turn 10'},{n:11,name:'Turn 11'},{n:12,name:'Turn 12'},
      {n:13,name:'Turn 13'},{n:14,name:'Turn 14'},{n:15,name:'Turn 15'},{n:16,name:'Turn 16'},
    ],
  },
};

let scheduleData  = null;
let scheduleLoading = false;
let selectedMeeting = null;

function loadSchedule() {
  if (scheduleData) { renderScheduleList(); return; }
  if (scheduleLoading) return;
  scheduleLoading = true;
  const view = document.getElementById('schedule-view');
  view.innerHTML = `<div class="schedule-loading"><div class="spinner"></div><span>Loading race scheduleâ€¦</span></div>`;
  fetch(`${API_URL}/api/schedule`)
    .then(r => r.json())
    .then(data => {
      scheduleLoading = false;
      scheduleData = data;
      renderScheduleList();
    })
    .catch(err => {
      scheduleLoading = false;
      const view = document.getElementById('schedule-view');
      if (view) view.innerHTML = `<div class="schedule-loading" style="color:var(--red)">Failed to load schedule: ${err.message}</div>`;
    });
}

function renderScheduleList() {
  selectedMeeting = null;
  const view = document.getElementById('schedule-view');
  if (!view || !scheduleData) return;

  const meetings = scheduleData.meetings || [];
  const year     = scheduleData.year || new Date().getFullYear();

  const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:11px;color:var(--text-3);letter-spacing:1px;font-weight:700">${year} FORMULA 1 CALENDAR</span>
      <span style="font-size:10px;color:var(--text-3)">${meetings.length} rounds</span>
    </div>
    <div class="schedule-grid">
      ${meetings.map((m, i) => {
        const raceDate = m.race_date ? new Date(m.race_date) : null;
        const dateStr  = raceDate ? raceDate.toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : 'â€”';
        const cls = m.is_past ? 'sched-card past' : m.is_next ? 'sched-card next-race' : 'sched-card';
        const nextBadge = m.is_next ? '<span class="sched-next-badge">NEXT</span>' : '';
        const shortName = m.circuit_short_name || m.country_name || '';
        return `<div class="${cls}" onclick="showTrackDetail(${i})">
          <div class="sched-round">RD ${i + 1} Â· ${m.country_name || ''}${nextBadge}</div>
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
  const meetings = scheduleData?.meetings || [];
  const m = meetings[idx];
  if (!m) return;
  selectedMeeting = m;

  const shortName = m.circuit_short_name || '';
  const circuit   = CIRCUIT_DB[shortName] || {};

  const raceDate = m.race_date ? new Date(m.race_date) : null;
  const raceDateFull = raceDate
    ? raceDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'long', year:'numeric' })
    : 'â€”';

  const roundNum = (scheduleData?.meetings || []).indexOf(m) + 1;

  // Sessions list
  const sessionsHTML = (m.sessions || []).map(s => {
    const d = s.date_start ? new Date(s.date_start) : null;
    const timeStr = d ? d.toLocaleString('en-GB', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : 'â€”';
    const isRace = s.session_type === 'Race';
    return `<div class="track-session-item">
      <span class="track-session-name${isRace ? ' is-race' : ''}">${s.session_name || s.session_type}</span>
      <span class="track-session-date">${timeStr}</span>
    </div>`;
  }).join('');

  // Stats
  const statsHTML = `
    <div class="track-stats">
      <div class="track-stat">
        <div class="track-stat-label">CIRCUIT LENGTH</div>
        <div class="track-stat-value">${circuit.length || 'â€”'}<span class="track-stat-unit"> km</span></div>
      </div>
      <div class="track-stat">
        <div class="track-stat-label">CORNERS</div>
        <div class="track-stat-value">${circuit.corners || 'â€”'}</div>
      </div>
      <div class="track-stat">
        <div class="track-stat-label">DRS ZONES</div>
        <div class="track-stat-value">${circuit.drs || 'â€”'}</div>
      </div>
      <div class="track-stat">
        <div class="track-stat-label">FIRST GP</div>
        <div class="track-stat-value" style="font-size:11px">${circuit.firstGp || (raceDate ? raceDate.getFullYear() : 'â€”')}</div>
      </div>
    </div>
  `;

  // Lap record
  const lr = circuit.lapRecord;
  const lapRecordHTML = lr ? `
    <div class="track-lap-record">
      <div class="track-lr-label">âš¡ LAP RECORD</div>
      <div class="track-lr-time">${lr.time}</div>
      <div class="track-lr-driver">${lr.driver} Â· ${lr.year}</div>
    </div>
  ` : '';

  // Corners
  const corners = circuit.turns || [];
  const cornersHTML = corners.length ? `
    <div class="track-corners">
      <div class="track-corners-title">ðŸ”€ Corner Names</div>
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
      <button class="track-detail-back" onclick="renderScheduleList()">â† Back to Calendar</button>

      <div class="track-detail-header">
        <div class="track-detail-titles">
          <div class="track-detail-round">ROUND ${roundNum} Â· ${scheduleData.year}</div>
          <div class="track-detail-name">${(m.meeting_name || '').replace(' Grand Prix', '')} Grand Prix</div>
          <div class="track-detail-circuit">${circuit.fullName || shortName}</div>
          <div class="track-detail-location">ðŸ“ ${circuit.location || m.location || m.country_name}</div>
        </div>
        <div class="track-detail-date-block">
          <div class="track-detail-race-date">${raceDate ? raceDate.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : 'â€”'}</div>
          <div class="track-detail-race-label">RACE DAY</div>
          <div style="font-size:9px;color:var(--text-3);margin-top:2px">${raceDate ? raceDate.toLocaleDateString('en-GB',{year:'numeric'}) : ''}</div>
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
        </div>
      </div>
    </div>
  `;

  if (circuit.wikiTitle) {
    fetchWikiImage(circuit.wikiTitle).then(imgUrl => {
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
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• BOOT â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
document.getElementById('historical-banner-close')?.addEventListener('click', hideHistoricalBanner);

connectWS();

setTimeout(async () => {
  if (Object.keys(state.DriverList).length > 0) return;
  try {
    const r = await fetch(`${API_URL}/api/historical`);
    if (!r.ok) return;
    const msg = await r.json();
    if (msg.type === 'historical') { processHistorical(msg.data); setTimeout(renderAll, 0); }
  } catch (e) { console.warn('Historical HTTP fetch failed:', e); }
}, 2000);

