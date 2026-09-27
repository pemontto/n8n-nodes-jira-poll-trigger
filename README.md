# n8n-nodes-jira-poll-trigger

This is an n8n community node. It starts a workflow when an issue or a comment is created or updated in Jira Cloud.

The built-in Jira Trigger uses webhooks. A webhook needs permission to register webhooks in Jira, and Jira must be able to reach your n8n instance. This node does not need either. It polls Jira on a schedule and asks for the changes since the last poll. It needs only read access to the issues and comments that you want to watch.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Known limits](#known-limits)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. The package name is `n8n-nodes-jira-poll-trigger`.

## Operations

The node has one trigger, Jira Poll Trigger. Select a resource and an event:

| Resource | Created       | Updated              | Created or Updated |
| -------- | ------------- | -------------------- | ------------------ |
| Issue    | A new issue   | A change to an issue | Both               |
| Comment  | A new comment | An edit to a comment | Both               |

A JQL query limits the issues that the node watches. For comments, the query selects the parent issues.

## Credentials

This package has no credential type of its own. It uses the Jira credentials that come with n8n:

- API Token uses the Jira SW Cloud API credential. This is the default.
- OAuth2 uses the Jira SW Cloud OAuth2 API credential.

To make an API token, follow [Manage API tokens for your Atlassian account](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/). The Jira account needs permission to browse the projects that you watch.

## Compatibility

The node works with Jira Cloud only. It does not support Jira Server or Jira Data Center.

The node uses version 1 of the n8n nodes API. The tests ran against n8n 2.38.1. On n8n 2.38.0 and later, each poll stays inside the time limit that n8n gives it. For more information, read [How it works](https://github.com/pemontto/n8n-nodes-jira-poll-trigger/blob/main/docs/how-it-works.md#time-limit-for-each-poll).

## Usage

### Set up the trigger

1. Add Jira Poll Trigger to a new workflow.
2. Select an Authentication method and a Jira credential.
3. Select a Resource and an Event.
4. Optional: enter a JQL query, for example `project = SUP AND status != Done`. Do not add `ORDER BY`. If you leave the query empty, the node watches all issues that the account can see.
5. Set Poll Times. The default is every minute.
6. Click Test step to see sample events.
7. Activate the workflow.

When you activate the workflow, the node runs one search to make sure that the query and the credential work. If the search fails, activation fails and shows the error from Jira. The node then starts from the time of activation. It does not send events for older changes.

### Options

| Option               | Default        | What it does                                                                                                                                                                         |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Comment Visibility   | All Accessible | Customer-Visible Only keeps only the public comments in Jira Service Management.                                                                                                     |
| Excluded Account IDs | Empty          | A comma-separated list of Atlassian account IDs. The node ignores comments from these accounts, for example your own automation account.                                             |
| Fields               | Empty          | Extra Jira field IDs to add to each event, for example `priority,customfield_10010`.                                                                                                 |
| Jira Domain          | Empty          | A site to use instead of the site in the credential.                                                                                                                                 |
| Output Format        | Rendered HTML  | The format for comment bodies and issue descriptions: Rendered HTML, Plain Text, Jira Wiki Markup, or Atlassian Document Format.                                                     |
| Overlap (Minutes)    | 5              | Each poll searches again this far back, to find changes that Jira indexed late. The node remembers the events that it sent in this period, so the overlap does not cause duplicates. |
| Simplify             | On             | Returns a short set of fields. Turn it off to get the full Jira objects and event metadata.                                                                                          |
| Test Limit           | 10             | The largest number of events that Test step returns, from 1 to 100. Test step searches issues updated in the last 30 days.                                                           |

If you use Rendered HTML output, show it only in a place that handles untrusted HTML safely.

### Output

With Simplify on, a comment event looks like this:

```json
{
	"id": "10421",
	"body": "<p>The fix is deployed.</p>",
	"author": { "accountId": "5b10a2844c20165700ede21g", "displayName": "Alex Example" },
	"created": "2026-09-01T10:15:00.000+0000",
	"updated": "2026-09-01T10:15:00.000+0000",
	"updateAuthor": { "accountId": "5b10a2844c20165700ede21g", "displayName": "Alex Example" },
	"issueId": "10087",
	"issueKey": "SUP-42",
	"summary": "Login page returns an error",
	"status": "In Progress"
}
```

An issue event has `id`, `key`, `projectKey`, `summary`, `description`, `status`, `created`, `updated`, and any extra fields that you selected.

With Simplify off, each event also has `eventType`, `eventId`, and `eventTime`. Use `eventType` to tell a creation from an update when you select Created or Updated. Use `eventId` to remove duplicates in later steps.

### Example: send new comments to Slack

1. Set Resource to Comment and Event to Created.
2. Set JQL to `project = SUP`.
3. In Options, set Output Format to Plain Text.
4. In Excluded Account IDs, enter the account ID of your automation user. This stops a loop when the workflow itself writes comments.
5. Add a Slack node after the trigger. Set the message text to `{{ $json.issueKey }}: {{ $json.author.displayName }} wrote {{ $json.body }}`.

## Known limits

- The node polls, so events arrive up to one poll interval late.
- If a comment changes several times between two polls, you get one update event with the latest text. The node cannot see the earlier text.
- JQL uses the current state of an issue. For example, `status = Open` misses the change that moves an issue out of Open. If you need that change, use a wider query and filter in the workflow.
- Deleted issues and deleted comments do not produce events.
- If you change the site, credential account, JQL, resource, or event, the node starts again from the time of the change. Changes made before then do not produce events.
- If n8n runs two polls of the same workflow at the same time, some events can arrive twice. Use `eventId` to remove duplicates if this matters.
- Some older n8n schedulers can lose the saved position after a poll that finds nothing. The node then starts again from the next poll, and changes in the gap do not produce events.

[How it works](https://github.com/pemontto/n8n-nodes-jira-poll-trigger/blob/main/docs/how-it-works.md) explains the polling window, recovery after an outage, and the limits for very large backlogs.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Jira Cloud REST API: search for issues using JQL](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [JQL reference](https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/)
- [How it works](https://github.com/pemontto/n8n-nodes-jira-poll-trigger/blob/main/docs/how-it-works.md)

## Version history

### 0.1.0

This is the first release. The node has full automated tests against a simulated Jira. Tests against a live Jira site are not complete. Try it on a test workflow before you depend on it.
