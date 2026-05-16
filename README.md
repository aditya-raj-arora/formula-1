# F1 Live Race Dashboard

A real-time Formula 1 race dashboard that streams live telemetry, standings, lap times, pit stops, weather, and race control messages — powered by the [OpenF1 API](https://openf1.org) and [FastF1](https://github.com/theOehrly/Fast-F1).

## Features

- **Live standings** — driver positions updated in real time via WebSocket
- **Lap times & sector splits** — per-driver timing with fastest-lap highlights
- **Pit stop tracker** — live pit window and stop history
- **Weather data** — track temperature, air temperature, wind speed, and humidity
- **Race control messages** — flags, safety car, VSC, and steward notes
- **Session info** — current lap counter, session name, and circuit details

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python · FastAPI · Uvicorn |
| Live data | FastF1 SignalR client · OpenF1 REST API |
| Real-time transport | WebSockets |
| Frontend | Vanilla HTML / CSS / JavaScript |
| Fonts | Titillium Web · JetBrains Mono |

## Getting Started

### Prerequisites

- Python 3.10+
- A virtual environment (recommended)

### Installation

```bash
# Clone the repo
git clone https://github.com/NathanArsement/formula-1.git
cd formula-1

# Create and activate a virtual environment
python -m venv venv
# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### Running the server

```bash
uvicorn server:app --reload --port 8000
```

Then open `index.html` in your browser (or serve it with any static file server).  
The frontend connects to `ws://localhost:8000/ws` automatically.

## Project Structure

```
formula-1/
├── index.html        # Dashboard UI
├── styles.css        # Styling (F1-inspired dark theme)
├── app.js            # Frontend logic & WebSocket client
├── server.py         # FastAPI backend + SignalR/OpenF1 bridge
├── requirements.txt  # Python dependencies
└── f1_cache/         # FastF1 session cache (git-ignored)
```

## Data Sources

- **[OpenF1 API](https://openf1.org)** — free, open REST API for F1 data (positions, laps, pit stops, weather, race control)
- **[FastF1](https://github.com/theOehrly/Fast-F1)** — Python library providing a SignalR client for F1's live timing feed

## License

MIT
