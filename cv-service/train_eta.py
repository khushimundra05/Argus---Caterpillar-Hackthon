"""Train the task-time RandomForestRegressor on synthetic data and pickle it.

Run once:  python train_eta.py   (main.py also calls train() automatically if the pickle is missing)
The generating formula mirrors web/src/lib/eta.ts heuristicMinutes() so the offline fallback agrees.
"""
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split

MODEL_PATH = Path(__file__).parent / "eta_model.pkl"

TASK_TYPES = ["trenching", "truck_loading", "backfill", "grading", "stockpiling"]
BASE_MIN_PER_CYCLE = {"trenching": 1.5, "truck_loading": 1.25, "backfill": 1.3, "grading": 1.6, "stockpiling": 1.45}
WEATHER = ["clear", "rain", "heavy_rain", "dust", "snow"]
WEATHER_MULT = {"clear": 1.0, "rain": 1.18, "heavy_rain": 1.4, "dust": 1.12, "snow": 1.35}
MACHINE_TYPES = ["Hydraulic Excavator", "Wheel Loader", "Track-Type Tractor"]
MACHINE_MULT = {"Hydraulic Excavator": 1.0, "Wheel Loader": 0.97, "Track-Type Tractor": 1.04}

FEATURES = ["task_type", "target_cycles", "experience_years", "assistance_score",
            "machine_age_years", "machine_type", "weather", "temperature_c"]


def encode(row: dict) -> list[float]:
    """One-hot categoricals + numerics, fixed column order."""
    vec = [1.0 if row["task_type"] == t else 0.0 for t in TASK_TYPES]
    vec += [1.0 if row["weather"] == w else 0.0 for w in WEATHER]
    vec += [1.0 if row["machine_type"] == m else 0.0 for m in MACHINE_TYPES]
    vec += [float(row["target_cycles"]), float(row["experience_years"]), float(row["assistance_score"]),
            float(row["machine_age_years"]), float(row["temperature_c"])]
    return vec


def synth(n: int = 6000, seed: int = 7):
    rng = np.random.default_rng(seed)
    X, y = [], []
    for _ in range(n):
        row = {
            "task_type": rng.choice(TASK_TYPES),
            "target_cycles": int(rng.integers(10, 60)),
            "experience_years": float(rng.gamma(2.0, 3.0)),
            "assistance_score": float(rng.uniform(20, 100)),
            "machine_age_years": float(rng.uniform(0, 15)),
            "machine_type": rng.choice(MACHINE_TYPES),
            "weather": rng.choice(WEATHER, p=[0.55, 0.18, 0.07, 0.12, 0.08]),
            "temperature_c": float(rng.normal(22, 12)),
        }
        base = BASE_MIN_PER_CYCLE[row["task_type"]] * row["target_cycles"]
        skill = 1.35 - 0.3 * min(row["experience_years"] / 10, 1) - 0.1 * (row["assistance_score"] / 100)
        age = 1 + 0.015 * row["machine_age_years"]
        temp = 1.08 if row["temperature_c"] > 35 or row["temperature_c"] < 0 else 1.0
        minutes = base * skill * age * WEATHER_MULT[row["weather"]] * temp * MACHINE_MULT[row["machine_type"]]
        minutes *= rng.normal(1.0, 0.06)  # operational noise
        X.append(encode(row))
        y.append(minutes)
    return np.array(X), np.array(y)


def train():
    X, y = synth()
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0)
    model = RandomForestRegressor(n_estimators=120, max_depth=14, min_samples_leaf=3, n_jobs=-1, random_state=0)
    model.fit(Xtr, ytr)
    mae = float(np.mean(np.abs(model.predict(Xte) - yte)))
    joblib.dump(model, MODEL_PATH)
    print(f"[eta] trained RandomForest on {len(X)} synthetic tasks, test MAE = {mae:.2f} min -> {MODEL_PATH.name}")
    return model


if __name__ == "__main__":
    train()
