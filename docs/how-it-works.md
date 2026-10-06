# How it works

This guide explains what to expect when using Jira Poll Trigger in a workflow. The [README](../README.md) covers setup and use.

## Polling window

Each scheduled poll searches Jira from the last saved position, with **Overlap (Minutes)** added so recent results can be checked again, through the time the poll began. The first search starts at activation. Results are read oldest first by issue creation time and key. Event times can differ from this scan order; sort on `eventTime` if you need time order.

JQL selects issues in their current state. A query such as `status = Open` can stop matching an issue after it leaves Open. Leave `ORDER BY` out of JQL; the node sets the order it needs. Delayed Jira search results later than the configured overlap can be missed.

The trigger reports issue or comment creation and updates according to **Resource** and **Event**. An update counts only when its `updated` time is later than its `created` time. Several edits between polls can appear as one update containing the latest state. Deletions do not produce events.

Every output mode, including Simplify, includes top-level `eventId`, `eventType`, and `eventTime`. Event types are `issue.created`, `issue.updated`, `comment.created`, and `comment.updated`. `eventTime` is an ISO timestamp. `eventId` identifies an event and stays the same if that event is delivered again.

## Options

**Comment Visibility** applies to comments. **All Accessible** includes all comments returned by Jira. **Customer-Visible Only** includes comments marked public and excludes internal or unknown visibility. **Excluded Account IDs** is a comma-separated list of Jira account IDs; it checks the author on creation and the update author on edits.

**Fields** adds comma-separated Jira field IDs to the default issue fields. **Jira Domain** overrides the domain from the credential; the selected credential must have access to that Jira Cloud site. **Output Format** controls comment body and issue description when **Simplify** is enabled: Rendered HTML, Plain Text, Jira Wiki Markup, or Atlassian Document Format. Rendered HTML falls back to plain text if Jira omits rendered content. Treat rendered HTML as untrusted.

**Overlap (Minutes)** defaults to 5 and can be set from 1 to 1440. It rechecks a recent period to catch delayed search results. **Simplify** defaults to true and returns a smaller issue or comment shape. **Test Limit** bounds manual testing to 1 to 100 events, default 10; it does not limit scheduled polling.

## Position and recovery

The trigger saves its place in the workflow. Each Jira search or comment list read has a limit of 1,000 pages. If a poll reaches its time limit or page limit, events found so far are emitted and the next poll continues the search. A restart can lose progress that n8n has not yet saved.

The trigger counts issues it has examined as progress, even if they did not produce events. If the poll has made progress and a retry wait cannot fit within the remaining poll time, it emits any events found so far, saves its position and reports a warning with Jira's status. If it has made no progress, the poll fails with an error. Other exhausted or overlong retries fail with an error. Authentication, permission and missing-resource errors (401, 403 and 404) fail the poll.

The trigger stores its position with the workflow. Reactivating it with the same settings resumes from the last saved position. Changing the JQL, Jira site, resource, event type or credential starts from now, so earlier changes are not replayed. Changing display and filtering options such as **Fields**, **Output Format**, **Simplify**, **Comment Visibility**, **Excluded Account IDs** or **Overlap (Minutes)** does not reset the position.

## Duplicates and practical limits

Events can occasionally be repeated after a crash, a restored workflow, overlapping polls on multiple processes or a long period of heavy load. Every output has an `eventId` that identifies the event. The most reliable downstream setup is a destination that treats `eventId` as an idempotency key or upserts each record using `eventId` as its unique key.

The trigger's own recent-event protection remembers up to 40,000 events. Once full, it warns and removes the oldest entries, so older events can be repeated. If more than 40,000 issues share the same creation time, polling fails; narrow your JQL query to reduce the number of matching issues.

You can also use n8n's **Remove Duplicates** node. Set **Operation** to **Remove Items Processed in Previous Executions**, configure **Value Is New** to compare `{{ $json.eventId }}`, and set **Scope** to **Node**. This node keeps a history of seen values. If that history fills, the workflow errors. Choose a generous history size for your event volume and retention period, and schedule a **Clear Deduplication History** node to run regularly so the history is cleared before the limit is reached. Clearing it allows previously seen events through again, so the destination should still handle repeats safely.

If two scheduled polls overlap in the same process, the later invocation warns and returns no data while the first poll is running. Separate processes cannot coordinate their in-flight polls, so overlapping polls across processes can repeat events.

## Credentials and OAuth2

Use n8n's Jira SW Cloud API token or Jira SW Cloud OAuth2 API credential. The Jira account must be able to browse the projects selected by your JQL query.

## Comments

Comment mode reads comments included in each issue search result and requests more comment pages only when Jira returned an incomplete comment list. Comment creation or editing usually changes the parent issue's `updated` time, which is how the trigger finds comment events. This behaviour has not yet been confirmed on a live Jira site.

## Errors and retries

The node retries temporary failures, including rate limits, server errors and timeouts (408, 429, 500, 502, 503 and 504), up to three times. It honours `Retry-After` up to 60 seconds per retry. Retry waits are never shortened to fit the time left: if a wait cannot fit, the poll ends. When the poll has made progress, it emits any events found so far, saves its position and reports a warning with Jira's status. Without progress, it fails with an error. Exhausted retries, or a wait that fits the time left but exceeds 60 seconds, fail with an error. Authentication, permission and missing-resource responses (401, 403 and 404) fail the poll.

If Jira reports that an issue disappeared during a read, the node first checks that the credential still works. It skips the missing issue only after Jira returns 404 for that issue; authentication and permission failures remain errors.

## Manual test

Manual testing does not read or change the saved position for scheduled polling. It searches issues updated in the last 30 days, reads at most 100 issues and two comment pages per issue, and stops at **Test Limit**. An empty test result does not prove that scheduled polling has no events outside those bounds.

## Poll time limit and scheduling

The trigger follows n8n's poll time limit when n8n provides one; otherwise, it uses a five-minute limit. Jira request timeouts are capped to the time remaining. Retry waits are never shortened, and a wait that does not fit ends the poll.

When `N8N_SCHEDULER_ENABLED` and `N8N_SCHEDULER_POLL_TRIGGERS_ENABLED` are enabled while `N8N_POLLER_DURABLE_CURSORS_ENABLED` is off (the default), a quiet poll does not save progress. Progress is saved only when events are emitted. The activation-to-first-poll gap in multi-main durable scheduler setups can also lose events during handover; a restart in that gap can do the same.
