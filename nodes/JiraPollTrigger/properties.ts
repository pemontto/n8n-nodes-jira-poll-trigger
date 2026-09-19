import type { INodeProperties } from 'n8n-workflow';

export const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		noDataExpression: true,
		type: 'options',
		options: [
			{ name: 'Issue', value: 'issue' },
			{ name: 'Comment', value: 'comment' },
		],
		default: 'comment',
	},
	{
		displayName: 'Event',
		name: 'event',
		type: 'options',
		options: [
			{ name: 'Created', value: 'created' },
			{ name: 'Updated', value: 'updated' },
			{ name: 'Created or Updated', value: 'createdOrUpdated' },
		],
		default: 'createdOrUpdated',
		description:
			'Creation and update are separate events. Issue updates can include comment activity.',
	},
	{
		displayName: 'JQL',
		name: 'jql',
		type: 'string',
		default: '',
		placeholder: 'project = EXAMPLE',
		description:
			'Issues that currently match this query. Leave empty for all accessible issues. Omit ORDER BY. Queries such as status = Open miss changes after issues leave the query.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Comment Visibility',
				name: 'visibility',
				type: 'options',
				displayOptions: { show: { '/resource': ['comment'] } },
				options: [
					{ name: 'All Accessible', value: 'all' },
					{ name: 'Public Only', value: 'public' },
				],
				default: 'all',
				description:
					'Public only excludes internal comments and comments whose public visibility is unknown',
			},
			{
				displayName: 'Excluded Account IDs',
				name: 'excludedAccountIds',
				type: 'string',
				displayOptions: { show: { '/resource': ['comment'] } },
				default: '',
				description:
					'Comma-separated Jira account IDs. Checks the author for creation and the update author for edits.',
			},
			{
				displayName: 'Fields',
				name: 'additionalFields',
				type: 'string',
				default: '',
				placeholder: 'priority,customfield_10000',
				description:
					'Comma-separated field IDs to include with summary, description, status, created and updated. Issue ID and key are always included.',
			},
			{
				displayName: 'Jira Domain',
				name: 'domain',
				type: 'string',
				default: '',
				placeholder: 'https://example.atlassian.net',
				description:
					'Override the credential domain for this node. Leave empty to use the credential domain. The selected credential must have access to this Jira Cloud site.',
			},
			{
				displayName: 'Output Format',
				displayOptions: { hide: { '/options.simplify': [false] } },
				name: 'outputFormat',
				type: 'options',
				default: 'rendered',
				options: [
					{ name: 'Rendered HTML', value: 'rendered' },
					{ name: 'Plain Text', value: 'text' },
					{ name: 'Jira Wiki Markup', value: 'wiki' },
					{ name: 'Atlassian Document Format', value: 'adf' },
				],
				description:
					'Format for comment body and issue description when Simplify is enabled. Rendered HTML falls back to plain text if Jira omits the rendered value.',
			},
			{
				displayName: 'Overlap (Minutes)',
				name: 'overlapMinutes',
				type: 'number',
				default: 5,
				typeOptions: { minValue: 1, maxValue: 1440 },
				description:
					'Recheck this period for delayed search results. Changes delayed longer than the overlap can be missed.',
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description:
					'Whether to return a simplified version of the response instead of the raw data',
			},
			{
				displayName: 'Test Limit',
				name: 'testLimit',
				type: 'number',
				default: 10,
				typeOptions: { minValue: 1, maxValue: 100, numberPrecision: 0 },
				description:
					'Maximum events returned when testing manually. Scheduled polling returns all matching events. Manual search is bounded and may return fewer events.',
			},
		],
	},
	// Legacy top-level settings, superseded by Options. They are declared so a
	// value still merged by the poll stays visible in the workflow JSON view.
	{ displayName: 'Simplify', name: 'simplify', type: 'hidden', default: true },
	{ displayName: 'Jira Domain', name: 'domain', type: 'hidden', default: '' },
	{ displayName: 'Comment Visibility', name: 'visibility', type: 'hidden', default: 'all' },
	{
		displayName: 'Excluded Account IDs',
		name: 'excludedAccountIds',
		type: 'hidden',
		default: '',
	},
	{ displayName: 'Fields', name: 'additionalFields', type: 'hidden', default: '' },
	{
		displayName:
			'Activation starts from now. Changing credentials, domain or filters resets this boundary. Manual testing returns up to the test limit from a bounded search without advancing scheduled polling.',
		name: 'activationNotice',
		type: 'notice',
		default: '',
	},
];
