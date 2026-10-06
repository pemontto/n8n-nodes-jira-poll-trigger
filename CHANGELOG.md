# Changelog

## 0.1.0 (unreleased)

- Poll Jira Cloud issues and comments on a schedule using n8n's built-in Jira credentials.
- Choose the Jira site, JQL query, resource, event types and returned fields. Control comment visibility, simplification and comment and description output formats.
- Include `eventId`, `eventType` and `eventTime` with every event so downstream workflows can identify and safely handle repeats.
- Continue polling after time or page limits, and retry temporary Jira rate-limit, server and timeout errors. Report authentication, permission and missing-resource errors.
