"""Argus CV/ML service.

  POST /analyze/driver  {image: dataURL|base64}  -> drowsiness via MediaPipe FaceMesh Eye Aspect Ratio
  POST /analyze/zone    {image}                  -> people in hazard zone via OpenCV HOG pedestrian detector
  POST /predict         {task features}          -> RandomForest task-time estimate (minutes)
  POST /score           {features}               -> ML proficiency score (prof-v1)
  POST /report/pdf      {shift report JSON}      -> end-of-shift PDF with charts
  GET  /health

Run:  uvicorn main:app --port 8001
"""
from __future__ import annotations

import base64
import time
from collections import deque
from pathlib import Path
from typing import Optional

import cv2
import joblib
import numpy as np
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import report_pdf
import score_model
import train_eta
import train_proficiency

HERE = Path(__file__).parent

# ----------------------------------------------------------------------------------------------
# Face landmarks: MediaPipe FaceMesh (legacy solutions API) -> MediaPipe Tasks FaceLandmarker
# (needs face_landmarker.task next to this file) -> OpenCV Haar eye-cascade fallback.
# ----------------------------------------------------------------------------------------------
FACE_BACKEND = "haar"
face_mesh = None
face_landmarker = None
try:
    import mediapipe as mp

    if hasattr(mp, "solutions") and hasattr(mp.solutions, "face_mesh"):
        face_mesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1, refine_landmarks=False, min_detection_confidence=0.5, min_tracking_confidence=0.5
        )
        FACE_BACKEND = "mediapipe_facemesh"
    elif (HERE / "face_landmarker.task").exists():
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision

        face_landmarker = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(HERE / "face_landmarker.task")), num_faces=1
            )
        )
        FACE_BACKEND = "mediapipe_tasks"
except Exception as e:  # noqa: BLE001
    print(f"[cv] MediaPipe unavailable ({e}); using Haar fallback")

haar_face = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
haar_eye = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye_tree_eyeglasses.xml")
haar_upper = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_upperbody.xml")

hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

# FaceMesh landmark indices: [p1, p2, p3, p4, p5, p6] per eye
LEFT_EYE = [362, 385, 387, 263, 373, 380]
RIGHT_EYE = [33, 160, 158, 133, 153, 144]

DROWSY_SECONDS = 1.5  # sustained closure => drowsiness


class DrowsinessTracker:
    """Temporal state: EAR must stay below an adaptive threshold for DROWSY_SECONDS."""

    def __init__(self):
        self.history: deque[float] = deque(maxlen=90)
        self.closed_since: float | None = None

    def threshold(self) -> float:
        if len(self.history) < 15:
            return 0.21
        open_baseline = float(np.percentile(self.history, 85))
        return float(np.clip(0.72 * open_baseline, 0.15, 0.26))

    def update(self, eyes_closed: bool, ear: float | None) -> tuple[float, bool]:
        now = time.time()
        if ear is not None and not eyes_closed:
            self.history.append(ear)
        if eyes_closed:
            self.closed_since = self.closed_since or now
        else:
            self.closed_since = None
        closed = now - self.closed_since if self.closed_since else 0.0
        return closed, closed >= DROWSY_SECONDS


tracker = DrowsinessTracker()


def decode(image: str) -> np.ndarray:
    if "," in image[:100]:
        image = image.split(",", 1)[1]
    buf = np.frombuffer(base64.b64decode(image), np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(400, "could not decode image")
    return frame


def ear_from_points(pts: np.ndarray) -> float:
    p1, p2, p3, p4, p5, p6 = pts
    return float((np.linalg.norm(p2 - p6) + np.linalg.norm(p3 - p5)) / (2.0 * np.linalg.norm(p1 - p4) + 1e-6))


def landmarks_xy(frame: np.ndarray) -> np.ndarray | None:
    h, w = frame.shape[:2]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    if face_mesh is not None:
        res = face_mesh.process(rgb)
        if not res.multi_face_landmarks:
            return None
        return np.array([[p.x * w, p.y * h] for p in res.multi_face_landmarks[0].landmark])
    if face_landmarker is not None:
        res = face_landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        if not res.face_landmarks:
            return None
        return np.array([[p.x * w, p.y * h] for p in res.face_landmarks[0]])
    return None


# ----------------------------------------------------------------------------------------------
app = FastAPI(title="Argus CV/ML service")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

eta_model = joblib.load(train_eta.MODEL_PATH) if train_eta.MODEL_PATH.exists() else train_eta.train()
# Proficiency scorer: trained on a simulated fleet (see train_proficiency.py); the web app falls back to computeScore() if /score fails.
prof_model = score_model.load() if score_model.MODEL_PATH.exists() else train_proficiency.train(verbose=False)


class ImageIn(BaseModel):
    image: str


class ScoreIn(BaseModel):
    operator_id: Optional[str] = None
    features: dict[str, Optional[float]]  # null / missing features are handled by the model


class EtaIn(BaseModel):
    task_type: str
    target_cycles: float
    experience_years: float
    assistance_score: float
    machine_age_years: float
    machine_type: str
    weather: str
    temperature_c: float


@app.get("/health")
def health():
    return {"ok": True, "face_backend": FACE_BACKEND, "person_detector": "opencv_hog", "eta_model": "random_forest", "score_model": score_model.VERSION}


@app.post("/analyze/driver")
def analyze_driver(body: ImageIn):
    frame = decode(body.image)
    h, w = frame.shape[:2]
    ear = None
    face_box = None
    eyes_closed = False
    face_found = False

    pts = landmarks_xy(frame)
    if pts is not None:
        face_found = True
        ear = (ear_from_points(pts[LEFT_EYE]) + ear_from_points(pts[RIGHT_EYE])) / 2.0
        eyes_closed = ear < tracker.threshold()
        x0, y0 = pts.min(axis=0)
        x1, y1 = pts.max(axis=0)
        face_box = [x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h]
        method = FACE_BACKEND
    else:
        method = FACE_BACKEND
        if FACE_BACKEND == "haar":
            gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
            faces = haar_face.detectMultiScale(gray, 1.2, 5, minSize=(80, 80))
            if len(faces):
                fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
                face_found = True
                face_box = [fx / w, fy / h, fw / w, fh / h]
                roi = gray[fy : fy + fh // 2, fx : fx + fw]
                eyes = haar_eye.detectMultiScale(roi, 1.1, 6, minSize=(fw // 10, fw // 10))
                eyes_closed = len(eyes) == 0
                ear = 0.3 if not eyes_closed else 0.12  # proxy value for display only

    closed_s, drowsy = tracker.update(eyes_closed, ear if face_found else None)
    if not face_found:
        tracker.closed_since = None
        closed_s, drowsy = 0.0, False
    return {
        "face_found": face_found,
        "ear": round(ear, 3) if ear is not None else None,
        "threshold": round(tracker.threshold(), 3),
        "eyes_closed": eyes_closed,
        "closed_seconds": round(closed_s, 2),
        "drowsy": drowsy,
        "face_box": face_box,
        "method": method,
    }


def _nms(boxes: list[list[float]], scores: list[float], thr: float = 0.4) -> list[int]:
    if not boxes:
        return []
    idx = cv2.dnn.NMSBoxes([list(map(int, b)) for b in boxes], scores, 0.0, thr)
    return [int(i) for i in np.array(idx).flatten()]


@app.post("/analyze/zone")
def analyze_zone(body: ImageIn):
    frame = decode(body.image)
    scale = 640.0 / frame.shape[1]
    if scale < 1:
        frame = cv2.resize(frame, None, fx=scale, fy=scale)
    H, W = frame.shape[:2]

    boxes, scores, kinds = [], [], []
    rects, weights = hog.detectMultiScale(frame, winStride=(8, 8), padding=(8, 8), scale=1.05)
    for (x, y, w, h), s in zip(rects, np.array(weights).flatten()):
        if s > 0.4:
            boxes.append([x, y, w, h]); scores.append(float(s)); kinds.append("hog_fullbody")

    # Close-range supplement: at < ~3 m a full body doesn't fit in frame, so HOG misses it.
    gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    for (x, y, w, h) in haar_upper.detectMultiScale(gray, 1.1, 4, minSize=(int(W * 0.25), int(H * 0.25))):
        boxes.append([x, y, w, h]); scores.append(0.5); kinds.append("haar_upperbody")

    persons = []
    for i in _nms(boxes, scores):
        x, y, w, h = boxes[i]
        frac = h / H
        # Pinhole approximation: ~1.7 m person (0.9 m for upper body), vertical FOV ~55 deg
        real_h = 1.7 if kinds[i] == "hog_fullbody" else 0.9
        distance = real_h * 0.96 / max(frac, 1e-3)
        persons.append({
            "box": [x / W, y / H, w / W, h / H],
            "score": round(scores[i], 2),
            "detector": kinds[i],
            "distance_m": round(float(distance), 1),
        })
    persons.sort(key=lambda p: p["distance_m"])
    return {"persons": persons, "min_distance_m": persons[0]["distance_m"] if persons else None}


@app.post("/predict")
def predict(body: EtaIn):
    row = body.model_dump()
    minutes = float(eta_model.predict([train_eta.encode(row)])[0])
    return {"minutes": round(minutes, 1)}


@app.post("/score")
def score(body: ScoreIn):
    return score_model.score(prof_model, body.features)


@app.post("/report/pdf")
def report_pdf_endpoint(report: dict):
    """End-of-shift report (JSON built by the web app) -> 3-page PDF with charts."""
    return Response(content=report_pdf.build_pdf(report), media_type="application/pdf")
