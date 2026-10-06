# n8n-nodes-jira-poll-trigger

Start an n8n workflow when a Jira Cloud issue or comment is created or changed.

n8n's built-in Jira Trigger relies on a Jira webhook. Setting one up needs a Jira admin, and Jira has to be able to reach your n8n instance over the internet. This trigger doesn't need either. It asks Jira for recent changes on a schedule, so all it needs is an account that can see the issues you care about.

## Installation

Follow n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) and install `n8n-nodes-jira-poll-trigger`.

## What it watches

| Resource | Created       | Updated              | Created or Updated |
| -------- | ------------- | -------------------- | ------------------ |
| Issue    | A new issue   | A change to an issue | Both               |
| Comment  | A new comment | An edited comment    | Both               |

Use a JQL query to choose which issues to watch, for example `project = SUP AND status != Done`. For comments, the query chooses the issues whose comments you want. Leave it empty to watch every issue the account can see.

## Credentials

Use n8n's built-in **Jira SW Cloud API** (API token) or **Jira SW Cloud OAuth2 API** credential. The account only needs permission to browse the projects you're watching.

## Compatibility

Jira Cloud only. Tested with n8n 2.38.1.

## How it differs from the webhook trigger

**It doesn't tell you what changed.** The webhook trigger sends the old and new values with each change. This trigger sends the issue as it looks now. When an issue moves from In Progress to Done, you get an update event showing it in Done, but nothing saying it used to be In Progress.

**Your JQL decides what it can see.** The query is run against issues as they are now, not as they were. If you watch `status != Done` and an issue is moved to Done, it no longer matches, so you never hear about that move. If you want to know when issues are finished, leave status out of the JQL and filter in your workflow instead.

**Changes arrive in batches.** Events can be up to one poll interval late. If an issue is edited three times between polls, you get one update with the final state.

**Deletions aren't reported.** A deleted issue or comment simply stops appearing.

## Where it starts

The first time you activate the workflow, the trigger starts from that moment. Nothing that happened before is sent.

If you deactivate and reactivate it without changing anything, it carries on from where it stopped. If you change the JQL, Jira site, resource, event or credential, it starts fresh from now, and anything that happened in between is skipped.

If a poll runs out of time or hits its page limit, it sends what it found so far and picks up the rest next time. [How it works](docs/how-it-works.md#position-and-recovery) explains what happens when Jira returns errors or n8n restarts.

## Handling the occasional repeat

Every event carries an `eventId`, an `eventType` (such as `issue.updated`) and an `eventTime`. The `eventId` stays the same if an event is ever sent twice, which can happen after a crash, a restore, or a long stretch of heavy load.

The simplest protection is to make the place you send events to ignore repeats: use `eventId` as an idempotency key, or update records by `eventId` instead of always inserting new ones.

You can also use n8n's Remove Duplicates node, but it keeps a history that can fill up and stop the workflow. See [duplicates and practical limits](docs/how-it-works.md#duplicates-and-practical-limits) for how to set it up safely.

## Things to watch out for

**HTML output isn't safe to display as is.** By default, descriptions and comments come back as rendered HTML written by Jira users. Only show it somewhere that handles untrusted HTML safely, or set **Output Format** to Plain Text.

**Some scheduler setups can miss early changes.** If you've turned on `N8N_SCHEDULER_ENABLED` and `N8N_SCHEDULER_POLL_TRIGGERS_ENABLED` but left `N8N_POLLER_DURABLE_CURSORS_ENABLED` off (its default), n8n only saves the trigger's position when a poll sends events. On multi-main setups using the durable scheduler, or after a restart, changes made between activation and the first scheduled poll can be missed.

## More detail

[How it works](https://github.com/pemontto/n8n-nodes-jira-poll-trigger/blob/main/docs/how-it-works.md) covers the polling window, every option, duplicates, and recovery after an outage.

## Version history

### 0.1.0 (unreleased)

First release. Watches Jira Cloud issues and comments on a schedule, with your choice of JQL, events, comment visibility, fields and output format. Every event has a stable ID so downstream systems can ignore repeats. Polling picks up where it left off after an interruption, and temporary Jira errors are retried.
