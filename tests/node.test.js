const test = require('node:test');
const assert = require('node:assert/strict');
const { JiraPollTrigger } = require('../dist/nodes/JiraPollTrigger/JiraPollTrigger.node');
const node = new JiraPollTrigger();
const epoch = Date.UTC(2026, 0, 1);
const iso = (n) => new Date(epoch + n).toISOString();
const issue = (id = '1') => ({
	id,
	key: `TEST-${id}`,
	fields: { created: iso(1), updated: iso(1) },
});
let fixtureSequence = 0;
function fixture({
	manual = false,
	params = {},
	credentials = {},
	read = async () => ({ issues: [], isLast: true }),
} = {}) {
	const state = {},
		requests = [];
	const identity = ++fixtureSequence;
	params = {
		simplify: false,
		resource: 'issue',
		event: 'createdOrUpdated',
		jql: '',
		additionalFields: '',
		options: {},
		visibility: 'all',
		excludedAccountIds: '',
		...params,
	};
	credentials = {
		domain: 'https://example.atlassian.net',
		email: 'fixture@example.invalid',
		apiToken: 'synthetic-fixture-token',
		...credentials,
	};
	const ctx = {
		getMode: () => (manual ? 'manual' : 'trigger'),
		getWorkflow: () => ({ id: `fixture-workflow-${identity}` }),
		getNode: () => ({
			id: 'fixture-node',
			name: 'Jira Poll Trigger',
			type: 'jiraPollTrigger',
			typeVersion: 1,
			position: [0, 0],
			parameters: params,
			credentials: { jiraSoftwareCloudApi: { id: 'fixture-credential' } },
		}),
		getCredentials: async (name) => {
			assert.equal(name, 'jiraSoftwareCloudApi');
			return credentials;
		},
		getNodeParameter: (name, fallback) => params[name] ?? fallback,
		getWorkflowStaticData: (scope) => {
			assert.equal(scope, 'node');
			assert.equal(manual, false, 'manual must never access saved state');
			return state;
		},
		helpers: {
			returnJsonArray: (items) => items.map((json) => ({ json })),
			async httpRequestWithAuthentication(name, request) {
				assert.equal(this, ctx);
				assert.equal(name, 'jiraSoftwareCloudApi');
				requests.push(request);
				return read(request, requests.length);
			},
		},
	};
	return { ctx, state, requests, params, credentials };
}
async function at(time, ctx) {
	const original = Date.now;
	Date.now = () => epoch + time;
	try {
		return await node.poll.call(ctx);
	} finally {
		Date.now = original;
	}
}

test('reuses built-in credentials without defining credentials', () => {
	assert.deepEqual(node.description.credentials, [
		{ name: 'jiraSoftwareCloudApi', required: true },
	]);
	assert.deepEqual(require('../package.json').n8n.credentials, []);
	assert.equal(node.description.polling, true);
});
test('activation reads no history; subsequent event emits once and empty poll checkpoints', async () => {
	const f = fixture({ read: async () => ({ issues: [issue()], isLast: true }) });
	assert.equal(await at(0, f.ctx), null);
	assert.equal(f.requests.length, 0);
	assert.equal(f.state.jiraPollState.activation, epoch);
	assert.equal((await at(10, f.ctx))[0][0].json.eventType, 'issue.created');
	assert.equal(await at(20, f.ctx), null);
	assert.equal(f.state.jiraPollState.checkpoint, epoch + 20);
	assert.equal(f.requests[0].url, 'https://example.atlassian.net/rest/api/3/search/jql');
	assert.equal(f.requests[0].disableFollowRedirect, true);
});
test('maps filters, overlap, quoted JQL and fields; preserves raw comment', async () => {
	const comments = [
		{
			id: 'a',
			created: iso(1),
			updated: iso(2),
			author: { accountId: 'excluded' },
			updateAuthor: { accountId: 'allowed' },
			jsdPublic: true,
			body: { type: 'doc', content: [] },
			renderedBody: '<p>Fixture</p>',
		},
		{ id: 'b', created: iso(1), updated: iso(2), jsdPublic: false },
		{ id: 'c', created: iso(1), updated: iso(2) },
	];
	const f = fixture({
		params: {
			resource: 'comment',
			visibility: 'public',
			excludedAccountIds: ' excluded, excluded ',
			jql: 'project = TEST OR summary ~ "ORDER BY"',
			additionalFields: 'priority, summary, assignee',
			options: { overlapMinutes: 7 },
		},
		read: async (request) =>
			request.method === 'POST'
				? { issues: [issue()], isLast: true }
				: { comments, startAt: 0, total: 3, maxResults: 100 },
	});
	await at(0, f.ctx);
	const result = await at(10, f.ctx);
	assert.deepEqual(
		result[0].map((item) => item.json.eventType),
		['comment.updated'],
	);
	assert.deepEqual(result[0][0].json.comment, comments[0]);
	assert.equal(
		f.requests[0].body.jql,
		`(project = TEST OR summary ~ "ORDER BY") AND updated >= ${epoch} ORDER BY id ASC`,
	);
	assert.deepEqual(
		new Set(f.requests[0].body.fields),
		new Set([
			'created',
			'updated',
			'summary',
			'project',
			'status',
			'priority',
			'assignee',
		]),
	);
	const config = JSON.parse(f.state.jiraPollState.fingerprint);
	assert.equal('overlapMs' in config, false);
	assert.deepEqual(config.excludedAccountIds, ['excluded']);
});
test('manual returns one event without reading saved state', async () => {
	const f = fixture({
		manual: true,
		params: { options: { testLimit: 1 } },
		read: async () => ({ issues: [issue(), issue('2')], isLast: true }),
	});
	assert.equal((await at(10, f.ctx))[0].length, 1);
	assert.deepEqual(f.state, {});
	assert.equal(
		f.requests[0].body.jql,
		`updated >= ${epoch + 10 - 30 * 86400000} ORDER BY id DESC`,
	);
});
test('manual no-match search stops after two pages', async () => {
	const f = fixture({
		manual: true,
		params: { event: 'updated' },
		read: async (_, count) => ({
			issues: [issue(String(count))],
			isLast: false,
			nextPageToken: `page-${count}`,
		}),
	});
	assert.equal(await at(10, f.ctx), null);
	assert.equal(f.requests.length, 2);
});
test('manual comments stop after two pages per issue', async () => {
	const f = fixture({
		manual: true,
		params: { resource: 'comment', visibility: 'public' },
		read: async (request) =>
			request.method === 'POST'
				? { issues: [issue()], isLast: true }
				: {
						comments: [
							{
								id: String(request.qs.startAt),
								created: iso(1),
								updated: iso(1),
								jsdPublic: false,
							},
						],
						startAt: request.qs.startAt,
						maxResults: 1,
						total: 1000,
					},
	});
	assert.equal(await at(10, f.ctx), null);
	assert.equal(f.requests.length, 3);
});
for (const domain of [
	'http://example.atlassian.net',
	'https://jira.example.invalid',
	'https://example.atlassian.net/path',
	'https://example.atlassian.net.evil.invalid',
])
	test(`rejects invalid Cloud URL ${domain}`, async () => {
		const f = fixture({ credentials: { domain } });
		await assert.rejects(at(0, f.ctx), /HTTPS Jira Cloud/);
		assert.equal(f.requests.length, 0);
		assert.deepEqual(f.state, {});
	});
test('failed later page preserves prior state', async () => {
	const f = fixture({
		read: async (_, count) => {
			if (count === 1) return { issues: [issue()], isLast: false, nextPageToken: 'second' };
			throw { statusCode: 403 };
		},
	});
	await at(0, f.ctx);
	const before = f.state.jiraPollState,
		snapshot = structuredClone(before);
	await assert.rejects(at(10, f.ctx), /HTTP 403/);
	assert.equal(f.state.jiraPollState, before);
	assert.deepEqual(before, snapshot);
});
test('credential edit resets from now without saving token plaintext', async () => {
	const f = fixture();
	await at(0, f.ctx);
	f.credentials.apiToken = 'changed-synthetic-token';
	assert.equal(await at(10, f.ctx), null);
	assert.equal(f.state.jiraPollState.activation, epoch + 10);
	assert.equal(f.requests.length, 0);
	assert.equal(JSON.stringify(f.state).includes(f.credentials.apiToken), false);
});

test('overlapping polls with separately captured state reject the stale second snapshot', async () => {
	let releaseRead, signalRead;
	const blocked = new Promise((resolve) => {
		releaseRead = resolve;
	});
	const reading = new Promise((resolve) => {
		signalRead = resolve;
	});
	const first = fixture({
		read: async () => {
			signalRead();
			await blocked;
			return { issues: [issue()], isLast: true };
		},
	});
	await at(0, first.ctx);
	const second = fixture();
	second.ctx.getWorkflow = first.ctx.getWorkflow;
	second.ctx.getNode = first.ctx.getNode;
	second.state.jiraPollState = structuredClone(first.state.jiraPollState);
	const staleSnapshot = structuredClone(second.state);
	const original = Date.now;
	Date.now = () => epoch + 10;
	try {
		const firstPoll = node.poll.call(first.ctx);
		await reading;
		const secondPoll = node.poll.call(second.ctx);
		const rejected = assert.rejects(secondPoll, /stale or uncommitted/);
		releaseRead();
		assert.equal((await firstPoll)[0][0].json.eventType, 'issue.created');
		await rejected;
		assert.equal(second.requests.length, 0);
		assert.deepEqual(second.state, staleSnapshot);
		assert.equal(first.state.jiraPollState.checkpoint, epoch + 10);
	} finally {
		releaseRead();
		Date.now = original;
	}
});

test('domain override routes search and comment pages using the selected credential', async () => {
	const f = fixture({
		params: { resource: 'comment', options: { domain: ' https://second.atlassian.net/ ' } },
		read: async (request) => {
			if (request.method === 'POST')
				return request.body.nextPageToken
					? { issues: [], isLast: true }
					: { issues: [issue()], isLast: false, nextPageToken: 'second' };
			return {
				comments: [{ id: String(request.qs.startAt), created: iso(1), updated: iso(1) }],
				startAt: request.qs.startAt,
				maxResults: 1,
				total: 2,
			};
		},
	});
	const credentialBefore = structuredClone(f.credentials);
	await at(0, f.ctx);
	const result = await at(10, f.ctx);
	assert.equal(result[0].length, 2);
	assert.equal(f.requests.length, 4);
	assert.ok(
		f.requests.every(
			(request) =>
				request.url.startsWith('https://second.atlassian.net/rest/api/3/') &&
				request.disableFollowRedirect === true,
		),
	);
	assert.equal(
		JSON.parse(f.state.jiraPollState.fingerprint).baseUrl,
		'https://second.atlassian.net',
	);
	assert.deepEqual(f.credentials, credentialBefore);
});
for (const domain of ['', '  \t '])
	test(`blank domain override falls back to credential: ${JSON.stringify(domain)}`, async () => {
		const f = fixture({ params: { options: { domain } } });
		await at(0, f.ctx);
		await at(10, f.ctx);
		assert.equal(f.requests[0].url, 'https://example.atlassian.net/rest/api/3/search/jql');
	});
for (const domain of [
	'not a URL',
	'http://second.atlassian.net',
	'https://example.invalid',
	'https://second.atlassian.net/path',
	'https://second.atlassian.net.evil.invalid',
	'https://user:password@second.atlassian.net',
	'https://second.atlassian.net:8443',
	'https://second.atlassian.net?next=1',
	'https://second.atlassian.net#fragment',
])
	test(`rejects invalid domain override ${domain}`, async () => {
		const f = fixture({ params: { options: { domain } } });
		await assert.rejects(at(0, f.ctx), /Jira Cloud/);
		assert.equal(f.requests.length, 0);
		assert.deepEqual(f.state, {});
	});
test('changing the resolved domain resets polling from now without requesting history', async () => {
	const f = fixture();
	await at(0, f.ctx);
	await at(10, f.ctx);
	f.params.options.domain = 'https://second.atlassian.net';
	assert.equal(await at(20, f.ctx), null);
	assert.equal(f.state.jiraPollState.activation, epoch + 20);
	assert.equal(f.requests.length, 1);
	await at(30, f.ctx);
	assert.equal(f.requests[1].url, 'https://second.atlassian.net/rest/api/3/search/jql');
	f.params.options.domain = '';
	assert.equal(await at(40, f.ctx), null);
	assert.equal(f.state.jiraPollState.activation, epoch + 40);
	assert.equal(f.requests.length, 2);
});
test('an equivalent domain override preserves the polling boundary', async () => {
	const f = fixture();
	await at(0, f.ctx);
	f.params.options.domain = ' https://EXAMPLE.atlassian.net/ ';
	await at(10, f.ctx);
	assert.equal(f.state.jiraPollState.activation, epoch);
	assert.equal(f.requests.length, 1);
});

test('simple output defaults to rendered comment HTML in the node', async () => {
	const comment = {
		id: 'comment-1',
		created: iso(1),
		updated: iso(1),
		body: { type: 'doc', content: [] },
		renderedBody: '<p>Rendered comment</p>',
	};
	const f = fixture({
		manual: true,
		params: { resource: 'comment' },
		read: async (request) =>
			request.method === 'POST'
				? { issues: [issue()], isLast: true }
				: { comments: [comment], startAt: 0, total: 1, maxResults: 100 },
	});
	delete f.params.simplify;
	const output = (await at(10, f.ctx))[0][0].json;
	assert.equal(
		node.description.properties
			.find((property) => property.name === 'options')
			.options.find((p) => p.name === 'simplify').default,
		true,
	);
	assert.equal(output.body, '<p>Rendered comment</p>');
	assert.equal(output.issueKey, 'TEST-1');
	assert.equal(output.id, 'comment-1');
	assert.equal('eventType' in output, false);
	assert.equal('eventId' in output, false);
});

test('manual testing defaults to ten events and stops before the next search page', async () => {
	const f = fixture({
		manual: true,
		read: async () => ({
			issues: Array.from({ length: 20 }, (_, index) => issue(String(index))),
			isLast: false,
			nextPageToken: 'unused',
		}),
	});
	assert.equal((await at(10, f.ctx))[0].length, 10);
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.state, {});
});
test('manual test limit counts creation and update as separate events', async () => {
	const f = fixture({
		manual: true,
		params: { options: { testLimit: 3 } },
		read: async () => ({
			issues: ['1', '2', '3'].map((id) => ({
				...issue(id),
				fields: { created: iso(1), updated: iso(2) },
			})),
			isLast: true,
		}),
	});
	const events = (await at(10, f.ctx))[0];
	assert.deepEqual(
		events.map((item) => item.json.eventType),
		['issue.created', 'issue.updated', 'issue.created'],
	);
});
for (const testLimit of [0, -1, 101, 1.5, 'bad'])
	test(`manual rejects invalid test limit ${testLimit} before requests`, async () => {
		const f = fixture({ manual: true, params: { options: { testLimit } } });
		await assert.rejects(at(10, f.ctx), /test limit/);
		assert.equal(f.requests.length, 0);
		assert.deepEqual(f.state, {});
	});
test('test limit does not cap scheduled polling or reset its boundary', async () => {
	const f = fixture({
		params: { options: { testLimit: 1 } },
		read: async () => ({ issues: [issue(), issue('2')], isLast: true }),
	});
	await at(0, f.ctx);
	f.params.options.testLimit = 2;
	assert.equal((await at(10, f.ctx))[0].length, 2);
	assert.equal(f.state.jiraPollState.activation, epoch);
});

test('domain is an optional override under Options', () => {
	assert.equal(
		node.description.properties.find((p) => p.name === 'domain').type,
		'hidden',
	);
	const option = node.description.properties
		.find((p) => p.name === 'options')
		.options.find((p) => p.name === 'domain');
	assert.equal(option.displayName, 'Jira Domain');
	assert.equal(option.default, '');
});
test('all optional settings are alphabetized in Options with Simplify on by default', () => {
	assert.deepEqual(
		node.description.properties
			.filter((p) => p.type !== 'notice' && p.type !== 'hidden')
			.map((p) => p.name),
		['resource', 'event', 'jql', 'options'],
	);
	const fields = node.description.properties.find((p) => p.name === 'options').options;
	assert.deepEqual(
		fields.map((p) => p.displayName),
		fields.map((p) => p.displayName).sort((a, b) => a.localeCompare(b)),
	);
	assert.equal(fields.find((p) => p.name === 'simplify').default, true);
});
test('Options Simplify overrides legacy top-level value and applies body format', async () => {
	const f = fixture({
		manual: true,
		params: { simplify: false, options: { simplify: true, outputFormat: 'text' } },
		read: async () => ({
			issues: [
				{
					...issue(),
					fields: {
						...issue().fields,
						description: {
							type: 'doc',
							content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Description' }] }],
						},
					},
				},
			],
			isLast: true,
		}),
	});
	const out = (await at(10, f.ctx))[0][0].json;
	assert.equal(out.description, 'Description');
	assert.equal(out.issue, undefined);
	assert.equal(out.id, '1');
});
test('legacy expressions are evaluated only when Options does not override them', async () => {
	const f = fixture({
		manual: true,
		params: { simplify: '={{ false }}', additionalFields: '={{ "priority" }}' },
		read: async () => ({ issues: [issue()], isLast: true }),
	});
	let evaluated = [];
	const originalGet = f.ctx.getNodeParameter;
	f.ctx.getNodeParameter = (name, fallback) => {
		const value = originalGet(name, fallback);
		if (typeof value !== 'string' || !value.startsWith('=')) return value;
		evaluated.push(value);
		return value.includes('false') ? false : 'priority';
	};
	const out = (await at(10, f.ctx))[0][0].json;
	assert.equal(out.eventType, 'issue.created');
	assert(f.requests[0].body.fields.includes('priority'));
	assert.equal(evaluated.length, 2);
	f.params.options = { simplify: true, additionalFields: '' };
	evaluated = [];
	await at(10, f.ctx);
	assert.equal(evaluated.length, 0);
});
test('wiki markup uses native v2 reads for description and comment body', async () => {
	const f = fixture({
		manual: true,
		params: { resource: 'comment', options: { simplify: true, outputFormat: 'wiki' } },
		read: async (r) =>
			r.method === 'POST'
				? {
						issues: [{ ...issue(), fields: { ...issue().fields, description: 'h1. Description' } }],
						isLast: true,
					}
				: {
						comments: [{ id: 'c', created: iso(1), updated: iso(1), body: '*Comment*' }],
						startAt: 0,
						total: 1,
						maxResults: 100,
					},
	});
	const out = (await at(10, f.ctx))[0][0].json;
	assert.equal(out.body, '*Comment*');
	assert.equal(out.description, undefined);
	assert(f.requests.every((r) => r.url.includes('/rest/api/2/')));
});
test('raw mode keeps v3 even when a hidden wiki output format is stored', async () => {
	const f = fixture({
		manual: true,
		params: { options: { simplify: false, outputFormat: 'wiki' } },
		read: async () => ({ issues: [issue()], isLast: true }),
	});
	await at(10, f.ctx);
	assert(f.requests.every((r) => r.url.includes('/rest/api/3/')));
});

test('legacy top-level settings stay declared as hidden parameters', () => {
	for (const [name, expected] of [
		['simplify', true],
		['domain', ''],
		['visibility', 'all'],
		['excludedAccountIds', ''],
		['additionalFields', ''],
	]) {
		const property = node.description.properties.find((p) => p.name === name);
		assert.equal(property.type, 'hidden');
		assert.equal(property.default, expected);
	}
});
test('changing overlap does not reset the polling cursor', async () => {
	const f = fixture({ params: { options: { overlapMinutes: 5 } } });
	assert.equal(await at(0, f.ctx), null);
	const fingerprint = f.state.jiraPollState.fingerprint;
	f.params.options.overlapMinutes = 30;
	assert.equal(await at(10, f.ctx), null);
	assert.equal(f.state.jiraPollState.activation, epoch);
	assert.equal(f.state.jiraPollState.checkpoint, epoch + 10);
	assert.equal(f.state.jiraPollState.fingerprint, fingerprint);
	assert.equal(f.requests[0].body.jql, `updated >= ${epoch} ORDER BY id ASC`);
});
test('a formatting failure leaves the saved state uncommitted', async () => {
	const f = fixture({
		params: { options: { simplify: true, outputFormat: 'wiki' } },
		read: async () => ({
			issues: [{ ...issue(), fields: { ...issue().fields, description: { type: 'doc' } } }],
			isLast: true,
		}),
	});
	assert.equal(await at(0, f.ctx), null);
	const committed = { ...f.state.jiraPollState };
	await assert.rejects(at(10, f.ctx), /wiki markup/);
	assert.deepEqual({ ...f.state.jiraPollState }, committed);
});
