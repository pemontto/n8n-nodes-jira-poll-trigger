import type { PollEvent } from './poll-state';

function plainText(value: unknown): string {
	if (typeof value === 'string') return value;

	if (!value || typeof value !== 'object') return '';
	const node = value as Record<string, unknown>;

	if (node.type === 'hardBreak') return '\n';

	if (node.type === 'mention') {
		// SAFETY: Mention attributes are only read for their optional text property; no value type is assumed.
		const attrs = node.attrs as Record<string, unknown> | undefined;

		return typeof attrs?.text === 'string' ? attrs.text : '';
	}

	const text = typeof node.text === 'string' ? node.text : '';
	const children = Array.isArray(node.content) ? node.content.map(plainText).join('') : '';

	return (
		text +
		children +
		(['paragraph', 'heading', 'listItem', 'codeBlock'].includes(String(node.type)) ? '\n' : '')
	);
}

export type OutputFormat = 'rendered' | 'text' | 'adf' | 'wiki';

function content(body: unknown, rendered: unknown, format: OutputFormat): unknown {
	if (format === 'wiki') {
		if (body === undefined || body === null) return '';

		if (typeof body !== 'string')
			throw new Error('Jira did not return wiki markup text. Select another Output Format.');

		return body;
	}

	if (format === 'adf') return body ?? '';

	if (format === 'rendered' && typeof rendered === 'string') return rendered;

	return plainText(body).trim();
}

function author(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object') return null;
	const source = value as Record<string, unknown>;

	return Object.fromEntries(
		['accountId', 'displayName']
			.flatMap((key) => (source[key] !== undefined ? [[key, source[key]]] : [])),
	);
}

/** Simplify only the output; state and event classification retain raw Jira data. */
export function formatEvent(
	event: PollEvent,
	simplify: boolean,
	format: OutputFormat = 'rendered',
): Record<string, unknown> {
	if (!simplify) {
		// SAFETY: PollEvent declares only string-named properties; raw output returns that same object.
		return event as PollEvent & Record<string, unknown>;
	}

	const { fields } = event.issue;

	const projectKey =
		fields.project &&
		typeof fields.project === 'object' &&
		typeof (fields.project as Record<string, unknown>).key === 'string'
			? (fields.project as Record<string, unknown>).key
			: '';

	const status =
		fields.status && typeof fields.status === 'object'
			? ((fields.status as Record<string, unknown>).name ?? '')
			: fields.status;

	const issue: Record<string, unknown> = {
		id: event.issue.id,
		key: event.issue.key,
		projectKey,
		summary: fields.summary ?? '',
		description: content(fields.description, event.issue.renderedFields?.description, format),
		status: status ?? '',
	};

	const additionalFields = Object.fromEntries(
		Object.entries(fields).filter(
			([key]) =>
				!['summary', 'description', 'project', 'status', 'created', 'updated'].includes(key),
		),
	);

	Object.assign(issue, additionalFields, {
		id: event.issue.id,
		key: event.issue.key,
		projectKey,
		summary: fields.summary ?? '',
		description: content(fields.description, event.issue.renderedFields?.description, format),
		status: status ?? '',
	});

	if (!event.comment) return { ...issue, created: fields.created, updated: fields.updated };

	return {
		issueId: event.issue.id,
		issueKey: event.issue.key,
		summary: issue.summary,
		status: issue.status,
		...Object.fromEntries(
			Object.entries(additionalFields).filter(
				([key]) =>
					![
						'issueId',
						'issueKey',
						'id',
						'body',
						'author',
						'updateAuthor',
						'created',
						'updated',
						'summary',
						'description',
						'status',
					].includes(key),
			),
		),
		id: event.comment.id,
		body: content(event.comment.body, event.comment.renderedBody, format),
		created: event.comment.created,
		updated: event.comment.updated,
		author: author(event.comment.author),
		updateAuthor: author(event.comment.updateAuthor),
	};
}
