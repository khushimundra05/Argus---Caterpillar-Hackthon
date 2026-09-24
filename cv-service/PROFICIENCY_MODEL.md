# Argus proficiency model (prof-v1): synthetic fleet, results and assumptions

**Trained on a simulated fleet. Retrain on real fleet data when it exists.**

## What was built
- `train_proficiency.py`: generates 200 simulated operators x 60 labelled shifts (14 unlabelled warm-up shifts each, mirroring the 14 seeded `shift_history` rows), then trains and evaluates. `python train_proficiency.py` rebuilds every artifact.
- `synthetic_fleet.csv`: 12,000 rows, the 24 feature names from the handoff, `label`, `baseline_score` (current formula on the same events), `hidden_skill` (diagnostic only, never a feature).
- `prof_model.pkl`: HistGradientBoostingClassifier with `monotonic_cst` on 21 of 24 features, plus Platt calibration (slope > 0, so monotonicity holds). Trained on 160 operators, tested on 40 unseen operators.
- `score_model.py`: loads the bundle, returns `{score, incident_risk, contributions, model_version}`.
- `main.py.patch`: adds `POST /score` and `"score_model": "prof-v1"` to `GET /health` (applied and tested against cv-service at 80380fd).

## Held-out results (40 operators, 2,400 rows, 35% had an incident in the next 5 shifts)
| | AUC | Brier |
|---|---|---|
| prof-v1 model | 0.677 | 0.209 |
| Current formula (raw 1 - score/100) | 0.658 | 0.256 |
| Current formula, recalibrated on train operators | 0.658 | 0.216 |
| Always predict base rate | 0.500 | 0.231 |
| Ceiling reference: true hidden skill | 0.686 | n/a |

- Gain over the formula is small: +0.019 AUC on this split (operator-bootstrap 95% CI -0.012 to +0.053). Across 6 further fleets/splits the model won on AUC in 5 of 6, mean 0.681 vs 0.669.
- Monotonicity: 0 violations in 88,200 checked steps.
- Calibration: close to the diagonal (`prof_calibration.png`); the lowest-risk decile is under-predicted (about 0.11 predicted vs 0.22 observed).
- Latency: `score()` median 1.4 ms, max 9 ms locally.

## Assumptions I made (the handoff left these open)
1. **Timing of "this shift" features.** The handoff says features use only data from before the shift, but also lists per-shift features (drowsiness_shift, idle_ratio_shift, nudges, streaks). I treat features as observed through shift t (scored live) and label incidents in shifts t+1..t+5. No label leakage.
2. **1 shift = 1 day** for the 7d/14d windows. `experience_years` grows 1/30 per shift (sample DB: 14 y = 420 shifts).
3. `pct_corrected_fast`, `median_seconds_to_correct` use all incident types in the last 14 days; null (39% of rows) when there are none. `safety_incidents_14d_weighted` counts seatbelt + proximity + drowsiness.
4. Generator constants (incident rates, skill-to-behaviour links, training effect of 4% per module plus 20% for a matching module) are my choices, not measured. The metrics show the pipeline recovers a known structure, not real-world accuracy.
5. Contributions = score points versus setting that one feature to the training median. Signs follow the monotonic rules by construction; they do not sum exactly to the total because of interactions.

## Decision needed: mode bands
The model score is 100 x (1 - p) with p a 5-shift probability, so it is compressed. On the simulated fleet: Instructor 3%, Coaching 31%, Assist 54%, Silent Guardian 11% (median 72). The current formula gives 66% Silent Guardian. The 40/65/85 bands were tuned to the formula, so they need re-tuning, or the score needs rescaling, before the model goes live.

## Integration (done)
- Files live in `cv-service/` next to `main.py`; the `/score` patch is applied. `prof_model.pkl` is git-ignored and rebuilt on first start (about 17 s) if missing.
- Mode bands decision: **the model drives the mode with bands re-tuned to its own score distribution**, computed at training time and returned by `/score` as `bands`: Instructor below 47.8, Coaching 47.8 to 70.0, Assist 70.0 to 82.1, Silent Guardian 82.1 and above (10th, 40th and 80th percentiles on the training operators).
- The web app (`web/src/lib/profModel.ts`) builds the 24 features from the live SQLite DB and calls `/score` after every event, with a 1.5 s timeout. If the service is down or slow, the rule-based formula (`stats.ts computeScore`) is used. The score card shows the model's top contributions, the incident risk and the formula score.
- `fuel_per_cycle` and `cycles_per_engine_hour` are sent as null: the demo simulator compresses time (about 4 s per load cycle), so these rates are far outside the training range. `bad_weather_share` is the current condition (0 or 1).
- The seeded demo history for Sam was adjusted (slow corrections, 12.5% overrun) so the three demo operators land in three modes under the model: Ravi 84 Silent Guardian, Maya 74 Assist, Sam 59 Coaching.

## Integration evaluation (`eval_proficiency.py` -> `prof_eval.json`)
| Mode | Model: share of held-out rows | Model: observed incident rate | Formula: share | Formula: observed incident rate |
|---|---|---|---|---|
| Instructor | 12% | 58% | 2% | 53% |
| Coaching | 41% | 44% | 15% | 48% |
| Assist | 32% | 23% | 28% | 50% |
| Silent Guardian | 14% | 20% | 55% | 24% |

The model's modes are ordered by real risk; the formula's Assist tier is riskier than its Coaching tier.

Sensitivity from the median held-out operator (score 68): +1 seatbelt incident -1 point, +1 proximity incident 0, +1 drowsiness 0, +2 idle anomalies 0, slow corrections -1, +1 relevant training module +5. A single live event barely moves the model, so a live incident rarely changes the mode during a demo. `/score` HTTP latency: 14 ms median, 36 ms p95.
