# How it works

This guide explains how Jira Poll Trigger finds events, keeps its position, and recovers after an interruption. The [README](../README.md) covers setup and use.

## Polling window

Each scheduled poll searches Jira from the saved checkpoint minus **Overlap (Minutes)** to the time the poll began. The first window starts at activation. Jira results are read oldest first by issue creation time and key, so newer results do not starve an older backlog. Event times can differ from this scan order; sort on `eventTime` if you need time order.

JQL selects issues in their current state. A query such as `status = Open` can stop matching an issue after it leaves Open. Leave `ORDER BY` out of JQL; the node sets the order it needs. Delayed Jira search results later than the configured overlap can be missed.

The trigger reports issue or comment creation and updates according to **Resource** and **Event**. An update counts only when its `updated` time is later than its `created` time. Several edits between polls can appear as one update containing the latest state. Deletions do not produce events.

Every output mode, including Simplify, includes top-level `eventId`, `eventType`, and `eventTime`. Event types are `issue.created`, `issue.updated`, `comment.created`, and `comment.updated`. `eventTime` is an ISO timestamp. `eventId` is built from the URI-encoded site hostname, resource, issue ID, optional comment ID, event type suffix, and exact event time in milliseconds. For example, a comment creation has the shape `example.atlassian.net/comment/123/456/created/1787787964087`.

## Options

**Comment Visibility** applies to comments. **All Accessible** includes all comments returned by Jira. **Customer-Visible Only** includes comments marked public and excludes internal or unknown visibility. **Excluded Account IDs** is a comma-separated list of Jira account IDs; it checks the author on creation and the update author on edits.

**Fields** adds comma-separated Jira field IDs to the default issue fields. **Jira Domain** overrides the domain from the credential; the selected credential must have access to that Jira Cloud site. **Output Format** controls comment body and issue description when **Simplify** is enabled: Rendered HTML, Plain Text, Jira Wiki Markup, or Atlassian Document Format. Rendered HTML falls back to plain text if Jira omits rendered content. Treat rendered HTML as untrusted.

**Overlap (Minutes)** defaults to 5 and can be set from 1 to 1440. It rechecks a recent period to catch delayed search results. **Simplify** defaults to true and returns a smaller issue or comment shape. **Test Limit** bounds manual testing to 1 to 100 events, default 10; it does not limit scheduled polling.

## Position and recovery

The saved cursor uses an exact epoch millisecond creation timestamp and the IDs already handled at that exact timestamp. Jira bounds use exact millisecond values, and the node filters results to continue from that precise cursor. It does not persist Jira page tokens. Each search or comment list read has a cap of 1,000 pages. After a time-budget or page-cap stop, the completed prefix is emitted and the next poll resumes the same fixed window from the saved cursor.

The node commits progress only after a successful poll. If a Jira API request fails, the poll fails with Jira's HTTP status and error details, and it does not commit partial progress from that poll. Authentication, permission, rate-limit, server, and timeout failures remain visible errors.

The node stores its position in workflow static data. Its saved state includes a digest of credential identity, not raw tokens or email addresses. Changing the site, credential identity, JQL, resource, or event starts a fresh baseline. For API token credentials, the email is part of credential identity; changing only the token does not reset the cursor. For OAuth2, identity uses the credential ID, site, and Atlassian cloud ID, so reconnecting the same credential as a different Atlassian account is not detected. Changes to **Fields**, **Output Format**, **Simplify**, **Comment Visibility**, **Excluded Account IDs**, and **Overlap (Minutes)** do not reset the cursor.

At activation, the initial baseline is kept in process memory until the first state commit. If the runtime does not persist activation's empty state, the baseline remains available to that running process; a restart before a later commit can lose it and establish a new baseline. Older or unrecognised saved state starts from a fresh baseline; it is not migrated.

## Duplicates and practical limits

The recent-event cache holds up to 40,000 keys. When it fills, the oldest keys are evicted with a warning; cursor IDs are kept separately and are never evicted. Normal polls deduplicate overlap reads within the poll and against recent keys, so routine overlap does not repeat events. A repeat remains possible after a crash, state restore, cross-process overlap, or overload that outlasts the recent-key cache. Increasing **Overlap (Minutes)** can also re-read events that are no longer in the cache.

Cursor IDs are bounded separately at 40,000 issues sharing an exact creation timestamp. A poll that cannot reach new work within its budget fails with the site, resource and saved position. Give it more time or narrow the JQL; changing the JQL starts a fresh baseline.

Delivery is therefore at least once, with rare repeats possible. Use the stable top-level `eventId` to deduplicate downstream, and prefer an idempotent destination. In n8n's **Remove Duplicates** node, set **Scope** to **Node** and compare `eventId`. Set its history size to cover several days of expected events. Once the history is full, that node errors until its history is cleared or enlarged.

If two scheduled polls overlap in the same process, the later invocation warns and returns no data while the first poll is running. Separate processes cannot coordinate their in-flight polls, so cross-process overlap can produce repeats; the last committed state wins.

## Credentials and OAuth2

The node uses n8n's Jira SW Cloud API token or Jira SW Cloud OAuth2 API credential. OAuth2 resolves the site's cloud ID through Atlassian's accessible-resources endpoint and sends Jira requests through the Atlassian API gateway. The cloud ID is cached in process memory until n8n restarts. Expired OAuth2 tokens may surface as 403 or 404 at the gateway; the node asks n8n to refresh and retries once. A revoked token still fails visibly.

## Comments

Comment mode reads comments included in each issue search result and requests more comment pages only when Jira returned an incomplete comment list. Comment creation or editing usually changes the parent issue's `updated` time, which is how the trigger finds comment events. This behaviour has not yet been confirmed on a live Jira site.

## Errors and retries

The node retries a failed read up to three times for HTTP 408, 429, 500, 502, 503, or 504. It honours `Retry-After` up to 60 seconds per retry; a longer requested wait fails the poll. Errors retain Jira's HTTP status and error details. A real API failure is not treated as a budget stop and does not commit partial progress.

If Jira reports that an issue disappeared during a read, the node first checks that the credential still works. It skips the missing issue only after Jira returns 404 for that issue; authentication and permission failures remain errors.

## Manual test

Manual testing does not read or change the scheduled cursor. It searches issues updated in the last 30 days, reads at most 100 issues and two comment pages per issue, and stops at **Test Limit**. An empty test result does not prove that scheduled polling has no events outside those bounds.

## Poll budget and scheduling

When n8n provides `getPollBudgetMs()`, the node uses that budget and caps requests and retry waits to the time remaining. Hosts without that method use a 5-minute budget, so the node has one reader budget across hosts. A time-budget or page-cap stop returns the completed prefix and resumes the same fixed window on the next poll. A real API error fails the poll and leaves the previous committed cursor intact.

The runtime must persist workflow static data for cursor progress to survive restarts. The node relies on the host's normal scheduled-poll lifecycle; consult the n8n version's documentation if state persistence or activation behaviour differs in your deployment.
