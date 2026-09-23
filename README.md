# Argus: Smart Operator Assistant (CAT Hackathon prototype)

## Repo layout
```
argus/
├─ web/                 Next.js 14 app: dashboard, Training Hub, API routes, safety engine, agent
│  ├─ src/app/          pages + /api routes
│  ├─ src/components/   UI, camera panel, voice manager
│  ├─ src/lib/          engine.ts (rules), stats.ts (score/anomaly), agent.ts + tools.ts (LLM), db.ts (SQLite)
│  ├─ data/             SOP manuals (knowledge base) + training-modules.json
│  └─ public/training/  put featured.mp4 here (git-ignored)
├─ cv-service/          FastAPI: MediaPipe drowsiness, OpenCV HOG people detection, RandomForest ETA
└─ start-argus.ps1      launches both services
```
Not in git (created locally): `web/.env.local`, `web/argus.db`, `cv-service/.venv`, `cv-service/eta_model.pkl`, `cv-service/face_landmarker.task`, training video.

An AI co-pilot for CAT machine operators. It runs one continuous loop:
**OBSERVE → UNDERSTAND → PREDICT → ASSIST → LEARN**. Everything runs locally on a laptop. No GPU, no cloud infrastructure.

```
browser webcam(s) ──frames──▶ Next.js /api/cv ──▶ Python FastAPI :8001
                                   │                 ├─ MediaPipe FaceLandmarker → EAR → drowsiness
                                   │                 ├─ OpenCV HOG (+Haar upper-body) → people + distance
                                   │                 └─ RandomForestRegressor → task ETA
                                   ▼
                  Deterministic safety engine (engine.ts): seatbelt / proximity / drowsiness / idle
                                   │  auto-logs incidents on rising edge
                                   ▼
                  SQLite ◀── statistical layer (stats.ts): idle z-score, adaptive-assistance score
                                   ▼
                  Gemini Flash agent (agent.ts), READ-ONLY tools (tools.ts)
                                   ▼
                  Dashboard + chat + Training Hub, Web Speech API TTS (alerts interrupt speech)
```

## Run it (two terminals)

**1. CV/ML service** (Python 3.10+)
```powershell
cd cv-service
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn main:app --port 8001
```
The first start trains the RandomForest on synthetic data (about 5 s) and writes `eta_model.pkl`.

**Drowsiness model (recommended):** MediaPipe 1.x removed the legacy FaceMesh `solutions` API, so the service
uses the Tasks `FaceLandmarker` (the same 468-point FaceMesh). Download the model file (it's git-ignored):
```powershell
powershell -ExecutionPolicy Bypass -File cv-service\download_model.ps1
```
If the file is missing, the service falls back to OpenCV Haar eye detection. `GET :8001/health` shows which backend is active.

**2. Web app**
```powershell
cd web
npm install
copy .env.local.example .env.local   # then add GEMINI_API_KEY (free: aistudio.google.com/apikey)
npm run dev                          # http://localhost:3000
```
Without an API key, the assistant runs in **offline mode**: it calls the same read-only tools and uses templated, mode-aware replies, so the demo still works if the Wi-Fi drops.

**LLM: Gemini free tier.** The agent tries each model in `GEMINI_MODELS` in order (default: Flash-Lite models first, then Flash). Each model has its own free quota, so when one returns 429 the agent moves to the next, and falls back to offline mode only when all of them are exhausted. One question costs 1–3 calls: the first picks tools, the rest answer. `GET /api/health` shows calls made today per model. You can see your actual free limits at aistudio.google.com/rate-limit. On the free tier, Google may use prompts to improve its products, so keep real operator PII out.

`npm run reset-db` wipes SQLite. It reseeds on the next request.
Or run `start-argus.ps1` from the repo root to launch both.

## Demo script (about 3 minutes)
1. **Operator switcher:** Ravi (Silent Guardian 100), Maya (Assist about 78), Sam (Coaching 51). The mode badge shows the score, and the score card shows the exact formula terms.
2. **Start a task:** the engine turns on, load cycles count up, and the RandomForest ETA appears. Change the weather to `heavy_rain` and the ETA re-predicts live (logged in the Intelligence loop feed).
3. **Seatbelt:** click *Seatbelt → UNFASTENED*. You get a red banner and a spoken alert that interrupts any other speech. The incident is auto-logged, the score drops, and the mode may change (announced by voice).
4. **Drowsiness:** turn on the driver camera and close your eyes for about 2 s. EAR drops below the adaptive threshold and triggers a DROWSINESS alert.
5. **Proximity:** turn on the zone camera and step back 2–4 m so your full body is visible. HOG gives a distance estimate, with a warning under 6 m and critical under 3 m. You can also use the proximity sensor buttons.
6. **Idle cost:** click *Operator waiting*. After 20 s a live $/h fuel-burn nudge is spoken. Keep idling and the idle z-score crosses 2σ vs. this operator's baseline, which logs an IDLE_ANOMALY flag and lowers the score.
7. **Ask Argus:** "Am I safe to continue?" or "How long until this task is done?" Switch to Sam and ask again: same tools, very different tone and length.
8. **Training Hub:** recommendations are ranked from the incidents you just caused. The featured video slot is at the top. Take the quiz, then mark the module complete.

## Adding your training video
Drop an MP4 at **`web/public/training/featured.mp4`** and reload the Training Hub.
To use a different filename or title, edit the `TM-VIDEO` entry in `web/data/training-modules.json`.
Before the file is in place, the slot has a "Preview a local video file" button.

## Safety design
- `engine.ts` is the **only** writer of alerts and incidents. The inputs are the simulated sensors and CV results, which are ingested server-side from the Python service, not claimed by the client.
- The LLM's tools (`tools.ts`) are all read-only. `log_incident` is deliberately not a tool.
- The system prompt forbids the model from clearing, downgrading, or dismissing alerts. Alert voice lines are fixed client-side templates. The mode only changes their verbosity, never whether they play.

## Key thresholds (`web/src/lib/config.ts`)
Proximity: critical under 3 m, warning under 6 m. Drowsiness: eyes closed ≥ 1.5 s (in `cv-service/main.py`). Idle nudge: 20 s. Idle warning: 60 s. Idle anomaly: z > 2.0 over a 30-sample rolling window. Tuned short for a live demo.
