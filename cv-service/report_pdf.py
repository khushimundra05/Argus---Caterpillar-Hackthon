"""End-of-shift PDF report (for the supervisor), drawn with matplotlib's PDF backend. No extra dependencies.

build_pdf(report: dict) -> bytes. `report` is the JSON built by web/src/lib/report.ts:
  page 1: header, KPI tiles, supervisor summary, task table
  page 2: charts - proficiency over the shift, idle % and load cycles over time, cumulative fuel, time split
  page 3: safety incidents, behaviour flags, training, top proficiency factors, notes
"""
from __future__ import annotations

import io
import textwrap
from datetime import datetime

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402

A4 = (8.27, 11.69)
INK, MUTED, LINE = "#1f2328", "#6a737d", "#d0d7de"
CAT_YELLOW = "#FFCD11"
MODE_COLOR = {"Instructor": "#e5534b", "Coaching": "#d4a72c", "Assist": "#4493f8", "Silent Guardian": "#3fb950"}
INCIDENT_COLOR = {"SEATBELT": "#e5534b", "PROXIMITY": "#d4a72c", "DROWSINESS": "#8957e5"}
FLAG_LABEL = {
    "IDLE_ANOMALY": "Idle anomalies (vs own baseline)", "EXCESSIVE_IDLE": "Excessive-idle episodes",
    "REPEATED_SEATBELT": "Repeated seatbelt violations", "SAFE_STREAK": "Safe streaks (positive)",
    "NUDGE_RESPONDED": "Idle nudges acted on (positive)",
}

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.edgecolor": LINE, "axes.labelcolor": INK,
                     "xtick.color": MUTED, "ytick.color": MUTED, "axes.spines.top": False, "axes.spines.right": False})


LOCAL_TZ = datetime.now().astimezone().tzinfo
HM = mdates.DateFormatter("%H:%M", tz=LOCAL_TZ)  # chart axes in local time, like the rest of the report


def _t(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()


def _hm(iso: str) -> str:
    return _t(iso).strftime("%H:%M")


def _page(pdf: PdfPages, r: dict, n: int, title: str):
    fig = plt.figure(figsize=A4)
    fig.patches.append(plt.Rectangle((0, 0.955), 1, 0.045, transform=fig.transFigure, color=CAT_YELLOW, zorder=0))
    fig.text(0.05, 0.972, "ARGUS  ·  End-of-Shift Report", fontsize=13, weight="bold", color="#111", va="center")
    fig.text(0.95, 0.972, f"{r['operator']['name']}  ·  page {n}/3", fontsize=9, color="#111", va="center", ha="right")
    fig.text(0.05, 0.925, title, fontsize=12, weight="bold", color=INK)
    fig.text(0.05, 0.02, f"Generated {_t(r['generated_at']).strftime('%d %b %Y %H:%M')} by Argus. Safety alerts come from a deterministic "
             "rules engine; the proficiency score is an ML model trained on simulated fleet data.", fontsize=6.5, color=MUTED)
    return fig


def _table(ax, header, rows, col_w, fontsize=8.5):
    ax.axis("off")
    if not rows:
        ax.text(0, 0.9, "None this shift.", fontsize=9, color=MUTED, transform=ax.transAxes)
        return
    t = ax.table(cellText=rows, colLabels=header, colWidths=col_w, loc="upper left", cellLoc="left", colLoc="left")
    t.auto_set_font_size(False)
    t.set_fontsize(fontsize)
    t.scale(1, 1.35)
    for (row, _), cell in t.get_celld().items():
        cell.set_edgecolor(LINE)
        if row == 0:
            cell.set_facecolor("#f6f8fa")
            cell.set_text_props(weight="bold", color=INK)


def _page1(pdf, r):
    fig = _page(pdf, r, 1, "Shift overview")
    op, m, sh, k, p = r["operator"], r["machine"], r["shift"], r["kpis"], r["proficiency"]
    fig.text(0.05, 0.895, f"Operator: {op['name']} ({op['id']}), {op['experience_years']} years, {op['shifts_completed']} shifts", fontsize=9.5, color=INK)
    fig.text(0.05, 0.875, f"Machine: {m['model']} {m['type']} ({m['id']})     Shift: {_hm(sh['start'])} to {_hm(sh['end'])} "
             f"({sh['duration_min']} min)", fontsize=9.5, color=INK)

    risk = p["end"].get("incident_risk")
    start = p.get("start")
    tiles = [
        ("Tasks completed", f"{k['tasks_completed']} / {k['tasks_total']}", ""),
        ("Load cycles", f"{k['load_cycles']}", ""),
        ("Engine time", f"{k['engine_min']} min", f"{k['working_min']} working"),
        ("Idle", f"{k['idle_pct']}%", f"{k['idle_min']} min of engine time"),
        ("Fuel used", f"{k['fuel_l']} L", f"{k['idle_fuel_l']} L while idle"),
        ("Idle fuel cost", f"${k['idle_cost_usd']}", "at site fuel price"),
        ("Safety incidents", f"{k['incidents']}",
         f"median {k['median_seconds_to_correct']} s to correct" if k["median_seconds_to_correct"] is not None else ""),
        ("Proficiency", f"{p['end']['score']}  {p['end']['mode']}",
         (f"from {start['score']} {start['mode']}" if start else "") + (f" · {round(risk * 100)}% risk" if risk is not None else "")),
    ]
    for i, (label, value, sub) in enumerate(tiles):
        col, row = i % 4, i // 4
        x, y, w, h = 0.05 + col * 0.227, 0.765 - row * 0.095, 0.21, 0.08
        fig.patches.append(plt.Rectangle((x, y), w, h, transform=fig.transFigure, facecolor="#f6f8fa", edgecolor=LINE, lw=0.8))
        fig.text(x + 0.01, y + h - 0.017, label.upper(), fontsize=6.5, color=MUTED)
        color = MODE_COLOR.get(p["end"]["mode"], INK) if label == "Proficiency" else ("#e5534b" if label == "Safety incidents" and k["incidents"] else INK)
        fig.text(x + 0.01, y + 0.03, value, fontsize=12.5 if len(value) < 14 else 10, weight="bold", color=color)
        fig.text(x + 0.01, y + 0.01, sub, fontsize=6.5, color=MUTED)

    fig.text(0.05, 0.645, "Summary for the supervisor", fontsize=10.5, weight="bold", color=INK)
    wrapped = textwrap.fill(r["narrative"]["supervisor"], 105)
    fig.text(0.05, 0.635, wrapped, fontsize=9, color=INK, va="top", linespacing=1.5)
    src = "written by Gemini from the report data" if r["narrative"]["source"] == "gemini" else "generated from the report data"
    lines = wrapped.count("\n") + 1
    fig.text(0.05, 0.635 - lines * 0.0165 - 0.008, f"({src})", fontsize=6.5, color=MUTED, va="top")

    fig.text(0.05, 0.47, "Tasks", fontsize=10.5, weight="bold", color=INK)
    ax = fig.add_axes([0.05, 0.08, 0.9, 0.375])
    rows = [[t["name"], t["status"].replace("_", " "), f"{t['planned_min']:.0f}",
             f"{t['actual_min']:.1f}" if t["actual_min"] is not None else "-",
             f"{t['cycles_done']} / {t['target_cycles']}"] for t in r["tasks"]]
    _table(ax, ["Task", "Status", "Planned (min)", "Actual (min)", "Cycles"], rows, [0.42, 0.14, 0.14, 0.14, 0.14])
    pdf.savefig(fig)
    plt.close(fig)


def _page2(pdf, r):
    fig = _page(pdf, r, 2, "Shift performance charts")
    p, tl, k = r["proficiency"], r["timeline"], r["kpis"]
    span = (_t(r["shift"]["start"]), _t(r["shift"]["end"]))  # every time chart covers the whole shift

    # 1. Proficiency over the shift, on the mode bands
    ax = fig.add_axes([0.09, 0.66, 0.76, 0.22])
    b = p["bands"]
    for lo, hi, mode in [(0, b["coaching"], "Instructor"), (b["coaching"], b["assist"], "Coaching"),
                         (b["assist"], b["silent_guardian"], "Assist"), (b["silent_guardian"], 100, "Silent Guardian")]:
        ax.axhspan(lo, hi, color=MODE_COLOR[mode], alpha=0.10, lw=0)
        ax.text(1.005, (lo + hi) / 2, mode, transform=ax.get_yaxis_transform(), fontsize=6.5, color=MODE_COLOR[mode], va="center")
    xs = [_t(s["t"]) for s in p["series"]]
    ys = [s["score"] for s in p["series"]]
    if len(xs) == 1:
        xs, ys = [_t(r["shift"]["start"]), xs[0]], [ys[0], ys[0]]
    ax.step(xs, ys, where="post", color=INK, lw=1.8)
    ax.plot(xs[-1], ys[-1], "o", color=INK)
    for inc in r["incidents"]:
        ax.axvline(_t(inc["time"]), color=INCIDENT_COLOR.get(inc["type"], MUTED), lw=1, ls="--")
    ax.set_ylim(0, 100)
    ax.set_xlim(*span)
    ax.set_ylabel("Proficiency score")
    ax.set_title("Proficiency score over the shift (dashed lines = incidents)", fontsize=9.5, loc="left", color=INK)
    ax.xaxis.set_major_formatter(HM)

    # 2. Idle % and load cycles over time
    ax2 = fig.add_axes([0.09, 0.37, 0.76, 0.21])
    if tl:
        tx = [_t(b_["t"]) for b_ in tl]
        width = (tx[1] - tx[0]).total_seconds() / 86400 * 0.8 if len(tx) > 1 else 0.0005
        ax2.bar(tx, [b_["idle_pct"] for b_ in tl], width=width, color="#d4a72c", alpha=0.75, label="Idle % of engine time")
        ax2.set_ylim(0, 100)
        ax2.set_xlim(*span)
        ax2.set_ylabel("Idle %")
        axc = ax2.twinx()
        axc.plot(tx, [b_["cycles"] for b_ in tl], color="#4493f8", lw=1.6, marker="o", ms=2.5, label="Load cycles")
        axc.set_ylabel("Load cycles", color="#4493f8")
        axc.spines["right"].set_visible(True)
        axc.tick_params(axis="y", colors="#4493f8")
        ax2.xaxis.set_major_formatter(HM)
        h1, l1 = ax2.get_legend_handles_labels()
        h2, l2 = axc.get_legend_handles_labels()
        ax2.legend(h1 + h2, l1 + l2, fontsize=7, loc="upper left", frameon=False)
    else:
        ax2.text(0.5, 0.5, "No machine telemetry this shift", ha="center", color=MUTED, transform=ax2.transAxes)
    ax2.set_title("Idle share and productivity over time", fontsize=9.5, loc="left", color=INK)

    # 3. Cumulative fuel
    ax3 = fig.add_axes([0.09, 0.08, 0.5, 0.2])
    if tl:
        cum, total = [], 0.0
        for b_ in tl:
            total += b_["fuel_l"]
            cum.append(total)
        ax3.fill_between([_t(b_["t"]) for b_ in tl], cum, color="#8957e5", alpha=0.25)
        ax3.plot([_t(b_["t"]) for b_ in tl], cum, color="#8957e5", lw=1.6)
        ax3.set_xlim(*span)
        ax3.xaxis.set_major_locator(mdates.AutoDateLocator(maxticks=6, tz=LOCAL_TZ))
        ax3.xaxis.set_major_formatter(HM)
    ax3.set_ylabel("Litres")
    ax3.set_title("Cumulative fuel used", fontsize=9.5, loc="left", color=INK)

    # 4. Time split
    ax4 = fig.add_axes([0.66, 0.07, 0.28, 0.22])
    working, idle = max(k["working_min"], 0), max(k["idle_min"], 0)
    if working + idle > 0:
        ax4.pie([working, idle], labels=[f"Working\n{working} min", f"Idle\n{idle} min"], colors=["#3fb950", "#d4a72c"],
                startangle=90, counterclock=False, wedgeprops={"width": 0.38, "edgecolor": "white"}, textprops={"fontsize": 7.5})
    else:
        ax4.text(0.5, 0.5, "Engine not run", ha="center", color=MUTED, transform=ax4.transAxes)
        ax4.axis("off")
    ax4.set_title("Engine time split", fontsize=9.5, color=INK)
    pdf.savefig(fig)
    plt.close(fig)


def _page3(pdf, r):
    fig = _page(pdf, r, 3, "Safety, behaviour and development")
    fig.text(0.05, 0.895, "Safety incidents (logged automatically by the rules engine)", fontsize=10.5, weight="bold", color=INK)
    ax = fig.add_axes([0.05, 0.70, 0.9, 0.18])
    rows = [[_hm(i["time"]), i["type"].title(), f"{i['seconds_to_correct']} s" if i["seconds_to_correct"] is not None else "open",
             (i["source"] or "")[:40]] for i in r["incidents"]]
    _table(ax, ["Time", "Type", "Time to correct", "Detected by"], rows, [0.14, 0.2, 0.2, 0.46])

    fig.text(0.05, 0.665, "Behaviour", fontsize=10.5, weight="bold", color=INK)
    ax = fig.add_axes([0.05, 0.50, 0.42, 0.15])
    _table(ax, ["Signal", "Count"], [[FLAG_LABEL.get(k_, k_), str(v)] for k_, v in sorted(r["flags"].items())], [0.8, 0.2])

    fig.text(0.53, 0.665, "Top proficiency factors", fontsize=10.5, weight="bold", color=INK)
    ax = fig.add_axes([0.53, 0.50, 0.42, 0.15])
    _table(ax, ["Factor", "Points"], [[f["label"][:48], f"{f['delta']:+.1f}"] for f in r["proficiency"]["top_factors"]], [0.8, 0.2], 7.5)

    fig.text(0.05, 0.455, "Training", fontsize=10.5, weight="bold", color=INK)
    done = ", ".join(t["id"] for t in r["training_completed"]) or "None this shift"
    fig.text(0.05, 0.43, f"Completed this shift: {done}", fontsize=9, color=INK)
    rec = r["training_recommended"]
    fig.text(0.05, 0.405, "Recommended next:", fontsize=9, color=INK)
    y = 0.385
    for t in rec or [{"title": "Nothing urgent", "reason": None}]:
        fig.text(0.07, y, f"•  {t['title']}" + (f"  ({t['reason']})" if t.get("reason") else ""), fontsize=9, color=INK)
        y -= 0.02

    fig.text(0.05, 0.28, "Notes", fontsize=10.5, weight="bold", color=INK)
    notes = [
        "Incidents are raised by fixed rules (seatbelt with engine running, person under 3 m, eyes closed 1.5 s or more), never by AI.",
        "Time to correct is measured from the alert to the rules engine clearing it; under 5 s counts as a fast correction.",
        "Idle cost uses the machine's idle burn rate and the configured site fuel price.",
        "The proficiency score is 100 x (1 - predicted risk of a safety incident in the next 5 shifts); it sets how the "
        "assistant coaches this operator. It is a coaching aid, not a disciplinary measure.",
    ]
    y = 0.255
    for n_ in notes:
        wrapped = textwrap.fill(n_, 110)
        fig.text(0.05, y, "•  " + wrapped.replace("\n", "\n    "), fontsize=8, color=MUTED, va="top", linespacing=1.4)
        y -= 0.02 * (wrapped.count("\n") + 1) + 0.008
    pdf.savefig(fig)
    plt.close(fig)


def build_pdf(report: dict) -> bytes:
    buf = io.BytesIO()
    with PdfPages(buf) as pdf:
        _page1(pdf, report)
        _page2(pdf, report)
        _page3(pdf, report)
        info = pdf.infodict()
        info["Title"] = f"Argus end-of-shift report: {report['operator']['name']}"
        info["Author"] = "Argus"
    return buf.getvalue()
