"""Train the Argus proficiency model (prof-v1) on a SIMULATED fleet.

Run once:  python train_proficiency.py
  -> synthetic_fleet.csv, prof_model.pkl, prof_metrics.json, prof_calibration.png

Target: P(safety incident in the next 5 shifts); score = 100 * (1 - p).
Every operator has a hidden skill in (0, 1) that the model never sees; it only sees the observable features.
The generator encodes OUR ASSUMPTIONS about how skill shows up in behaviour, so the metrics measure how well the
pipeline recovers a known structure, not how well it will do on real operators. Retrain on real fleet data
when it exists (same feature names, same script, swap generate_fleet() for the DB export).
"""
from __future__ import annotations

import json
from math import erf, sqrt
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import GroupKFold

from score_model import FEATURES, MODEL_PATH, MONOTONE_RISK, VERSION, predict_risk

HERE = Path(__file__).parent
DATA_PATH = HERE / "synthetic_fleet.csv"
METRICS_PATH = HERE / "prof_metrics.json"
PLOT_PATH = HERE / "prof_calibration.png"

N_OPERATORS = 200
N_TRAIN_OPERATORS = 160
N_SHIFTS = 60          # labelled shifts per operator
WARMUP = 14            # unlabelled history before the first row (mirrors the 14 seeded shift_history rows)
HORIZON = 5            # label: incident in the next 5 shifts
SHIFTS_PER_YEAR = 30   # from the sample DB: 14 y -> 420 shifts, 5 y -> 160, 0.3 y -> 12
HALF_LIFE = 7.0        # web/src/lib/config.ts SCORE.halfLifeDays
LOOKBACK = 14
FAST_SEC = 5.0

INCIDENT_TAGS = ["SEATBELT", "PROXIMITY", "DROWSINESS"]   # modules that match an incident type
GENERAL_MODULES = 8                                        # the other TM-* modules in training-modules.json


# ------------------------------------------------------------------------------------------------
# Generator
# ------------------------------------------------------------------------------------------------
def _simulate_operator(rng: np.random.Generator) -> dict:
    z = rng.normal()
    skill = 0.5 * (1 + erf((0.6 * z + 0.8 * rng.normal()) / sqrt(2)))     # correlated with experience (r ~ 0.6)
    exp0 = float(np.clip(np.exp(1.9 + 0.9 * z), 0.1, 25.0))               # median ~ 6.7 y
    machine_age = float(rng.uniform(0, 15))
    total = WARMUP + N_SHIFTS + HORIZON

    S = {k: [] for k in ["skill", "ws", "sb", "px", "dz", "idle", "z", "anom", "excess", "rep", "nudge", "streak",
                         "fuel", "cph", "mods_now"]}
    incidents = []          # (shift, tag, seconds_to_correct)
    tasks = []              # per shift: list of overrun %
    comps = {}              # module tag -> shift completed (incident-type modules)
    general_done = 0
    idle_hist: list[float] = []
    s = skill

    for j in range(total):
        s = float(np.clip(s + rng.normal(0, 0.02), 0.02, 0.98))         # slow skill drift
        bad = rng.random() < 0.25
        ws = float(rng.uniform(0.3, 1.0)) if bad else (float(rng.uniform(0, 0.1)) if rng.random() < 0.3 else 0.0)

        n_mod = len(comps) + general_done
        train_mult = 0.96 ** n_mod                                       # any module helps a little
        base = 0.26 * np.exp(-2.6 * s) * train_mult * np.exp(rng.normal(0, 0.5) - 0.125)   # per-shift frailty noise
        lam = {
            "SEATBELT": base * 0.50 * (1 + 0.5 * ws),
            "PROXIMITY": base * 0.30 * (1 + 1.0 * ws),
            "DROWSINESS": base * 0.20 * np.exp(rng.normal(0, 0.4)),      # fatigue: partly independent of skill
        }
        for t in INCIDENT_TAGS:
            if t in comps:
                lam[t] *= 0.80                                           # matching module: extra 20% off that type
        n = {t: int(rng.poisson(lam[t])) for t in INCIDENT_TAGS}
        med = 12.0 * np.exp(-1.7 * s)                                    # seconds-to-correct: skill-driven
        for t in INCIDENT_TAGS:
            for _ in range(n[t]):
                incidents.append((j, t, float(rng.lognormal(np.log(med), 0.55))))

        idle = float(np.clip(0.10 + 0.28 * (1 - s) + 0.04 * ws + rng.normal(0, 0.04), 0.01, 0.8))
        past = idle_hist[-14:]
        if len(past) < 2:
            mean, std = 0.15, 0.05                                       # same defaults as idleBaseline()
        else:
            mean, std = float(np.mean(past)), max(float(np.std(past, ddof=1)), 0.02)
        zi = (idle - mean) / std
        anom = int(rng.poisson(0.8 * max(0.0, zi - 1.0)))
        excess = int(rng.poisson(4.0 * idle * (1 - s)))
        rep = 1 if (n["SEATBELT"] >= 2) else 0
        offered = int(rng.poisson(1 + 8 * idle))
        nudge = int(rng.binomial(offered, 0.2 + 0.6 * s))
        n_inc = sum(n.values())
        streak = int(rng.poisson(max(0.0, (2 + 8 * s) * (1 - 0.25 * n_inc))))
        n_tasks = int(rng.choice([0, 1, 2, 3, 4], p=[0.08, 0.17, 0.30, 0.30, 0.15]))
        tasks.append([float(rng.normal(28 * (1 - s) - 4 + 10 * ws, 9)) for _ in range(n_tasks)])
        fuel = 3.2 * (1 + 0.6 * idle) * (1 + 0.012 * machine_age) * rng.normal(1, 0.05)
        cph = 22 * (1 - idle) * (0.85 + 0.2 * s) * (1 - 0.15 * ws) * rng.normal(1, 0.06)

        # Training completed at the END of this shift (affects later shifts): mostly after an incident of that type.
        for t in INCIDENT_TAGS:
            if n[t] > 0 and t not in comps and rng.random() < 0.35:
                comps[t] = j
        if general_done < GENERAL_MODULES and rng.random() < 0.02:
            general_done += 1

        idle_hist.append(idle)
        for k, v in [("skill", s), ("ws", ws), ("sb", n["SEATBELT"]), ("px", n["PROXIMITY"]), ("dz", n["DROWSINESS"]),
                     ("idle", idle), ("z", zi), ("anom", anom), ("excess", excess), ("rep", rep), ("nudge", nudge),
                     ("streak", streak), ("fuel", fuel), ("cph", cph), ("mods_now", len(comps) + general_done)]:
            S[k].append(v)

    return dict(skill0=skill, exp0=exp0, machine_age=machine_age, S={k: np.array(v) for k, v in S.items()},
                incidents=incidents, tasks=tasks, comp_hist=None, comps=comps, total=total)


def _module_completions(op: dict) -> list[tuple[int, str]]:
    """(shift index, tag) of every incident-type module completion, needed for 'as of shift t' queries."""
    return [(j, t) for t, j in op["comps"].items()]


def _rows_for_operator(op: dict, op_id: str) -> list[dict]:
    S, inc, tasks = op["S"], op["incidents"], op["tasks"]
    comps = _module_completions(op)
    total_inc = S["sb"] + S["px"] + S["dz"]
    # general-module count as of each shift is S["mods_now"] - (#incident modules by then)
    rows = []
    for t in range(WARMUP, WARMUP + N_SHIFTS):
        w7, w14 = slice(t - 6, t + 1), slice(t - 13, t + 1)
        age = lambda j: t - j                                            # 1 shift = 1 day
        decay = lambda j: 0.5 ** (age(j) / HALF_LIFE)

        inc14 = [(j, tag, sec) for (j, tag, sec) in inc if t - 13 <= j <= t]
        secs = [sec for _, _, sec in inc14]
        comps_now = [(c, tag) for (c, tag) in comps if c <= t]
        after_inc = sum(1 for (c, tag) in comps_now if any(i[1] == tag and i[0] <= c for i in inc if i[0] <= c))
        ov7 = [o for j in range(t - 6, t + 1) for o in tasks[j]]

        # ---- current rule-based formula (web/src/lib/stats.ts computeScore), on the same event history ----
        pen = 0.0
        for (j, tag, sec) in inc14:
            if tag == "DROWSINESS":
                continue
            fast = sec <= FAST_SEC
            retrained = any(c >= j and ctag == tag for (c, ctag) in comps_now)
            pen += (5 if fast else 15) * (0.5 if retrained else 1.0) * decay(j)
        w = np.array([decay(j) for j in range(t - 13, t + 1)])
        pen += 5 * float((S["anom"][w14] * w).sum()) + 5 * float((S["rep"][w14] * w).sum()) \
            + 2 * float((S["excess"][w14] * w).sum())
        pen += 10 * S["dz"][t]
        dev = float(np.mean(ov7)) if ov7 else 0.0
        pen += min(3 * dev, 15) if dev > 0 else 0
        tenure = 10 * min((round(op["exp0"] * SHIFTS_PER_YEAR) + t) / 20, 1)
        mods_now_shift = sum(1 for (c, _) in comps if c == t)
        on_time_now = sum(1 for o in tasks[t] if o <= 5)
        pos = min(2 * S["streak"][t] + S["nudge"][t] + 3 * mods_now_shift + on_time_now, 20)
        baseline = float(np.clip(100 - pen + tenure + pos, 0, 100))

        rows.append({
            "operator_id": op_id, "shift_idx": t - WARMUP,
            "experience_years": op["exp0"] + t / SHIFTS_PER_YEAR,
            "shifts_completed": round(op["exp0"] * SHIFTS_PER_YEAR) + t,
            "seatbelt_incidents_7d": int(S["sb"][w7].sum()),
            "proximity_incidents_7d": int(S["px"][w7].sum()),
            "safety_incidents_14d_weighted": float(sum(decay(j) for (j, _, _) in inc14)),
            "pct_corrected_fast": float(np.mean([s <= FAST_SEC for s in secs])) if secs else np.nan,
            "median_seconds_to_correct": float(np.median(secs)) if secs else np.nan,
            "drowsiness_shift": int(S["dz"][t]),
            "drowsiness_7d": int(S["dz"][w7].sum()),
            "idle_anomalies_7d": int(S["anom"][w7].sum()),
            "excessive_idle_7d": int(S["excess"][w7].sum()),
            "repeated_seatbelt_7d": int(S["rep"][w7].sum()),
            "nudges_acted_on_shift": int(S["nudge"][t]),
            "safe_streaks_shift": int(S["streak"][t]),
            "idle_ratio_shift": float(S["idle"][t]),
            "idle_z_shift": float(S["z"][t]),
            "fuel_per_cycle": float(S["fuel"][t]),
            "cycles_per_engine_hour": float(S["cph"][t]),
            "mean_overrun_pct_7d": float(np.mean(ov7)) if ov7 else np.nan,
            "on_time_rate_7d": float(np.mean([o <= 5 for o in ov7])) if ov7 else np.nan,
            "modules_completed": int(S["mods_now"][t]),
            "modules_after_incident": int(after_inc),
            "machine_age_years": op["machine_age"],
            "bad_weather_share": float(S["ws"][t]),
            "label": int(total_inc[t + 1: t + 1 + HORIZON].sum() > 0),
            "baseline_score": baseline,
            "hidden_skill": float(S["skill"][t]),        # for diagnostics only, never a feature
        })
    return rows


def generate_fleet(n_operators: int = N_OPERATORS, seed: int = 11) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for k in range(n_operators):
        rows += _rows_for_operator(_simulate_operator(rng), f"OP-{1000 + k}")
    return pd.DataFrame(rows)


# ------------------------------------------------------------------------------------------------
# Training + evaluation
# ------------------------------------------------------------------------------------------------
def _make_hgb(**kw):
    params = dict(max_iter=250, learning_rate=0.05, max_depth=4, min_samples_leaf=80, l2_regularization=1.0,
                  monotonic_cst=[MONOTONE_RISK[f] for f in FEATURES], early_stopping=False, random_state=0)
    params.update(kw)
    return HistGradientBoostingClassifier(**params)


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _platt(raw_p, y):
    lr = LogisticRegression(C=1e6).fit(_logit(raw_p).reshape(-1, 1), y)
    return float(lr.coef_[0, 0]), float(lr.intercept_[0])


def _apply_platt(raw_p, ab):
    return 1 / (1 + np.exp(-(ab[0] * _logit(raw_p) + ab[1])))


def _bootstrap_auc_diff(df, p_model, p_base, n=500, seed=0):
    rng = np.random.default_rng(seed)
    ops = df["operator_id"].unique()
    idx = {o: np.where(df["operator_id"].to_numpy() == o)[0] for o in ops}
    y = df["label"].to_numpy()
    diffs = []
    for _ in range(n):
        pick = np.concatenate([idx[o] for o in rng.choice(ops, len(ops))])
        if y[pick].min() == y[pick].max():
            continue
        diffs.append(roc_auc_score(y[pick], p_model[pick]) - roc_auc_score(y[pick], p_base[pick]))
    return [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))]


def _check_monotone(bundle, X, n_rows=300, seed=0):
    """Sweep every constrained feature over its observed range on real rows; count score moves in the wrong direction."""
    rng = np.random.default_rng(seed)
    base = X[rng.choice(len(X), n_rows, replace=False)]
    violations = 0
    checked = 0
    for i, f in enumerate(FEATURES):
        d = MONOTONE_RISK[f]
        if d == 0:
            continue
        grid = np.nanpercentile(X[:, i], np.linspace(0, 100, 15))
        risks = []
        for g in grid:
            Z = base.copy()
            Z[:, i] = g
            risks.append(predict_risk(bundle, Z))
        steps = np.diff(np.array(risks), axis=0)                         # (grid-1, rows), along increasing value
        wrong = steps < -1e-9 if d == 1 else steps > 1e-9               # +1 features: risk must not fall; -1: must not rise
        violations += int(wrong.sum())
        checked += steps.size
    return violations, checked


def _mode_share(scores, bands):
    s = np.asarray(scores)
    return {
        "Instructor": round(float((s < bands["coaching"]).mean()), 3),
        "Coaching": round(float(((s >= bands["coaching"]) & (s < bands["assist"])).mean()), 3),
        "Assist": round(float(((s >= bands["assist"]) & (s < bands["silent_guardian"])).mean()), 3),
        "Silent Guardian": round(float((s >= bands["silent_guardian"]).mean()), 3),
    }


def train(seed: int = 11, verbose: bool = True, write_artifacts: bool = True):
    df = generate_fleet(seed=seed)
    ops = df["operator_id"].unique()
    rng = np.random.default_rng(seed + 1)
    train_ops = set(rng.permutation(ops)[:N_TRAIN_OPERATORS])
    is_tr = df["operator_id"].isin(train_ops).to_numpy()
    tr, te = df[is_tr].reset_index(drop=True), df[~is_tr].reset_index(drop=True)
    Xtr, ytr, gtr = tr[FEATURES].to_numpy(float), tr["label"].to_numpy(), tr["operator_id"].to_numpy()
    Xte, yte = te[FEATURES].to_numpy(float), te["label"].to_numpy()

    # 1) pick hyper-parameters by operator-grouped CV on the training operators only
    grid = [dict(max_depth=3, max_iter=200), dict(max_depth=4, max_iter=250), dict(max_depth=5, max_iter=300, learning_rate=0.03)]
    gkf = GroupKFold(n_splits=5)
    best, best_auc, best_oof = None, -1, None
    for g in grid:
        oof = np.zeros(len(tr))
        for a, b in gkf.split(Xtr, ytr, gtr):
            oof[b] = _make_hgb(**g).fit(Xtr[a], ytr[a]).predict_proba(Xtr[b])[:, 1]
        auc = roc_auc_score(ytr, oof)
        if verbose:
            print(f"[prof] CV {g}: AUC={auc:.4f}")
        if auc > best_auc:
            best, best_auc, best_oof = g, auc, oof

    # 2) Platt calibration fitted on out-of-fold predictions (slope > 0, so monotonicity survives)
    ab = _platt(best_oof, ytr)
    assert ab[0] > 0
    model = _make_hgb(**best).fit(Xtr, ytr)
    bundle = {"version": VERSION, "features": FEATURES, "model": model, "calib": ab,
              "reference": [float(np.nanmedian(Xtr[:, i])) for i in range(len(FEATURES))],
              "trained_on": {"synthetic": True, "operators": N_TRAIN_OPERATORS, "rows": int(len(tr)), "params": best}}
    # Mode bands re-tuned to THIS model's score distribution on the training operators (the formula's 40/65/85 bands
    # don't fit: 100*(1-p) is compressed). Lower bounds: Instructor = riskiest 10%, Coaching next 30%,
    # Assist next 40%, Silent Guardian safest 20%.
    tr_scores = 100 * (1 - predict_risk(bundle, Xtr))
    p10, p40, p80 = np.percentile(tr_scores, [10, 40, 80])
    bundle["bands"] = {"coaching": round(float(p10), 1), "assist": round(float(p40), 1), "silent_guardian": round(float(p80), 1)}

    # 3) held-out operators: model vs current formula
    p_model = predict_risk(bundle, Xte)
    base_tr_risk = 1 - tr["baseline_score"].to_numpy() / 100
    base_te_risk = 1 - te["baseline_score"].to_numpy() / 100
    ab_base = _platt(base_tr_risk, ytr)
    p_base_recal = _apply_platt(base_te_risk, ab_base)

    def stats(p):
        return {"auc": round(float(roc_auc_score(yte, p)), 4), "brier": round(float(brier_score_loss(yte, p)), 4)}

    prevalence = float(yte.mean())
    m = {
        "test_operators": int(len(ops) - N_TRAIN_OPERATORS), "test_rows": int(len(te)),
        "incident_rate_test": round(prevalence, 3),
        "brier_always_predict_base_rate": round(float(brier_score_loss(yte, np.full(len(yte), ytr.mean()))), 4),
        "model_prof_v1": stats(p_model),
        "current_formula_as_risk": stats(base_te_risk),
        "current_formula_recalibrated": stats(p_base_recal),
        "ceiling_true_skill_auc": round(float(roc_auc_score(yte, 1 - te["hidden_skill"].to_numpy())), 4),
        "auc_gain_vs_formula_95ci_operator_bootstrap": _bootstrap_auc_diff(te, p_model, base_te_risk),
        "cv_auc_train_operators": round(best_auc, 4), "chosen_params": best,
        "calibration_platt_slope_intercept": [round(ab[0], 3), round(ab[1], 3)],
        "mode_bands_lower_bounds": bundle["bands"],
        "mode_share_test": _mode_share(100 * (1 - p_model), bundle["bands"]),
    }
    viol, checked = _check_monotone(bundle, Xtr)
    m["monotonic_violations"] = f"{viol} of {checked} checked steps"

    if write_artifacts:
        df.drop(columns=["hidden_skill"]).assign(hidden_skill=df["hidden_skill"].round(3)).to_csv(DATA_PATH, index=False)
        joblib.dump(bundle, MODEL_PATH)
        METRICS_PATH.write_text(json.dumps(m, indent=2))
        _plot(te, yte, p_model, p_base_recal, base_te_risk)
    if verbose:
        print(json.dumps(m, indent=2))
        print(f"[prof] trained on {len(tr)} rows / {N_TRAIN_OPERATORS} simulated operators -> {MODEL_PATH.name}")
    return bundle


def _plot(te, y, p_model, p_base_recal, p_base_raw):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(1, 2, figsize=(11, 4.6))
    for p, name, c in [(p_model, "prof-v1 model", "#1b7f5c"), (p_base_recal, "current formula (recalibrated)", "#c47a00"),
                       (p_base_raw, "current formula (raw 1 - score/100)", "#9a9a9a")]:
        q = pd.qcut(pd.Series(p).rank(method="first"), 10, labels=False)
        d = pd.DataFrame({"p": p, "y": y, "q": q}).groupby("q").mean()
        ax[0].plot(d["p"], d["y"], "o-", label=name, color=c)
    ax[0].plot([0, 1], [0, 1], "k--", lw=1)
    ax[0].set(xlabel="predicted P(incident in next 5 shifts)", ylabel="observed frequency", title="Calibration, 40 held-out operators",
              xlim=(0, 1), ylim=(0, 1))
    ax[0].legend(fontsize=8)
    ax[1].hist(100 * (1 - p_model), bins=30, color="#1b7f5c", alpha=0.85)
    ax[1].set(xlabel="proficiency score (100 x (1 - p))", ylabel="operator-shifts", title="Score distribution, held-out operators")
    fig.tight_layout()
    fig.savefig(PLOT_PATH, dpi=140)


if __name__ == "__main__":
    train()
