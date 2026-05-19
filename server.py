import asyncio
import datetime
import json
import logging
import threading
import time
from typing import List

import requests
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from fastapi.responses import JSONResponse
# pyrefly: ignore [missing-import]
from signalrcore.messages.completion_message import CompletionMessage
# pyrefly: ignore [missing-import]
from fastf1.livetiming.client import SignalRClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("f1-server")

OPENF1 = "https://api.openf1.org/v1"

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        logger.info(f"Client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: str):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Failed to send message: {e}")
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()
loop = None

historical_payload: str | None = None
serving_historical: bool = False
last_race_finishing_order: list = []
championship_cache: dict | None = None


# ── OpenF1 helpers ───────────────────────────────────────────────────────────

def openf1(path: str, params: dict | None = None) -> list:
    url = f"{OPENF1}{path}"
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def format_lap_time(seconds) -> str:
    """Convert float seconds to 'M:SS.mmm' string."""
    if seconds is None or seconds != seconds or seconds <= 0:
        return ""
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes}:{secs:06.3f}"


def format_sector(seconds) -> str:
    """Convert float seconds to 'SS.mmm' string."""
    if not seconds or seconds <= 0:
        return ""
    return f"{seconds:.3f}"


def is_session_live_or_imminent() -> bool:
    """Return True if any F1 session is live or starting within 30 min."""
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        sessions = openf1("/sessions", {"year": now.year})
        for s in sessions:
            start_str = s.get("date_start") or ""
            end_str = s.get("date_end") or ""
            if not start_str or not end_str:
                continue
            start_dt = datetime.datetime.fromisoformat(start_str).astimezone(datetime.timezone.utc)
            end_dt = datetime.datetime.fromisoformat(end_str).astimezone(datetime.timezone.utc)
            if (start_dt - datetime.timedelta(minutes=30)) <= now <= (end_dt + datetime.timedelta(minutes=30)):
                logger.info("Live/imminent session: %s %s", s.get("session_name"), s.get("date_start"))
                return True
    except Exception as exc:
        logger.warning("Could not check live session via OpenF1: %s", exc)
    return False


def load_last_completed_race() -> str | None:
    """Fetch the last completed race from OpenF1 and return a historical JSON payload."""
    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        year = now.year

        # ── Find last completed race session ─────────────────────────────────
        sessions = openf1("/sessions", {"year": year, "session_type": "Race"})
        past = [s for s in sessions
                if s.get("date_end") and
                datetime.datetime.fromisoformat(s["date_end"]).astimezone(datetime.timezone.utc) < now]

        if not past:
            logger.info("No past Race sessions in %d, trying %d", year, year - 1)
            sessions = openf1("/sessions", {"year": year - 1, "session_type": "Race"})
            past = sessions
            year -= 1

        if not past:
            logger.warning("No past Race sessions found.")
            return None

        session = past[-1]
        session_key = session["session_key"]
        meeting_key = session["meeting_key"]
        session_name = session.get("session_name", "Race")
        logger.info("Loading historical data from OpenF1: session_key=%s", session_key)

        # ── Meeting name ─────────────────────────────────────────────────────
        meetings = openf1("/meetings", {"meeting_key": meeting_key})
        meeting_name = meetings[0].get("meeting_name", "Grand Prix") if meetings else "Grand Prix"

        # ── Fetch all race data ──────────────────────────────────────────────
        drivers      = openf1("/drivers",      {"session_key": session_key})
        laps         = openf1("/laps",         {"session_key": session_key})
        pits         = openf1("/pit",          {"session_key": session_key})
        stints       = openf1("/stints",       {"session_key": session_key})
        weather_list = openf1("/weather",      {"session_key": session_key})
        race_control = openf1("/race_control", {"session_key": session_key})

        return _build_historical_payload(
            session_key, session_name, meeting_name, year,
            drivers, laps, pits, stints,
            weather_list, race_control,
        )

    except Exception as exc:
        logger.error("Failed to load historical race data: %s", exc, exc_info=True)
        return None


def _build_historical_payload(
    session_key, session_name, meeting_name, year,
    drivers, laps, pits, stints,
    weather_list, race_control,
) -> str:

    # ── DriverList ───────────────────────────────────────────────────────────
    driver_list = {}
    for d in drivers:
        num = str(d["driver_number"])
        driver_list[num] = {
            "Tla":        d.get("name_acronym", ""),
            "FirstName":  d.get("first_name", ""),
            "LastName":   d.get("last_name", ""),
            "TeamName":   d.get("team_name", ""),
            "TeamColour": (d.get("team_colour") or "888888").lstrip("#"),
        }

    # ── Stints per driver ────────────────────────────────────────────────────
    stints_map: dict[str, list] = {}
    for s in sorted(stints, key=lambda x: x.get("stint_number", 0)):
        num = str(s["driver_number"])
        compound = (s.get("compound") or "").upper()
        if compound:
            stints_map.setdefault(num, []).append({
                "Compound": compound,
                "LapStart": s.get("lap_start") or 0,
                "LapEnd": s.get("lap_end") or 0,
            })

    # ── Laps per driver ──────────────────────────────────────────────────────
    laps_by_driver: dict[str, list] = {}
    for lap in laps:
        laps_by_driver.setdefault(str(lap["driver_number"]), []).append(lap)

    # ── Pit count per driver ─────────────────────────────────────────────────
    pit_count_map: dict[str, int] = {}
    for p in pits:
        num = str(p["driver_number"])
        pit_count_map[num] = pit_count_map.get(num, 0) + 1

    # ── Best and last valid lap times ────────────────────────────────────────
    best_laps: dict[str, float] = {}
    last_laps: dict[str, float] = {}
    last_lap_date: dict[str, str] = {}  # for position sorting
    for num, driver_laps in laps_by_driver.items():
        valid = [l["lap_duration"] for l in driver_laps
                 if l.get("lap_duration") and l["lap_duration"] > 0]
        if valid:
            best_laps[num] = min(valid)
        sorted_laps = sorted(driver_laps, key=lambda x: x.get("lap_number", 0))
        for lap in reversed(sorted_laps):
            if lap.get("lap_duration") and lap["lap_duration"] > 0:
                last_laps[num] = lap["lap_duration"]
                last_lap_date[num] = lap.get("date_start", "")
                break

    # ── Overall fastest driver ───────────────────────────────────────────────
    fastest_num = min(best_laps, key=best_laps.get) if best_laps else None

    # ── Best/last sector times per driver ────────────────────────────────────
    best_s1: dict[str, float] = {}
    best_s2: dict[str, float] = {}
    best_s3: dict[str, float] = {}
    last_s1: dict[str, float] = {}
    last_s2: dict[str, float] = {}
    last_s3: dict[str, float] = {}
    for num, driver_laps in laps_by_driver.items():
        sl = sorted(driver_laps, key=lambda x: x.get("lap_number", 0))
        sv1 = [l["duration_sector_1"] for l in sl if l.get("duration_sector_1") and l["duration_sector_1"] > 0]
        sv2 = [l["duration_sector_2"] for l in sl if l.get("duration_sector_2") and l["duration_sector_2"] > 0]
        sv3 = [l["duration_sector_3"] for l in sl if l.get("duration_sector_3") and l["duration_sector_3"] > 0]
        if sv1: best_s1[num] = min(sv1)
        if sv2: best_s2[num] = min(sv2)
        if sv3: best_s3[num] = min(sv3)
        for lap in reversed(sl):
            if lap.get("duration_sector_1") and lap["duration_sector_1"] > 0:
                last_s1[num] = lap["duration_sector_1"]; break
        for lap in reversed(sl):
            if lap.get("duration_sector_2") and lap["duration_sector_2"] > 0:
                last_s2[num] = lap["duration_sector_2"]; break
        for lap in reversed(sl):
            if lap.get("duration_sector_3") and lap["duration_sector_3"] > 0:
                last_s3[num] = lap["duration_sector_3"]; break
    obs1 = min(best_s1.values()) if best_s1 else None
    obs2 = min(best_s2.values()) if best_s2 else None
    obs3 = min(best_s3.values()) if best_s3 else None

    # ── Derive final positions from lap counts ───────────────────────────────
    # More laps = higher finishing position; equal laps sorted by finish time.
    max_laps_per_driver = {
        num: max((l.get("lap_number", 0) for l in driver_laps), default=0)
        for num, driver_laps in laps_by_driver.items()
    }
    all_nums = {str(d["driver_number"]) for d in drivers}
    sorted_nums = sorted(
        all_nums,
        key=lambda n: (-max_laps_per_driver.get(n, 0), last_lap_date.get(n, ""))
    )
    leader_laps = max_laps_per_driver.get(sorted_nums[0], 0) if sorted_nums else 0

    # ── TimingData.Lines ─────────────────────────────────────────────────────
    timing_lines: dict[str, dict] = {}

    for i, num in enumerate(sorted_nums):
        driver_laps_count = max_laps_per_driver.get(num, 0)
        laps_down = leader_laps - driver_laps_count
        if i == 0:
            gap_str = "WINNER"
        elif laps_down > 0:
            gap_str = f"+{laps_down} LAP{'S' if laps_down > 1 else ''}"
        else:
            gap_str = "—"

        timing_lines[num] = {
            "Position":         str(i + 1),
            "GapToLeader":      gap_str,
            "NumberOfPitStops": pit_count_map.get(num, 0),
            "Stints":           stints_map.get(num, []),
            "BestLapTime": {
                "Value":          format_lap_time(best_laps.get(num)),
                "OverallFastest": num == fastest_num,
            },
            "LastLapTime": {
                "Value": format_lap_time(last_laps.get(num)),
            },
            "Interval":      "",
            "NumberOfLaps":  max_laps_per_driver.get(num, 0),
            "BestSectors": [
                {"Value": format_sector(best_s1.get(num)), "OverallFastest": best_s1.get(num) is not None and best_s1.get(num) == obs1},
                {"Value": format_sector(best_s2.get(num)), "OverallFastest": best_s2.get(num) is not None and best_s2.get(num) == obs2},
                {"Value": format_sector(best_s3.get(num)), "OverallFastest": best_s3.get(num) is not None and best_s3.get(num) == obs3},
            ],
            "LastSectors": [
                {"Value": format_sector(last_s1.get(num))},
                {"Value": format_sector(last_s2.get(num))},
                {"Value": format_sector(last_s3.get(num))},
            ],
        }

    # ── Intervals (gap to car ahead) ─────────────────────────────────────────
    prev_gap = 0.0
    for i, num in enumerate(sorted_nums):
        if i == 0:
            timing_lines[num]["Interval"] = "LEADER"
            continue
        raw = timing_lines[num].get("GapToLeader", "")
        if isinstance(raw, str) and raw.startswith("+") and "LAP" not in raw:
            try:
                gap_sec = float(raw[1:])
                intv = gap_sec - prev_gap
                timing_lines[num]["Interval"] = f"+{intv:.3f}"
                prev_gap = gap_sec
            except ValueError:
                timing_lines[num]["Interval"] = raw
        else:
            timing_lines[num]["Interval"] = raw

    # ── Store finishing order ──────────────────────────────────────────────────
    global last_race_finishing_order
    last_race_finishing_order = [
        {
            "num": num, "pos": i + 1,
            "tla": driver_list.get(num, {}).get("Tla", ""),
            "team": driver_list.get(num, {}).get("TeamName", ""),
            "full_name": f"{driver_list.get(num,{}).get('FirstName','')} {driver_list.get(num,{}).get('LastName','')}".strip(),
            "team_colour": driver_list.get(num, {}).get("TeamColour", "888888"),
        }
        for i, num in enumerate(sorted_nums)
    ]

    # ── WeatherData ──────────────────────────────────────────────────────────
    weather_out: dict = {}
    if weather_list:
        w = weather_list[-1]
        weather_out = {
            "AirTemp":       str(round(float(w.get("air_temperature")  or 0), 1)),
            "TrackTemp":     str(round(float(w.get("track_temperature") or 0), 1)),
            "Humidity":      str(round(float(w.get("humidity")          or 0), 1)),
            "WindSpeed":     str(round(float(w.get("wind_speed")        or 0), 1)),
            "WindDirection": str(round(float(w.get("wind_direction")    or 0))),
            "Rainfall":      "1" if w.get("rainfall") else "0",
        }

    # ── RaceControlMessages ──────────────────────────────────────────────────
    rc_messages = [
        {
            "Utc":      m.get("date", ""),
            "Message":  m.get("message", ""),
            "Flag":     m.get("flag", ""),
            "Category": m.get("category", ""),
        }
        for m in race_control
    ]

    # ── LapCount ─────────────────────────────────────────────────────────────
    all_lap_nums = [l["lap_number"] for l in laps if l.get("lap_number")]
    max_lap = max(all_lap_nums) if all_lap_nums else 0

    payload = {
        "DriverList":          driver_list,
        "TimingData":          {"Lines": timing_lines},
        "WeatherData":         weather_out,
        "RaceControlMessages": {"Messages": rc_messages},
        "SessionInfo": {
            "Meeting": {"Name": meeting_name},
            "Name":    session_name,
        },
        "LapCount":    {"CurrentLap": max_lap, "TotalLaps": max_lap},
        "TrackStatus": {"Status": "1", "Message": "AllClear"},
        "_meta":       {"year": year, "eventName": meeting_name},
    }

    return json.dumps({"type": "historical", "data": payload})


# ── Championship helpers ──────────────────────────────────────────────────────

_F1_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]


def _compute_championship_sync() -> dict:
    """Fetch all completed race sessions for the year and compute standings."""
    now = datetime.datetime.now(datetime.timezone.utc)
    year = now.year
    sessions = openf1("/sessions", {"year": year, "session_type": "Race"})
    past = [s for s in sessions
            if s.get("date_end") and
            datetime.datetime.fromisoformat(s["date_end"]).astimezone(datetime.timezone.utc) < now]
    if not past:
        sessions = openf1("/sessions", {"year": year - 1, "session_type": "Race"})
        past = sessions

    driver_pts: dict[str, dict] = {}
    team_pts: dict[str, int] = {}

    for idx_s, session in enumerate(past):
        sk = session["session_key"]
        is_last = (idx_s == len(past) - 1)
        try:
            drivers = openf1("/drivers", {"session_key": sk})
            laps    = openf1("/laps",    {"session_key": sk})
        except Exception as exc:
            logger.warning("Skip session %s for championship: %s", sk, exc)
            continue

        laps_by_d: dict[str, list] = {}
        last_date: dict[str, str] = {}
        for lap in laps:
            laps_by_d.setdefault(str(lap["driver_number"]), []).append(lap)
        max_laps_d = {
            n: max((l.get("lap_number", 0) for l in dl), default=0)
            for n, dl in laps_by_d.items()
        }
        for n, dl in laps_by_d.items():
            for l in reversed(sorted(dl, key=lambda x: x.get("lap_number", 0))):
                if l.get("date_start"):
                    last_date[n] = l["date_start"]
                    break

        all_n = {str(d["driver_number"]) for d in drivers}
        sorted_n = sorted(all_n, key=lambda n: (-max_laps_d.get(n, 0), last_date.get(n, "")))
        dmap = {str(d["driver_number"]): d for d in drivers}

        for pos_i, num in enumerate(sorted_n):
            pts  = _F1_PTS[pos_i] if pos_i < 10 else 0
            d    = dmap.get(num, {})
            full = f"{d.get('first_name','')} {d.get('last_name','')}".strip() or f"#{num}"
            team = d.get("team_name") or "Unknown"
            tla  = d.get("name_acronym") or ""
            col  = (d.get("team_colour") or "888888").lstrip("#")

            if full not in driver_pts:
                driver_pts[full] = {"points": 0, "last_pts": 0, "team": team,
                                     "tla": tla, "colour": col, "last_pos": pos_i + 1}
            driver_pts[full]["points"] += pts
            if is_last:
                driver_pts[full]["last_pts"] = pts
                driver_pts[full]["last_pos"] = pos_i + 1
            team_pts[team] = team_pts.get(team, 0) + pts

    drv = sorted(driver_pts.items(), key=lambda x: -x[1]["points"])
    tms = sorted(team_pts.items(),   key=lambda x: -x[1])
    return {
        "drivers": [
            {
                "pos": i + 1, "name": n, "tla": d["tla"], "team": d["team"],
                "colour": d["colour"], "points": d["points"],
                "last_pts": d["last_pts"],
                "prior_pts": d["points"] - d["last_pts"],
                "last_pos": d["last_pos"],
            }
            for i, (n, d) in enumerate(drv)
        ],
        "teams": [
            {"pos": i + 1, "name": t, "points": p}
            for i, (t, p) in enumerate(tms)
        ],
    }


async def _load_championship_task():
    global championship_cache
    logger.info("Loading championship standings in background…")
    try:
        championship_cache = await asyncio.get_event_loop().run_in_executor(
            None, _compute_championship_sync
        )
        logger.info("Championship loaded: %d drivers", len(championship_cache.get("drivers", [])))
    except Exception as exc:
        logger.error("Championship load failed: %s", exc)
        championship_cache = {"error": str(exc), "drivers": [], "teams": []}


# ── SignalR Client ────────────────────────────────────────────────────────────

class BroadcastSignalRClient(SignalRClient):
    def __init__(self):
        super().__init__("dummy.txt", filemode='w', debug=False, timeout=60, logger=logger)

    def _run(self):
        class DummyFile:
            def write(self, data): pass
            def flush(self): pass
            def close(self): pass
        self._output_file = DummyFile()
        super()._run()
        self._output_file = DummyFile()

    def _on_message(self, msg):
        self._t_last_message = time.time()
        formatted = None

        if isinstance(msg, CompletionMessage):
            data = {key: msg.result[key] for key in msg.result.keys()}
            formatted = json.dumps({"type": "init", "data": data})
        elif isinstance(msg, list):
            formatted = json.dumps({"type": "feed", "data": msg})

        if formatted and loop:
            asyncio.run_coroutine_threadsafe(manager.broadcast(formatted), loop)


# ── HTTP endpoints ────────────────────────────────────────────────────────────

@app.get("/api/championship")
async def get_championship():
    if championship_cache is None:
        return JSONResponse(content={"status": "loading"}, status_code=202)
    return JSONResponse(content=championship_cache)


@app.get("/api/schedule")
async def get_schedule():
    now = datetime.datetime.now(datetime.timezone.utc)
    year = now.year
    try:
        meetings = openf1("/meetings", {"year": year})
        sessions = openf1("/sessions", {"year": year})
    except Exception as exc:
        return JSONResponse(content={"error": str(exc)}, status_code=500)

    sessions_by_meeting: dict[int, list] = {}
    for s in sessions:
        mk = s.get("meeting_key")
        if mk:
            sessions_by_meeting.setdefault(mk, []).append(s)

    results = []
    for m in sorted(meetings, key=lambda x: x.get("date_start", "")):
        mk = m.get("meeting_key")
        meeting_sessions = sessions_by_meeting.get(mk, [])
        race = next((s for s in meeting_sessions if s.get("session_type") == "Race"), None)
        if not race:
            continue
        race_date_str = race.get("date_start", "")
        try:
            race_date = datetime.datetime.fromisoformat(race_date_str).astimezone(datetime.timezone.utc)
        except Exception:
            continue
        is_next = False
        for r in results:
            if r.get("is_next"):
                break
        else:
            is_next = race_date > now

        results.append({
            "meeting_key": mk,
            "meeting_name": m.get("meeting_name", ""),
            "country_name": m.get("country_name", ""),
            "circuit_short_name": m.get("circuit_short_name", ""),
            "circuit_key": m.get("circuit_key"),
            "location": m.get("location", ""),
            "gmt_offset": m.get("gmt_offset", ""),
            "race_date": race_date_str,
            "is_past": race_date < now,
            "is_next": is_next,
            "sessions": sorted([
                {
                    "session_name": s.get("session_name"),
                    "session_type": s.get("session_type"),
                    "date_start": s.get("date_start"),
                    "date_end":   s.get("date_end"),
                }
                for s in meeting_sessions
            ], key=lambda x: x.get("date_start") or ""),
        })
    return JSONResponse(content={"meetings": results, "year": year})


@app.get("/api/historical")
async def get_historical():
    if historical_payload:
        return JSONResponse(content=json.loads(historical_payload))
    return JSONResponse(content={"type": "none"}, status_code=204)


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    if serving_historical and historical_payload:
        try:
            await websocket.send_text(historical_payload)
        except Exception as exc:
            logger.error("Failed to send historical payload: %s", exc)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ── Startup ───────────────────────────────────────────────────────────────────

def start_signalr_client():
    client = BroadcastSignalRClient()
    while True:
        try:
            logger.info("Starting SignalR Client...")
            client.start()
        except Exception as e:
            logger.error(f"SignalR client stopped: {e}")
        logger.info("Restarting SignalR Client in 5 seconds...")
        time.sleep(5)


@app.on_event("startup")
async def startup_event():
    global loop, historical_payload, serving_historical
    loop = asyncio.get_running_loop()

    if not is_session_live_or_imminent():
        logger.info("No live session — loading historical data from OpenF1...")
        serving_historical = True
        historical_payload = await loop.run_in_executor(None, load_last_completed_race)
        if historical_payload:
            logger.info("Historical data ready. Broadcasting to connected clients.")
            await manager.broadcast(historical_payload)
        else:
            logger.warning("Historical data load failed.")
            serving_historical = False
    else:
        logger.info("Live/imminent session detected — skipping historical load.")

    asyncio.create_task(_load_championship_task())

    thread = threading.Thread(target=start_signalr_client, daemon=True)
    thread.start()


if __name__ == "__main__":
    # pyrefly: ignore [import-outside-toplevel, missing-import]
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=False)
