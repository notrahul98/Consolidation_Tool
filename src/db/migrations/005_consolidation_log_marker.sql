-- Phase 7 follow-up: staleness detection (period_repo.is_consolidation_stale) originally
-- compared periods.consolidated_at against audit_log.timestamp as ISO-8601 strings. Two
-- problems surfaced under fast/automated use: (1) datetime.isoformat() omits the
-- fractional-second part entirely when microsecond == 0, so two timestamps from the same
-- instant can compare out of order as strings; (2) wall-clock resolution (coarse on some
-- platforms) lets rapid successive operations land on the identical timestamp, making a
-- real edit invisible to a strict '>' comparison. audit_log.log_id is a monotonically
-- increasing AUTOINCREMENT rowid with none of those issues, so use it as the marker instead.

ALTER TABLE periods ADD COLUMN consolidated_through_log_id INTEGER NOT NULL DEFAULT 0;
