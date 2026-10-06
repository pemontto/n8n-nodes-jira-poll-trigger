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
- Activation, and any change to the JQL, resource, event or credential, starts from that moment. Earlier changes are not replayed.
- Rendered HTML output (the default) is untrusted. Display it only where untrusted HTML is handled safely.

[How it works](https://github.com/pemontto/n8n-nodes-jira-poll-trigger/blob/main/docs/how-it-works.md) covers the polling window, duplicates and recovery after an outage.

## Version history

### 0.1.0

First release.
