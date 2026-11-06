#!/usr/bin/env python3
"""Derive phase-specific forecast errors from the saved realistic-corpus run."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import zipfile
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RESULTS = ROOT / "docs/qa-assets/realistic-2026-11-06/results"
DEFAULT_ZIP = Path.home() / "Downloads/LiFlow_realistic_test_cases_20261104.zip"
EXPECTED_ZIP_SHA256 = "df5a7481859bd9d77a55903084355ceae9ca3457be80a5235dfab95d481e743b"
EXPECTED_FINGERPRINT = "904387d423e56b28857a92015c14dc9b7f9be1b5013e9ba34675617ed60fcd86"
CHANGE_MODELS = ("permanent_longer", "temporary_longer", "change_settings")
PHASES = ("before_change", "at_or_after_change", "crossing_or_unidentifiable")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_source_cases(archive_path: Path) -> dict[str, dict[str, Any]]:
    with zipfile.ZipFile(archive_path) as archive:
        with archive.open("liflow_realistic_cases/cases.jsonl.gz") as compressed:
            with gzip.GzipFile(fileobj=compressed) as stream:
                cases = [json.loads(line) for line in stream]
    return {row["case_id"]: row for row in cases}


def day_from_start(start: str, day_index: int) -> date:
    return date.fromisoformat(start) + timedelta(days=day_index)


def predicted_change_boundary(case: dict[str, Any], chore_id: str) -> dict[str, Any] | None:
    """Return only generator-defined discrete boundaries, never infer gradual ones."""
    behavior = case["behavior_model"]["id"]
    horizon = case["clock"]["evaluation_horizon_days"]
    source_chore = next((row for row in case["chores"] if row["id"] == chore_id), None)
    if behavior == "change_settings":
        event = next((row for row in case["lifecycle_events"] if row["kind"] == "mode_change"), None)
        return {"kind": "mode_change", "start_day": event["day"], "end_day": None,
                "clock": None, "precision": "day"} if event else None
    if source_chore is None or chore_id in {"daily", "manual", "shared"}:
        return None
    cycle = source_chore["initial_days"]
    if not isinstance(cycle, int) or cycle <= 0:
        return None
    if behavior == "permanent_longer":
        threshold = horizon // 3
        # The generator doubles the next interval when the current completion
        # day first reaches horizon//3; use that effective interval start.
        start = math.ceil(threshold / cycle) * cycle
        if start > horizon:
            return None
        completion_clock = next((row["completion_time_local"] for row in case["observed_history"]
                                 if row["chore_id"] == chore_id), "08:00")
        return {"kind": "permanent_longer", "threshold_day": threshold, "start_day": start,
                "end_day": None, "clock": completion_clock, "precision": "minute"}
    if behavior == "temporary_longer":
        # The generator doubles intervals for completion indices 3, 4, and 5.
        # Thus the altered run starts at event 2 (day 2*cycle) and returns to
        # baseline after event 5 (day 8*cycle), if observed within the horizon.
        start = 2 * cycle
        if start > horizon:
            return None
        end = 8 * cycle if 8 * cycle <= horizon else None
        completion_clock = next((row["completion_time_local"] for row in case["observed_history"]
                                 if row["chore_id"] == chore_id), "08:00")
        return {"kind": "temporary_longer", "start_day": start, "end_day": end,
                "clock": completion_clock, "precision": "minute"}
    return None


def classify_prediction(
    behavior: str,
    issue_day: datetime,
    previous_completion: datetime | None,
    target_day: datetime,
    boundary: dict[str, Any] | None,
) -> tuple[str, str | None]:
    if boundary is None:
        return "no_observed_change_boundary", None
    start_date = date.fromisoformat(boundary["start_date"])
    if boundary.get("precision") == "day":
        evidence_dates = [issue_day.date()]
        if previous_completion is not None:
            evidence_dates.append(previous_completion.date())
        evidence_dates.append(target_day.date())
        if any(value == start_date for value in evidence_dates):
            return "crossing_or_unidentifiable", None
        if all(value < start_date for value in evidence_dates):
            return "before_change", None
        if previous_completion is not None and all(value > start_date for value in evidence_dates):
            return "at_or_after_change", None
        return "crossing_or_unidentifiable", None
    boundary_clock = time.fromisoformat(boundary["clock"])
    start_day = datetime.combine(start_date, boundary_clock)
    if previous_completion is None:
        return "crossing_or_unidentifiable", None
    if behavior == "temporary_longer":
        end_day = (datetime.combine(date.fromisoformat(boundary["end_date"]), boundary_clock)
                   if boundary.get("end_date") else None)
        if issue_day < start_day and previous_completion < start_day and target_day < start_day:
            return "before_change", None
        if end_day is not None and issue_day >= end_day and previous_completion >= end_day and target_day >= end_day:
            return "at_or_after_change", "after_recovery"
        if issue_day >= start_day and previous_completion >= start_day and target_day >= start_day \
                and (end_day is None or target_day <= end_day):
            return "at_or_after_change", "temporary_extension_active"
        return "crossing_or_unidentifiable", None
    if issue_day < start_day and previous_completion < start_day and target_day < start_day:
        return "before_change", None
    if issue_day >= start_day and previous_completion >= start_day and target_day >= start_day:
        return "at_or_after_change", None
    return "crossing_or_unidentifiable", None


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    errors = [row["error_days"] for row in rows]
    return {
        "scored_prediction_count": len(rows),
        "absolute_error_days_sum": sum(errors),
        "mean_absolute_error_days_scored_only": round(sum(errors) / len(errors), 6) if errors else None,
    }


def summarize_phase(phase: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    if phase == "crossing_or_unidentifiable":
        return {
            "status": "unscored",
            "unscored_prediction_count": len(rows),
            "unique_case_count": len({row["case_id"] for row in rows}),
            "saved_error_values_excluded_from_phase_mae": len(rows),
        }
    return summarize(rows)


def empty_phase_map() -> dict[str, list[dict[str, Any]]]:
    return {phase: [] for phase in PHASES}


def analyze_split(split: str, results_dir: Path, source_cases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    run_path = results_dir / f"{split}.json"
    run = json.loads(run_path.read_text())
    if run["code_fingerprint"] != EXPECTED_FINGERPRINT:
        raise ValueError(f"unexpected frozen code fingerprint in {run_path}")
    reported = run["corpus"]["metrics"]
    case_rows = run["corpus"]["cases"]
    if len(case_rows) != 840:
        raise ValueError(f"expected 840 saved case rows for {split}, got {len(case_rows)}")

    all_detail_count = 0
    all_unresolved = 0
    joins = {"source_case": 0, "identity": 0, "issue_day": 0, "previous_completion": 0,
             "next_observed_target": 0, "absolute_error": 0, "case_scored_detail_count": 0}
    classified: dict[str, dict[str, list[dict[str, Any]]]] = {
        model: empty_phase_map() for model in CHANGE_MODELS
    }
    temporary_subphases: dict[str, list[dict[str, Any]]] = {
        "temporary_extension_active": [], "after_recovery": []
    }
    unscored: dict[str, dict[str, Any]] = defaultdict(lambda: {"scored_prediction_count": 0, "unique_case_ids": set()})
    by_profile_model: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    behavior_case_counts: dict[str, set[str]] = defaultdict(set)
    behavior_unresolved: dict[str, int] = defaultdict(int)
    issue_phase_evidence: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for result_case in case_rows:
        case_id = result_case["case_id"]
        source_case = source_cases.get(case_id)
        if source_case is None:
            joins["source_case"] += 1
            continue
        behavior = source_case["behavior_model"]["id"]
        profile = source_case["profile"]["id"]
        horizon = source_case["clock"]["evaluation_horizon_days"]
        issue_index = source_case["clock"]["initial_now_day"]
        issue_date = day_from_start(source_case["clock"]["start"], issue_index)
        issue_time = time.fromisoformat(result_case["adapter"]["clock_time"])
        issue_day = datetime.combine(issue_date, issue_time)
        if (result_case["split"] != split or result_case["behavior_model"] != behavior
                or result_case["profile"] != profile or result_case["horizon_days"] != horizon
                or result_case["initial_now_day"] != issue_index):
            joins["identity"] += 1
        history: dict[str, list[datetime]] = {}
        for history_row in source_case["observed_history"]:
            completion_clock = time.fromisoformat(history_row["completion_time_local"])
            history[history_row["chore_id"]] = [
                datetime.combine(day_from_start(source_case["clock"]["start"], day), completion_clock)
                for day in history_row["completion_days"]
            ]
        last_by_chore: dict[str, datetime | None] = {}
        next_by_chore: dict[str, datetime | None] = {}
        for chore_id, completion_datetimes in history.items():
            prior = [stamp for stamp in completion_datetimes if stamp <= issue_day]
            future = [stamp for stamp in completion_datetimes if stamp > issue_day]
            last_by_chore[chore_id] = max(prior) if prior else None
            next_by_chore[chore_id] = min(future) if future else None
        reported_last = {row["chore_id"]: row["last_completion"] for row in result_case["actual_history"]}
        detail_chore_ids = {row["chore_id"] for row in result_case["metrics"].get("scored_predictions_detail", [])}
        for chore_id in detail_chore_ids:
            previous = last_by_chore.get(chore_id)
            expected = previous.isoformat() if previous else None
            if reported_last.get(chore_id) != (previous.date().isoformat() if previous else None):
                joins["previous_completion"] += 1

        details = result_case["metrics"].get("scored_predictions_detail", [])
        scored_details = [row for row in details if row.get("scored") is True]
        unresolved_details = [row for row in details if row.get("unresolved") is True]
        if (len(scored_details) != result_case["metrics"]["scored_predictions"]
                or len(unresolved_details) != result_case["metrics"]["unresolved_predictions"]
                or len(scored_details) + len(unresolved_details) != len(details)):
            joins["case_scored_detail_count"] += 1
        all_detail_count += len(scored_details)
        unresolved = result_case["metrics"]["unresolved_predictions"]
        all_unresolved += unresolved
        behavior_unresolved[behavior] += unresolved
        boundary_cache: dict[str, dict[str, Any] | None] = {}
        for detail in scored_details:
            chore_id = detail["chore_id"]
            target = date.fromisoformat(detail["next_observed_date"])
            expected_target = next_by_chore.get(chore_id)
            if expected_target is None or expected_target.date() != target:
                joins["next_observed_target"] += 1
            previous = last_by_chore.get(chore_id)
            target = expected_target
            predicted = date.fromisoformat(detail["predicted_date"])
            actual_error = abs((target.date() - predicted).days)
            if detail["error_days"] != actual_error:
                joins["absolute_error"] += 1
            if behavior not in CHANGE_MODELS:
                unscored["no_discrete_change_point" ]["scored_prediction_count"] += 1
                unscored["no_discrete_change_point"]["unique_case_ids"].add(case_id)
                continue
            behavior_case_counts[behavior].add(case_id)
            if chore_id not in boundary_cache:
                boundary = predicted_change_boundary(source_case, chore_id)
                if boundary is not None:
                    origin = source_case["clock"]["start"]
                    boundary = {**boundary,
                                "start_date": day_from_start(origin, boundary["start_day"]).isoformat(),
                                "end_date": day_from_start(origin, boundary["end_day"]).isoformat()
                                if boundary.get("end_day") is not None else None}
                boundary_cache[chore_id] = boundary
            boundary = boundary_cache[chore_id]
            if boundary is None:
                unscored["no_observed_change_boundary"]["scored_prediction_count"] += 1
                unscored["no_observed_change_boundary"]["unique_case_ids"].add(case_id)
                continue
            phase, subphase = classify_prediction(behavior, issue_day, previous, target, boundary)
            row = {"case_id": case_id, "profile": profile, "behavior_model": behavior,
                   "chore_id": chore_id, "error_days": detail["error_days"]}
            classified[behavior][phase].append(row)
            by_profile_model[(behavior, profile, phase)].append(row)
            issue_phase_evidence[behavior][phase] += 1
            if phase == "crossing_or_unidentifiable":
                unscored["crossing_or_unidentifiable"]["scored_prediction_count"] += 1
                unscored["crossing_or_unidentifiable"]["unique_case_ids"].add(case_id)
            elif behavior == "temporary_longer" and subphase:
                temporary_subphases[subphase].append(row)

    if all_detail_count != reported["scored_predictions"]:
        raise ValueError(f"scored detail count {all_detail_count} != reported {reported['scored_predictions']} for {split}")
    if all_unresolved != reported["unresolved_predictions"]:
        raise ValueError(f"unresolved count {all_unresolved} != reported {reported['unresolved_predictions']} for {split}")
    if any(joins.values()):
        raise ValueError(f"saved prediction/source join checks failed for {split}: {joins}")

    by_behavior = []
    by_pair: list[list[Any]] = []
    for behavior in CHANGE_MODELS:
        phase_rows = classified[behavior]
        phase_summary = {phase: summarize_phase(phase, phase_rows[phase]) for phase in PHASES}
        by_behavior.append({
            "behavior_model": behavior,
            "unique_cases_with_predictions": len(behavior_case_counts[behavior]),
            "unresolved_predictions_without_target_timestamp": behavior_unresolved[behavior],
            "phases": phase_summary,
        })
        for profile in sorted({row["profile"]["id"] for row in source_cases.values()}):
            before = summarize(by_profile_model.get((behavior, profile, "before_change"), []))
            after = summarize(by_profile_model.get((behavior, profile, "at_or_after_change"), []))
            crossing = summarize_phase("crossing_or_unidentifiable",
                                       by_profile_model.get((behavior, profile, "crossing_or_unidentifiable"), []))
            by_pair.append([
                profile, behavior,
                before["scored_prediction_count"], before["absolute_error_days_sum"],
                before["mean_absolute_error_days_scored_only"],
                after["scored_prediction_count"], after["absolute_error_days_sum"],
                after["mean_absolute_error_days_scored_only"],
                crossing["unscored_prediction_count"],
            ])
    no_boundary_models = {name for name in CHANGE_MODELS}
    non_discrete_models = sorted({case["behavior_model"]["id"] for case in source_cases.values()} - no_boundary_models)
    unscored_output = {
        name: {"scored_prediction_count": value["scored_prediction_count"],
               "unique_case_count": len(value["unique_case_ids"])}
        for name, value in sorted(unscored.items())
    }
    return {
        "run_summary": {
            "cases": len(case_rows),
            "scored_predictions": reported["scored_predictions"],
            "unresolved_predictions_without_target_timestamp": reported["unresolved_predictions"],
            "overall_mae_days_scored_only": reported["mean_absolute_error_days_scored_only"],
            "runner_elapsed_ms": run["elapsed_ms"],
        },
        "source_cross_checks": joins,
        "discrete_change_models": by_behavior,
        "by_profile_and_change_model_columns": [
            "profile", "behavior_model", "before_n", "before_abs_error_days_sum", "before_mae_days",
            "at_after_n", "at_after_abs_error_days_sum", "at_after_mae_days", "crossing_unscored_n",
        ],
        "by_profile_and_change_model": by_pair,
        "temporary_longer_subphases": {
            name: summarize(rows) for name, rows in temporary_subphases.items()
        },
        "phase_unscored": {
            "scored_predictions": unscored_output,
            "non_discrete_change_models": non_discrete_models,
            "unresolved_predictions_are_separate_because_they_have_no_target_timestamp": True,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-zip", type=Path, default=DEFAULT_ZIP)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--output", type=Path, default=DEFAULT_RESULTS / "phase-error-summary.json")
    args = parser.parse_args()

    source_zip_sha = sha256(args.source_zip)
    if source_zip_sha != EXPECTED_ZIP_SHA256:
        raise ValueError(f"input ZIP SHA-256 drifted: {source_zip_sha}")
    source_cases = load_source_cases(args.source_zip)
    if len(source_cases) != 1680:
        raise ValueError(f"expected 1,680 original cases, got {len(source_cases)}")
    results = {split: analyze_split(split, args.results_dir, source_cases)
               for split in ("development", "holdout")}
    output = {
        "schema_version": 1,
        "kind": "post-run phase-stratified forecast-error derivation from immutable saved outputs",
        "recorded_on": "2026-11-06",
        "corpus_rerun": False,
        "runner_or_production_source_changed": False,
        "provenance": {
            "input_zip_path": str(args.source_zip),
            "input_zip_sha256": source_zip_sha,
            "original_generator_sha256": "d14be412826994ced99670b48e116284ad013a2d830e6a5c489561aab3f7a829",
            "code_fingerprint": EXPECTED_FINGERPRINT,
            "development_raw_sha256": sha256(args.results_dir / "development.json"),
            "holdout_raw_sha256": sha256(args.results_dir / "holdout.json"),
            "runner_freeze_sha256": sha256(args.results_dir / "runner-freeze.json"),
            "prediction_sources": [
                "raw corpus case metrics scored_predictions_detail",
                "original input clock.initial_now_day and observed_history",
                "original generator behavior-model rules and lifecycle mode_change day",
            ],
            "evaluation_only_hidden_events_used": False,
        },
        "method": {
            "prediction_issue_timestamp": "original case start date plus initial_now_day and saved adapter.clock_time (08:00 local)",
            "preceding_observed_completion": "latest original observed_history completion timestamp at or before issue time; date cross-checked against saved actual_history.last_completion",
            "observed_target_timestamp": "first original observed_history completion timestamp after issue time; its date cross-checked against saved scored_predictions_detail.next_observed_date",
            "error_metric": "saved absolute error_days, independently checked as abs(target_date - predicted_date)",
            "permanent_longer_boundary": "first generator completion timestamp at or after horizon_days//3, when the next interval becomes doubled",
            "temporary_longer_boundary": "generator interval extension starts at completion index 2 and runs through index 5; start=2*initial_days, recovery after day=8*initial_days, right-censored at the evaluation horizon when not observed; completion clock comes from the input history",
            "change_settings_boundary": "explicit lifecycle_events mode_change day; because the event has no time-of-day, any issue/completion/target on that date is unidentifiable and unscored",
            "classification": {
                "before_change": "issue, preceding observed completion, and next observed target are all before the boundary",
                "at_or_after_change": "issue, preceding observed completion, and next observed target are all at or after the same boundary/regime",
                "crossing_or_unidentifiable": "the observation interval crosses a boundary or the saved history cannot establish the phase; retained with no phase MAE contribution",
                "temporary_longer_subphases": "at_or_after_change is split into temporary_extension_active and after_recovery",
            },
            "non_discrete_change_models": "stable, jitter, alternating, gradual, missing_records, recommendation_following, and calendar_rule retain their existing profile/model error breakdowns; no synthetic phase boundary was invented",
            "unresolved_predictions": "remain separately counted and unscored because no next-observed target timestamp exists",
        },
        "existing_error_group_coverage": {
            "evidence": ["development-final-aggregate.json", "holdout-final-aggregate.json"],
            "groups_per_split": {"lifestyle_profiles": 28, "behavior_models": 10, "profile_behavior_model_pairs": 280},
            "note": "These saved aggregate breakdowns cover all behavior models; phase classification below is restricted to explicit discrete change rules.",
        },
        "splits": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "input_zip_sha256": source_zip_sha,
                      "development": results["development"]["run_summary"],
                      "holdout": results["holdout"]["run_summary"],
                      "cross_checks": {split: row["source_cross_checks"] for split, row in results.items()}},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
