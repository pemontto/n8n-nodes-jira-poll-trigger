const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatEvent } = require('../dist/nodes/JiraPollTrigger/output');
const event = {
	eventType: 'comment.created',
	eventId: 'example.atlassian.net/comment/1/2/created/1100',
	eventTime: '2026-01-01T00:00:00.000Z',
	issue: {
		id: '1',
		key: 'TEST-1',
		fields: {
			summary: 'Example',
			status: { name: 'Open' },
			created: 'issue-created',
			updated: 'issue-updated',
			customfield_10000: 'extra',
		},
	},
	comment: {
		id: '2',
		created: 'comment-created',
		updated: 'comment-updated',
		body: {
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain body' }] }],
		},
		renderedBody: '<p>Rendered <strong>body</strong></p>',
		author: { accountId: 'author' },
		updateAuthor: { accountId: 'editor' },
	},
};
test('simple comment output defaults to rendered HTML and keeps only essential nested issue and comment fields', () => {
	const out = formatEvent(event, true);
	assert.equal(out.body, event.comment.renderedBody);
	assert.equal(out.id, '2');
	assert.equal(out.issueKey, 'TEST-1');
	assert.equal(out.status, 'Open');
	assert.equal(out.created, 'comment-created');
	assert.equal(out.customfield_10000, 'extra');
	assert.deepEqual(
		Object.keys(out).sort(),
		[
			'issueId',
			'issueKey',
			'summary',
			'status',
			'customfield_10000',
			'id',
			'body',
			'created',
			'updated',
			'author',
			'updateAuthor',
		].sort(),
	);
	assert.equal(out.comment, undefined);
	assert.deepEqual(out.author, event.comment.author);
});
test('missing rendered body falls back to readable ADF text', () => {
	const copy = structuredClone(event);
	delete copy.comment.renderedBody;
	assert.equal(formatEvent(copy, true).body, 'Plain body');
	copy.comment.body = {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [
					{ type: 'mention', attrs: { text: '@Reader' } },
					{ type: 'hardBreak' },
					{ type: 'text', text: 'Hello' },
				],
			},
		],
	};
	assert.equal(formatEvent(copy, true).body, '@Reader\nHello');
});
test('raw output retains complete response and structured body without mutation', () => {
	const before = structuredClone(event);
	assert.equal(formatEvent(event, false), event);
	formatEvent(event, true);
	assert.deepEqual(event, before);
});
test('simple issue output has no comment fields', () => {
	const copy = { ...event, eventType: 'issue.updated' };
	delete copy.comment;
	const out = formatEvent(copy, true);
	assert.equal(out.created, 'issue-created');
	assert.equal(out.comment, undefined);
	assert.equal(out.issue, undefined);
	assert.equal(out.key, 'TEST-1');
});
test('simple authors omit avatars and metadata', () => {
	const copy = structuredClone(event);
	copy.comment.author = { accountId: 'a', displayName: 'Writer', avatarUrls: {}, self: 'private' };
	copy.comment.updateAuthor = { accountId: 'b', displayName: 'Editor', active: true };
	const out = formatEvent(copy, true);
	assert.deepEqual(out.author, { accountId: 'a', displayName: 'Writer' });
	assert.deepEqual(out.updateAuthor, { accountId: 'b', displayName: 'Editor' });
});
for (const format of ['rendered', 'text', 'adf'])
	test(`body and issue description support ${format}`, () => {
		const copy = structuredClone(event);
		copy.issue.fields.description = {
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Description' }] }],
		};
		copy.issue.renderedFields = { description: '<p>Description</p>' };
		const out = formatEvent(copy, true, format);
		assert.deepEqual(
			formatEvent({ ...copy, comment: undefined }, true, format).description,
			format === 'rendered'
				? '<p>Description</p>'
				: format === 'text'
					? 'Description'
					: copy.issue.fields.description,
		);
		assert.deepEqual(
			out.body,
			format === 'rendered'
				? copy.comment.renderedBody
				: format === 'text'
					? 'Plain body'
					: copy.comment.body,
		);
		const issueOnly = { ...copy };
		delete issueOnly.comment;
		const issueOut = formatEvent(issueOnly, true, format);
		assert.deepEqual(
			issueOut.description,
			format === 'rendered'
				? '<p>Description</p>'
				: format === 'text'
					? 'Description'
					: copy.issue.fields.description,
		);
		assert.equal(out.description, undefined);
		assert.equal(issueOut.issue, undefined);
	});
test('missing descriptions are present with an empty value', () => {
	assert.equal(formatEvent({ ...event, comment: undefined }, true).description, '');
	assert.equal(formatEvent(event, true).description, undefined);
});
test('wiki markup preserves native Jira strings without using rendered HTML', () => {
	const copy = structuredClone(event);
	copy.comment.body = '*bold* and [link|https://example.test]';
	copy.issue.fields.description = 'h2. Heading\n{code}sample{code}';
	const out = formatEvent(copy, true, 'wiki');
	assert.equal(out.body, copy.comment.body);
	assert.equal(out.description, undefined);
	assert.equal(
		formatEvent({ ...copy, comment: undefined }, true, 'wiki').description,
		copy.issue.fields.description,
	);
	assert.throws(() => formatEvent(event, true, 'wiki'), /did not return wiki markup text/);
});
test('issue projectKey uses Jira project data and cannot be overwritten by an extra field', () => {
	const copy = structuredClone(event);
	delete copy.comment;
	copy.issue.fields.project = { id: 'p1', key: 'PROJECT', name: 'Project' };
	copy.issue.fields.projectKey = 'wrong';
	copy.issue.key = 'DIFFERENT-1';
	const out = formatEvent(copy, true);
	assert.equal(out.projectKey, 'PROJECT');
	assert.equal(out.project, undefined);
	assert.equal(out.issue, undefined);
	delete copy.issue.fields.project;
	assert.equal(formatEvent(copy, true).projectKey, '');
});
