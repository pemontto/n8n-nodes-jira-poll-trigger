# How it works

This document explains how Jira Poll Trigger finds events, keeps its position, and recovers after an outage. The [README](../README.md) covers setup and use.

## Polling window

Each scheduled poll searches Jira for issues in a time window. The window starts at the last saved position minus the overlap. It ends at the time that the poll started. The node never starts the window before the time of activation.

The search uses this JQL, with your query in the brackets:

```
(your query) AND updated >= <start> AND created <= <end> ORDER BY created ASC, key ASC
```

The node then compares each event timestamp with the window in code. An event is a creation or an update of an issue or a comment. An update counts only when `updated` is later than `created`.

Events arrive in the order of issue creation time, then issue key. This order does not change when an issue changes, so a long backlog always drains from its oldest issue. Event times can be in a different order. If you need strict time order, sort on `eventTime` with Simplify off.

## Duplicates

The node saves a key for each event that it sent in the overlap period. A key has the site, the resource, the issue ID, the comment ID for comments, the event type, and the event time. A later poll that finds the same event skips it. Keys expire after the overlap period.

If you increase Overlap, the next window reaches further back than the saved keys. Events already sent in that extra period can then arrive again.

`eventId` is readable. For example, `example.atlassian.net/comment/123/456/created/1787787964087` is a comment creation. Two edits of one comment have different event IDs.

## Saved state

The node keeps its position in the workflow static data. It does not keep raw tokens or email addresses. It keeps a SHA-256 digest of the credential identity.

The node starts again from the current time when one of these changes:

- The site
- The credential, or the email in an API token credential
- The JQL
- The resource
- The event

A new API token in the same credential does not reset the position. Changes to Fields, Output Format, Simplify, Comment Visibility, or Excluded Account IDs do not reset it either. For OAuth2, the identity is the credential ID, the site, and the Atlassian cloud ID. If you reconnect the same OAuth2 credential as a different Atlassian account, the node does not detect it.

A poll that finds nothing returns no data. The node saves a new position only after it read every page that it needed.

## OAuth2

With OAuth2, the node finds the cloud ID of the site through `https://api.atlassian.com/oauth/token/accessible-resources`. It then sends each request to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/...`. The node keeps the cloud ID in memory for each credential until n8n restarts.

The Atlassian gateway returns 403 or 404 for an expired token, not 401. For this reason, the node asks n8n to refresh the token after a 403. If that request fails with 401 or 404, the node refreshes once more. A revoked token still fails with a visible error.

## Comments

In Comment mode, the node reads the comments that Jira includes in each search result. It asks for more comment pages only when an issue has more comments than Jira included.

Customer-Visible Only keeps comments with `jsdPublic: true`. It removes internal comments and comments with unknown visibility. Excluded Account IDs compares `author.accountId` for new comments and `updateAuthor.accountId` for edits. It does not apply to issue events.

A new comment or an edit to a comment usually changes the `updated` time of its issue. This is how the node finds comment events. This behaviour is not yet confirmed on a live Jira site.

## Test step

Test step does not read or change the saved position. It searches issues updated in the last 30 days, newest first. It reads at most 100 issues and two comment pages for each issue. It stops at Test Limit. If Test step returns nothing, the query can still have events outside these limits.

## Errors and retries

The node retries a failed read up to three times when Jira returns 408, 429, 500, 502, 503, or 504. It waits as long as Jira asks in `Retry-After`, up to 60 seconds for each retry. If Jira asks for a longer wait, the poll fails.

Errors keep the HTTP status and the messages from Jira. Authentication, permission, timeout, and rate-limit errors always appear as errors. A poll that cannot move forward fails with an error that names the site, the resource, and the position.

If an issue that the node was reading is deleted, the node first makes sure that the credential still works. It drops the issue only if Jira then returns 404 for it. A 403 stays an error.

## Time limit for each poll

On n8n 2.38.0 and later, n8n gives each scheduled poll a time limit, about 36 seconds on the durable scheduler. The node limits every request and every retry wait to the time that is left.

When the time runs out, the node sends the events that it already processed. It saves its position, and the next poll continues from there. The position is the creation minute of the last issue, plus the keys and IDs of the issues that it handled in that minute. Jira compares `created` to the minute, so the node skips the handled issues in code. It never puts issue keys in the JQL, so a deleted issue cannot make the search fail.

When a poll stops in the middle of the search results, the next poll reads the last page again. It makes sure that the page still has the last handled issue, then continues after that issue. This step makes sure that no issue is skipped when other issues change between polls.

On older n8n versions, there is no time limit. One poll reads the whole window.

## Large backlogs

The node handles at most 40,000 events in one window. At that limit, it sends what it processed and continues in the next poll.

Two cases can stop the node with an error:

- One search page takes more than about half of the time limit, and 100 or more issues share one creation minute.
- Jira page tokens expire between polls, and more than about 1,200 issues share one creation minute.

In both cases, the error names the resource and the position. To recover, give n8n a longer time limit, or narrow the JQL. A new JQL resets the position, so the node does not send the events in the unread backlog.

## Running two polls at once

The node runs only one poll at a time in each n8n process. It cannot coordinate across processes. Sometimes n8n runs two polls of one workflow at the same time in different processes. Both polls can then send the events that they read, and the last saved position wins. Events in that period can arrive twice.

## Scheduler limits

n8n must save the position after a poll that finds nothing. Some older schedulers do not. The node then starts again from the next poll, and changes in the gap do not produce events.

## Development

Run these commands in the package folder:

```
npm install
npm test
npm run lint
npm run package:check
```

The tests use a simulated Jira server and never contact a real Jira site. The published package contains only the build output.
