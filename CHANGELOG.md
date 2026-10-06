# Changelog

## 0.1.0 (unreleased)

- Poll Jira Cloud issues and comments as n8n trigger events using n8n's built-in Jira credentials.
- Use an exact-millisecond cursor with handled IDs, resume a fixed window after time-budget or page-cap stops, and stop persisting Jira page tokens. All output modes include top-level `eventId`, `eventType`, and `eventTime`.
- Use n8n's `getPollBudgetMs()` when available and a 5-minute fallback otherwise. Same-process overlapping polls warn and return no data; a pending activation baseline stays in process memory until committed and can be lost on restart.
- Use saved-state version 2; older or unrecognised state starts at a fresh baseline without migration. Keep up to 40,000 recent deduplication keys, evict the oldest with a warning, and never evict cursor IDs. API failures preserve their HTTP status and do not commit partial progress.
