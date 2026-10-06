# n8n-nodes-jira-poll-trigger

An n8n community node for Jira Cloud. It works like the built-in Jira Trigger, but polls a JQL query instead of using a webhook. Registering a Jira webhook needs Jira admin rights and an n8n instance that Jira can reach. This trigger needs neither: read access to the issues you watch is enough.

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/). The package name is `n8n-nodes-jira-poll-trigger`.

## Events

| Resource | Created       | Updated              | Created or Updated |
| -------- | ------------- | -------------------- | ------------------ |
| Issue    | A new issue   | A change to an issue | Both               |
| Comment  | A new comment | An edit to a comment | Both               |

A JQL query, such as `project = SUP AND status != Done`, limits which issues are watched. For comments, it selects the parent issues. Leave it empty to watch every issue the account can see.

## Credentials

Uses n8n's built-in Jira SW Cloud API (API token) or Jira SW Cloud OAuth2 API credential. The account needs permission to browse the watched projects.

## Compatibility

Jira Cloud only. Tested with n8n 2.38.1.

## Known limits

- Events arrive up to one poll interval late.
- Several edits between polls produce one update event with the latest state.
- JQL matches the current state, so `status = Open` misses the change that moves an issue out of Open.
- Deletions do not produce events.
- On first activation, polling starts from that moment. Reactivating with unchanged settings resumes from the last saved position. Changing the JQL, Jira site, resource, event or credential starts from now; earlier changes are not replayed.
- Rendered HTML output (the default) is untrusted. Display it only where untrusted HTML is handled safely.
- Every output includes `eventId`, `eventType` and `eventTime`. Use `eventId` as the destination's idempotency key, or upsert records by `eventId`, so a repeated event does not create a duplicate.
- For downstream deduplication in n8n, see [Remove Duplicates setup and recovery limits](docs/how-it-works.md#duplicates-and-practical-limits). Its history can fill and stop the workflow unless you allow generous capacity and schedule regular history clearing.
- With `N8N_SCHEDULER_ENABLED` and `N8N_SCHEDULER_POLL_TRIGGERS_ENABLED` on and `N8N_POLLER_DURABLE_CURSORS_ENABLED` off (its default), n8n saves progress only when a poll emits events. Multi-main durable scheduler setups and restarts may miss changes between activation and the first scheduled poll.
- A poll interrupted by its time limit or page limit continues on a later poll. See [polling and recovery](docs/how-it-works.md#position-and-recovery) for how interruptions and Jira errors affect progress.

[How it works](https://github.com/pemontto/n8n-nodes-jira-poll-trigger/blob/main/docs/how-it-works.md) covers the polling window, duplicates and recovery after an outage.

## Version history

### 0.1.0 (unreleased)

First release. Poll Jira Cloud issues and comments on a schedule, with configurable JQL, event types, comment visibility, fields and output format. Events include stable identifiers for downstream idempotence. Polling resumes after an interruption, and transient Jira errors are retried.
