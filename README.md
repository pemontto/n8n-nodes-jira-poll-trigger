# Jira Poll Trigger

A Jira Cloud polling trigger for issues and comments. It reuses n8n's installed `jiraSoftwareCloudApi` credential and needs ordinary issue/comment read access. It does not register webhooks.

## Readiness

This package is an implementation under verification, not ready for production. Testing against isolated n8n 2.38.1 exposed host behaviour that prevents the requested durable polling contract: activation discards an empty poll's state, and overlapping scheduler jobs can overwrite newer cursor state. Enabling durable polling alone does not resolve either problem. No n8n version or deployment mode is certified by this package yet. Do not use this release to replace customer workflows.

Live Jira acceptance also remains pending. A designated test issue and an n8n Jira credential are needed to verify that new comments and edits to old comments advance the parent issue timestamp and become discoverable through JQL. Synthetic fixtures cannot establish that tenant behaviour.

## Configuration

Select the existing Jira SW Cloud API credential. Use an HTTPS tenant domain such as `https://example.atlassian.net`. This package supports Cloud API tokens only, with no separate credential definition. Set Options → Jira Domain to override the credential's domain, or leave it blank to use the credential domain. One saved credential can serve multiple sites where that account and token have access. Changing the resolved domain resets polling from now; it does not change the saved credential.

Choose Issue or Comment, then Created, Updated, or Created or Updated. Standard n8n Poll Times default to every minute. Enter a JQL predicate without a top-level `ORDER BY`; quoted text containing those words is accepted. An empty predicate selects all accessible issues. The node groups the predicate before adding the lower polling timestamp constraint.

Comments default to all accessible visibility. Public Only includes only comments with `jsdPublic: true`; internal and unknown visibility are excluded. Comma-separated excluded account IDs apply to `author.accountId` for creation and `updateAuthor.accountId` for edits. They do not apply to issue events, because the issue response does not provide an equivalent update author.

Issue output includes top-level `id`, `key`, `projectKey`, `summary`, `description`, `status`, `created` and `updated`. Options → Fields accepts comma-separated Jira field IDs, including custom field IDs. Overlap defaults to five minutes and can be set between one minute and one day.

Manual testing returns up to Test Limit matching events (10 by default, configurable from 1 to 100) without reading or writing scheduled state. It searches parent issues updated within the last 30 days, scans at most 100 issues and two comment pages per issue, and stops when it reaches Test Limit. A sampled comment may have been created long before that period. No result within these limits does not prove that the query has no matching events.

## Events

Options → Simplify is on by default and returns essential fields for the selected resource. Comment events expose `id`, `body`, `author`, `created`, `updated` and `updateAuthor` at the top level, alongside `issueId`, `issueKey`, `summary` and `status`. Issue events expose their fields directly with no `issue` wrapper. Authors contain only `accountId` and `displayName`; `updateAuthor` is the account Jira records as the comment's last editor. Issue-only output includes issue creation and update timestamps. Use `$json.body` for message content, `$json.id` for the comment ID, `$json.author.displayName` for the writer and `$json.issueKey` for the parent issue. Comment output omits the parent issue description. Options → Output Format selects Rendered HTML (default), Plain Text, Jira Wiki Markup or Atlassian Document Format for both comment `body` and issue `description`. Rendered HTML uses Jira's rendered values, with readable text fallback if absent. Jira Wiki Markup uses Jira Cloud API v2's native string fields for both body and description. It does not convert ADF locally; newer editor features may have no equivalent in wiki markup. Rendered HTML remains the default. ADF preserves structured rich text; plain text removes the structure. Missing descriptions return an empty string. Selected extra issue fields are also top level; reserved event fields take precedence on name collisions. Render HTML only through a renderer that handles untrusted HTML safely.

Simplified output omits event metadata. In combined mode, creation and update can therefore return identical latest content. Turn Simplify off to distinguish events through `eventType`, `eventId` and `eventTime`, and for the full `issue: { id, key, fields }` and raw `comment`, including the structured Atlassian Document Format body, rendered body, authors and visibility metadata.

`eventId` identifies an observed creation or edit, not the Jira comment itself. Its readable format includes the site, resource, issue ID, optional comment ID, event type and epoch timestamp: `example.atlassian.net/comment/123/456/created/1787787964087`. Different sites and edits have distinct IDs. The internal deduplication key remains private to saved state; changing the public format does not replay already seen events.

Creation and update are independent checks. A comment created and edited between polls produces a creation event in Created mode, an update event in Updated mode, and both in combined mode. Both contain the latest body returned by Jira. The node cannot reconstruct the original body. Updates require `updated > created`; equal timestamps produce no edit event. The same rules apply to issues.

Each timestamp must fall within the inclusive interval from `max(activation, previous successful poll-start minus overlap)` to the current poll-start. If a comment was created before the poll-start but edited while pages were being read, its creation can emit now and its edit waits for the next poll. Issue Updated can include comment activity when Jira advances the issue's timestamp.

## Intended state contract and current host limits

The core establishes activation from now without historical emissions, resumes saved state after restart, and resets when credentials, JQL, resource, event, fields or filters change. Credential content changes are represented by a SHA-256 digest; raw tokens and email addresses are not stored in state. The node captures its boundary before network requests and returns replacement state only after every required page succeeds. Empty polls return `null`.

Deduplication keys contain resource identity, event type and event timestamp. Creation keys expire by creation time; edit keys expire by update time. Saved keys cover only the overlap. Raising Overlap therefore widens the next window past the retained keys, and events already delivered inside that wider window are emitted again. A hard limit of 40,000 keys also bounds each scan. Exceeding it fails without checkpoint advancement. Narrowing JQL resets from now and abandons the unread backlog; it is a recovery choice, not a way to replay that backlog.

The node serializes callbacks within one process and rejects snapshots that differ from its last returned replacement. It never restores cached state or treats it as proof of a durable commit. This detects stale or discarded state within the process, but cannot provide cross-process cursor safety. On the tested host, discarded activation causes subsequent polls to fail explicitly instead of silently moving the activation boundary. Restarting repeats that host limitation. The host must persist activation state, commit successful empty polls independently of downstream execution, and reject stale concurrent commits. Actual n8n 2.38.1 tests passed scheduled empty-poll and downstream-failure persistence with its experimental scheduler flags, but failed activation persistence and overlapping-job safety. Default legacy scheduling does not provide the required empty-poll durability. The implementation uses only `getWorkflowStaticData('node')`; it does not call internal cursor methods.

## Limits of Jira polling

JQL membership reflects current state. For example, `status = Open` can miss a change that moves an issue out of Open. Search is eventually consistent; indexing delays longer than the overlap can be missed. Issue search uses the lower updated boundary and evaluates event upper bounds locally. Comment mode reads every comment page on each candidate issue, including old comments, because comment ordering is by creation time.

The node retries transient read failures up to three times and honours `Retry-After` within a 60-second per-retry wait budget. A longer server wait fails the poll without shortening the requested delay. Incomplete, malformed or non-progressing pagination fails the whole scan.

This is not exactly-once delivery. Multiple edits between reads can collapse into one update, equal-timestamp edits cannot be distinguished, and deleted or inaccessible comments cannot be recovered. Formatting, RT mapping, attachments and writes remain downstream. Existing workflows that first derive JQL from RT are not necessarily replaceable with a trigger.

## Development

Run `npm install`, `npm test`, `npm run lint` and `npm run package:check` from this directory. Tests use synthetic data and do not contact Jira. Build output is the only runtime code included in the package; test captures and credentials are excluded. Nothing has been published or deployed.

Simplified Issue output includes `projectKey` from Jira's `fields.project.key`, independently of the issue key. If Jira omits it, the value is an empty string.
