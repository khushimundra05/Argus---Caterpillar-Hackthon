"""Extra evaluation of prof-v1 beyond train_proficiency.py: incident rate per assistance mode (model vs formula),
sensitivity to single events, and /score HTTP latency. Run with the service up:  python eval_proficiency.py
"""
import json, sys, time, urllib.request
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, ".")
import score_model as sm

b = sm.load()
df = pd.read_csv("synthetic_fleet.csv")
ops = df.operator_id.unique()
rng = np.random.default_rng(12)  # same split as train_proficiency.train(seed=11)
train_ops = set(rng.permutation(ops)[:160])
te = df[~df.operator_id.isin(train_ops)].reset_index(drop=True)
X = te[sm.FEATURES].to_numpy(float)
y = te["incident_next_5"].to_numpy() if "incident_next_5" in te else te["label"].to_numpy()
score = 100 * (1 - sm.predict_risk(b, X))
bands = b["bands"]

def mode(s):
    return np.where(s < bands["coaching"], "Instructor", np.where(s < bands["assist"], "Coaching", np.where(s < bands["silent_guardian"], "Assist", "Silent Guardian")))

out = {}
m = mode(score)
out["held_out_by_mode"] = {
    k: {"share": round(float((m == k).mean()), 3), "observed_incident_rate": round(float(y[m == k].mean()), 3)}
    for k in ["Instructor", "Coaching", "Assist", "Silent Guardian"]
}
fm = np.where(te.baseline_score < 40, "Instructor", np.where(te.baseline_score < 66, "Coaching", np.where(te.baseline_score < 86, "Assist", "Silent Guardian")))
out["formula_by_mode_same_rows"] = {
    k: {"share": round(float((fm == k).mean()), 3), "observed_incident_rate": round(float(y[fm == k].mean()) if (fm == k).any() else float("nan"), 3)}
    for k in ["Instructor", "Coaching", "Assist", "Silent Guardian"]
}

# Sensitivity: median held-out operator, add one event at a time
med = {f: (None if np.isnan(v) else float(v)) for f, v in zip(sm.FEATURES, np.nanmedian(X, axis=0))}
base_s = sm.score(b, med)["score"]
def bump(**kw):
    f = dict(med); f.update(kw); return sm.score(b, f)["score"] - base_s
out["sensitivity_points_from_median_operator"] = {
    "median_operator_score": base_s,
    "+1 seatbelt incident (7d)": bump(seatbelt_incidents_7d=(med["seatbelt_incidents_7d"] or 0) + 1, safety_incidents_14d_weighted=(med["safety_incidents_14d_weighted"] or 0) + 1),
    "+1 proximity incident (7d)": bump(proximity_incidents_7d=(med["proximity_incidents_7d"] or 0) + 1, safety_incidents_14d_weighted=(med["safety_incidents_14d_weighted"] or 0) + 1),
    "+1 drowsiness this shift": bump(drowsiness_shift=1, drowsiness_7d=(med["drowsiness_7d"] or 0) + 1),
    "+2 idle anomalies (7d)": bump(idle_anomalies_7d=(med["idle_anomalies_7d"] or 0) + 2),
    "all alerts corrected slowly (pct_fast 0, median 15 s)": bump(pct_corrected_fast=0.0, median_seconds_to_correct=15.0),
    "+1 relevant training module": bump(modules_completed=(med["modules_completed"] or 0) + 1, modules_after_incident=(med["modules_after_incident"] or 0) + 1),
}

# Endpoint latency (service running on :8001)
lat = []
body = json.dumps({"operator_id": "OP-103", "features": med}).encode()
for _ in range(50):
    t = time.perf_counter()
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8001/score", body, {"content-type": "application/json"})).read()
    lat.append((time.perf_counter() - t) * 1000)
out["http_latency_ms"] = {"p50": round(float(np.median(lat)), 1), "p95": round(float(np.percentile(lat, 95)), 1)}
(Path(__file__).parent / "prof_eval.json").write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))
