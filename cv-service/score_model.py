"""Argus proficiency scorer (prof-v1): serving side.

score = 100 * (1 - p), where p = calibrated P(safety incident in the operator's next 5 shifts).
Training lives in train_proficiency.py; this module only loads the bundle and scores one request.
Local CPU only, no network. Typical latency is a few ms.
"""
from __future__ import annotations

from pathlib import Path

import joblib
import numpy as np

HERE = Path(__file__).parent
MODEL_PATH = HERE / "prof_model.pkl"
VERSION = "prof-v1"

# Exact names the web app sends. Order = model column order.
FEATURES = [
    "experience_years", "shifts_completed",
    "seatbelt_incidents_7d", "proximity_incidents_7d", "safety_incidents_14d_weighted",
    "pct_corrected_fast", "median_seconds_to_correct",
    "drowsiness_shift", "drowsiness_7d",
    "idle_anomalies_7d", "excessive_idle_7d", "repeated_seatbelt_7d",
    "nudges_acted_on_shift", "safe_streaks_shift",
    "idle_ratio_shift", "idle_z_shift", "fuel_per_cycle", "cycles_per_engine_hour",
    "mean_overrun_pct_7d", "on_time_rate_7d",
    "modules_completed", "modules_after_incident",
    "machine_age_years", "bad_weather_share",
]

# Direction of each feature's effect on RISK (+1 raises risk, -1 lowers it, 0 unconstrained).
# Score is 100*(1-p), so +1 features can only push the score down and -1 features only up.
MONOTONE_RISK = {
    "experience_years": -1, "shifts_completed": -1,
    "seatbelt_incidents_7d": 1, "proximity_incidents_7d": 1, "safety_incidents_14d_weighted": 1,
    "pct_corrected_fast": -1, "median_seconds_to_correct": 1,
    "drowsiness_shift": 1, "drowsiness_7d": 1,
    "idle_anomalies_7d": 1, "excessive_idle_7d": 1, "repeated_seatbelt_7d": 1,
    "nudges_acted_on_shift": -1, "safe_streaks_shift": -1,
    "idle_ratio_shift": 1, "idle_z_shift": 1, "fuel_per_cycle": 0, "cycles_per_engine_hour": 0,
    "mean_overrun_pct_7d": 1, "on_time_rate_7d": -1,
    "modules_completed": -1, "modules_after_incident": -1,
    "machine_age_years": 0, "bad_weather_share": 1,
}


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def predict_risk(bundle: dict, X: np.ndarray) -> np.ndarray:
    """Calibrated P(incident in next 5 shifts). Platt scaling with slope > 0 keeps the model's monotonicity."""
    raw = np.clip(bundle["model"].predict_proba(X)[:, 1], 1e-6, 1 - 1e-6)
    a, b = bundle["calib"]
    return _sigmoid(a * np.log(raw / (1 - raw)) + b)


def load(path: Path = MODEL_PATH) -> dict:
    return joblib.load(path)


def score(bundle: dict, features: dict) -> dict:
    """Score one operator. Missing or null features are passed to the model as NaN."""
    feats = bundle["features"]
    ref = np.asarray(bundle["reference"], dtype=float)
    x = np.array([np.nan if features.get(f) is None else float(features[f]) for f in feats], dtype=float)

    # Row 0 = the operator; row i+1 = the operator with feature i set to the typical (median) operator's value.
    X = np.tile(x, (len(feats) + 1, 1))
    for i in range(len(feats)):
        X[i + 1, i] = ref[i]
    p = predict_risk(bundle, X)

    contributions = []
    for i, f in enumerate(feats):
        if np.isnan(x[i]):
            continue  # unknown feature: nothing to attribute
        delta = 100.0 * (p[0] - p[i + 1]) * -1.0  # score points vs. a typical value of this feature
        if abs(delta) >= 0.05:
            contributions.append({"feature": f, "delta": round(float(delta), 1)})
    contributions.sort(key=lambda c: -abs(c["delta"]))

    risk = float(p[0])
    return {
        "score": int(round(max(0.0, min(100.0, 100.0 * (1 - risk))))),
        "incident_risk": round(risk, 3),
        "contributions": contributions,
        "model_version": bundle.get("version", VERSION),
        "bands": bundle.get("bands"),  # mode lower bounds tuned to this model (see train_proficiency.py)
    }
