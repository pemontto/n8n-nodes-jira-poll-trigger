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
	credentialType = 'jiraSoftwareCloudApi',
	read = async () => ({ issues: [], isLast: true }),
} = {}) {
	const state = {},
		requests = [],
		options = [];
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
			credentials: { [credentialType]: { id: `fixture-credential-${identity}` } },
		}),
		getCredentials: async (name) => {
			assert.equal(name, credentialType);
			return credentials;
		},
		logger: { warn: () => {} },
		getNodeParameter: (name, fallback) => params[name] ?? fallback,
		getWorkflowStaticData: (scope) => {
			assert.equal(scope, 'node');
			assert.equal(manual, false, 'manual must never access saved state');
			return state;
		},
		helpers: {
			returnJsonArray: (items) => items.map((json) => ({ json })),
			async httpRequestWithAuthentication(name, request, additional) {
				assert.equal(this, ctx);
				assert.equal(name, credentialType);
				requests.push(request);
				options.push(additional);
				return read(request, requests.length);
			},
		},
	};
	return { ctx, state, requests, options, params, credentials };
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
		{
			name: 'jiraSoftwareCloudApi',
			required: true,
			displayOptions: { show: { authentication: ['apiToken'] } },
		},
		{
			name: 'jiraSoftwareCloudOAuth2Api',
			required: true,
			displayOptions: { show: { authentication: ['oAuth2'] } },
		},
	]);
	const authentication = node.description.properties.find((p) => p.name === 'authentication');
	assert.equal(authentication.default, 'apiToken');
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
		`(project = TEST OR summary ~ "ORDER BY") AND updated >= ${epoch} AND created <= ${epoch + 10} ORDER BY id ASC`,
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
			'comment',
		]),
	);
	const config = JSON.parse(f.state.jiraPollState.fingerprint);
	assert.equal('overlapMs' in config, false);
	assert.deepEqual(config.excludedAccountIds, ['excluded']);
	assert.equal(config.fields.includes('comment'), false, 'the embedded field is not fingerprinted');
});
test('manual returns one event without reading saved state', async () => {
	const f = fixture({
		manual: true,
		params: { options: { testLimit: 1 } },
		read: async () => ({ issues: [issue(), issue('2')], isLast: true }),
	});
	assert.equal((await at(10, f.ctx))[0].length, 1);
	assert.deepEqual(f.state, {});
	assert.equal(f.requests[0].body.jql, `updated >= ${epoch + 10 - 30 * 86400000} ORDER BY id DESC`);
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
	assert.equal(node.description.properties.find((p) => p.name === 'domain').type, 'hidden');
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
		['authentication', 'resource', 'event', 'jql', 'options'],
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
	assert.equal(
		f.requests[0].body.jql,
		`updated >= ${epoch} AND created <= ${epoch + 10} ORDER BY id ASC`,
	);
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

// Poll budget. A fake clock advances per request so page fetches have a cost.
const minute = 60_000;
/** Runs a poll with Date.now reading `epoch + clock.now`. */
async function onClock(clock, ctx) {
	const original = Date.now;
	Date.now = () => epoch + clock.now;
	try {
		return await node.poll.call(ctx);
	} finally {
		Date.now = original;
	}
}
/**
 * An honest Jira: filters by the JQL bound and `id >`, sorts by ID, paginates
 * by token, serves comments by startAt, and fails a request that outlives its
 * timeout. Times are offsets from `epoch`.
 */
function jiraServer({
	issues,
	comments = {},
	pageSize = 2,
	clock,
	costMs = 0,
	embedLimit = Infinity,
}) {
	const embed = (id) => {
		const all = comments[id] ?? [];
		return {
			comments: all.slice(0, embedLimit).map((item) => ({
				id: item.id,
				created: iso(item.created ?? item.updated),
				updated: iso(item.updated),
				body: { type: 'doc' },
			})),
			total: all.length,
			maxResults: Math.max(1, Math.min(all.length, embedLimit)),
		};
	};
	return async (request) => {
		const cost = typeof costMs === 'function' ? costMs(request) : costMs;
		clock.now += cost;
		if (cost > request.timeout)
			throw Object.assign(new Error(`timeout of ${request.timeout}ms exceeded`), {
				code: 'ECONNABORTED',
			});
		if (request.method === 'POST') {
			const { jql } = request.body;
			const bound = Number(/updated >= (\d+)/.exec(jql)[1]) - epoch;
			const createdBefore = Number(/created <= (\d+)/.exec(jql)?.[1] ?? Infinity) - epoch;
			const afterId = Number(/id > (\d+)/.exec(jql)?.[1] ?? 0);
			const sorted = issues
				.filter(
					(item) =>
						item.updated >= bound &&
						(item.created ?? item.updated) <= createdBefore &&
						Number(item.id) > afterId,
				)
				.sort((a, b) => Number(a.id) - Number(b.id));
			if (/DESC/.test(jql)) sorted.reverse();
			const start = Number(request.body.nextPageToken ?? 0);
			const page = sorted.slice(start, start + pageSize);
			const isLast = start + pageSize >= sorted.length;
			return {
				issues: page.map((item) => ({
					id: item.id,
					key: `TEST-${item.id}`,
					fields: {
						created: iso(item.created ?? item.updated),
						updated: iso(item.updated),
						...(request.body.fields.includes('comment') ? { comment: embed(item.id) } : {}),
					},
					...(request.body.fields.includes('comment')
						? {
								renderedFields: {
									comment: {
										comments: embed(item.id).comments.map((c) => ({ ...c, body: `<p>${c.id}</p>` })),
									},
								},
							}
						: {}),
				})),
				isLast,
				...(isLast ? {} : { nextPageToken: String(start + pageSize) }),
			};
		}
		const id = decodeURIComponent(request.url.split('/issue/')[1].split('/')[0]);
		const all = comments[id] ?? [];
		const { startAt } = request.qs;
		return {
			comments: all.slice(startAt, startAt + pageSize).map((item) => ({
				id: item.id,
				created: iso(item.created ?? item.updated),
				updated: iso(item.updated),
			})),
			startAt,
			maxResults: pageSize,
			total: all.length,
		};
	};
}
const emitted = (result) =>
	result ? result[0].map((item) => [item.json.eventType, item.json.issue.id]) : [];
const emittedIds = (result) => (result ? result[0].map((item) => item.json.issue.id) : []);
const commentIds = (result) => (result ? result[0].map((item) => item.json.comment.id) : []);
/** Activates at clock 0 with a server, then returns the fixture. */
async function activated(serverOptions, fixtureOptions = {}) {
	const clock = { now: 0 };
	const f = fixture({ ...fixtureOptions, read: jiraServer({ ...serverOptions, clock }) });
	await onClock(clock, f.ctx);
	return { ...f, clock };
}
/** Polls once a minute with one budget until `expect` deliveries arrive. */
async function drain(f, budget, expect, { from = 60 * minute, pick = emittedIds } = {}) {
	f.ctx.getPollBudgetMs = () => budget;
	const delivered = [];
	let polls = 0;
	for (f.clock.now = from; delivered.length < expect && polls < 40; f.clock.now += minute) {
		polls++;
		delivered.push(...pick(await onClock(f.clock, f.ctx)));
	}
	return { delivered, polls };
}

test('without a host budget, slow pagination completes and checkpoints as before', async () => {
	const issues = [1, 2, 3, 4].map((n) => ({ id: String(n), updated: n }));
	const f = await activated({ issues, costMs: 20_000 });
	assert.equal(f.ctx.getPollBudgetMs, undefined);
	f.clock.now = 10;
	assert.deepEqual(emittedIds(await onClock(f.clock, f.ctx)), ['1', '2', '3', '4']);
	assert.equal(f.state.jiraPollState.checkpoint, epoch + 10);
	assert.equal(f.state.jiraPollState.window, undefined);
	assert.equal(f.requests.length, 2);
	assert.ok(f.requests.every((request) => request.timeout === 30_000));
});
test('an ample budget emits and saves exactly what no budget does', async () => {
	const run = async (budget) => {
		const issues = [1, 2, 3, 4].map((n) => ({ id: String(n), updated: n }));
		const f = await activated({ issues, costMs: 1_000 });
		if (budget) f.ctx.getPollBudgetMs = () => budget;
		f.clock.now = 10;
		const ids = emittedIds(await onClock(f.clock, f.ctx));
		const { fingerprint, ...state } = f.state.jiraPollState;
		return { ids, state };
	};
	const budgeted = await run(300_000);
	assert.deepEqual(budgeted.ids, ['1', '2', '3', '4']);
	assert.deepEqual(budgeted, await run(undefined));
});
test('a budget stop mid-pagination emits the prefix, saves the continuation, and the next poll finishes the window without loss or duplicates', async () => {
	const issues = [1, 2, 3, 4].map((n) => ({ id: String(n), updated: n }));
	const f = await activated({ issues, costMs: 6_000 });
	f.ctx.getPollBudgetMs = () => 10_000;
	f.clock.now = 10;
	assert.deepEqual(emittedIds(await onClock(f.clock, f.ctx)), ['1', '2']);
	assert.equal(f.requests.length, 2, 'the second page times out at its 4 second cap');
	assert.deepEqual(f.state.jiraPollState.window, {
		since: epoch,
		until: epoch + 10,
		afterId: '2',
		partial: undefined,
	});
	assert.equal(f.state.jiraPollState.checkpoint, epoch, 'checkpoint waits for the window');
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now = 100_000;
	assert.deepEqual(emittedIds(await onClock(f.clock, f.ctx)), ['3', '4']);
	assert.equal(
		f.requests[2].body.jql,
		`updated >= ${epoch} AND created <= ${epoch + 10} AND id > 2 ORDER BY id ASC`,
	);
	assert.equal(f.state.jiraPollState.window, undefined);
	assert.equal(
		f.state.jiraPollState.checkpoint,
		epoch + 100_000,
		'the window closes at its own bound and the poll goes on to the present',
	);
	f.clock.now = 200_000;
	assert.equal(await onClock(f.clock, f.ctx), null);
	assert.equal(f.state.jiraPollState.checkpoint, epoch + 200_000);
});
test('the same finite budget on every poll drains a large backlog oldest first and retires its keys', async () => {
	// Sixty issues over an hour; every poll affords two pages of two.
	const issues = Array.from({ length: 60 }, (_, n) => ({ id: String(n + 1), updated: n * minute }));
	const f = await activated({ issues, costMs: 4_000 });
	const { delivered, polls } = await drain(f, 10_000, 60, { from: 90 * minute });
	assert.deepEqual(
		delivered,
		issues.map((item) => item.id),
	);
	// Fifteen-minute windows re-read a five-minute overlap each, so the drain
	// costs about a quarter more pages than one long scan would.
	assert.ok(polls <= 25, `drained in ${polls} polls`);
	assert.ok(
		f.state.jiraPollState.seen.length <= 10,
		`keys older than the overlap are retired: ${f.state.jiraPollState.seen.length}`,
	);
});
test('the same finite budget drains a bulk edit inside the overlap in comment mode', async () => {
	// Twenty issues all edited within one minute, one comment each: a poll
	// affords the search page plus one comment read, so twenty polls of progress.
	const issues = Array.from({ length: 20 }, (_, n) => ({ id: String(n + 1), updated: 1 + n }));
	const comments = Object.fromEntries(
		issues.map((item) => [item.id, [{ id: `c${item.id}`, updated: item.updated }]]),
	);
	const f = await activated(
		{ embedLimit: 0, issues, comments, costMs: 4_000, pageSize: 100 },
		{ params: { resource: 'comment' } },
	);
	const { delivered, polls } = await drain(f, 10_000, 20, { from: 100, pick: commentIds });
	assert.deepEqual(
		delivered,
		issues.map((item) => `c${item.id}`),
	);
	assert.ok(polls <= 20, `drained in ${polls} polls`);
});
test('an issue edited during the scan keeps its creation now and gets its update next poll', async () => {
	const issues = [1, 2, 3, 4].map((n) => ({ id: String(n), created: n, updated: n }));
	const f = await activated({ issues, costMs: 1_000 });
	f.ctx.getPollBudgetMs = () => 300_000;
	const server = f.ctx.helpers.httpRequestWithAuthentication;
	f.ctx.helpers.httpRequestWithAuthentication = async function (name, request) {
		const result = await server.call(this, name, request);
		// Issue 1 is edited after its page was read; Jira now reports the new time.
		if (request.method === 'POST' && !request.body.nextPageToken) issues[0].updated = 20;
		return result;
	};
	f.clock.now = 10;
	assert.deepEqual(emitted(await onClock(f.clock, f.ctx)), [
		['issue.created', '1'],
		['issue.created', '2'],
		['issue.created', '3'],
		['issue.created', '4'],
	]);
	f.clock.now = 100;
	assert.deepEqual(emitted(await onClock(f.clock, f.ctx)), [['issue.updated', '1']]);
	f.clock.now = 200;
	assert.equal(await onClock(f.clock, f.ctx), null);
});
test('returned timestamps newer than the search order cannot skip unread issues', async () => {
	// Every response reports "updated" as now, as a burst of edits during the
	// scan would; the continuation is by ID so page two is still read.
	const issues = [1, 2, 3, 4].map((n) => ({ id: String(n), created: n, updated: n }));
	const f = await activated({ issues, costMs: 6_000 });
	const server = f.ctx.helpers.httpRequestWithAuthentication;
	f.ctx.helpers.httpRequestWithAuthentication = async function (name, request) {
		const result = await server.call(this, name, request);
		for (const issue of result.issues ?? []) issue.fields.updated = iso(f.clock.now);
		return result;
	};
	const { delivered } = await drain(f, 10_000, 4, { from: 10, pick: emitted });
	assert.deepEqual(
		delivered.filter(([type]) => type === 'issue.created').map(([, id]) => id),
		['1', '2', '3', '4'],
	);
});
test('ties at the same updated time resume by issue ID without loss or duplicates', async () => {
	const issues = [1, 2, 3, 4, 5].map((n) => ({ id: String(n), updated: 1 }));
	const f = await activated({ issues, costMs: 6_000 });
	const { delivered } = await drain(f, 10_000, 5);
	assert.deepEqual(delivered, ['1', '2', '3', '4', '5']);
});
test('comment mode stopping mid-issue saves the comment offset and loses no comment', async () => {
	const issues = [
		{ id: '1', updated: 3 },
		{ id: '2', updated: 4 },
		{ id: '3', updated: 5 },
	];
	const comments = {
		1: [{ id: 'a', updated: 1 }],
		2: [
			{ id: 'b', updated: 1 },
			{ id: 'c', updated: 2 },
			{ id: 'd', updated: 3 },
		],
		3: [{ id: 'e', updated: 5 }],
	};
	const f = await activated(
		{ embedLimit: 0, issues, comments, costMs: 4_000 },
		{ params: { resource: 'comment' } },
	);
	// Search 4s, issue 1 comments 4s, issue 2 page one 4s, page two cannot fit.
	f.ctx.getPollBudgetMs = () => 13_000;
	f.clock.now = 10;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['a', 'b', 'c']);
	const { partial, ...window } = f.state.jiraPollState.window;
	assert.deepEqual(window, { since: epoch, until: epoch + 10, afterId: '1' });
	assert.equal(partial.issue.id, '2');
	assert.deepEqual([partial.startAt, partial.lastCommentId, partial.done], [2, 'c', false]);
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now = 100_000;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['d', 'e']);
	assert.equal(f.state.jiraPollState.window, undefined);
	f.clock.now = 200_000;
	assert.equal(await onClock(f.clock, f.ctx), null);
});
test('a partial first comment scan keeps its checkpoint and finishes the issue next poll', async () => {
	const comments = {
		1: [
			{ id: 'a', updated: 1 },
			{ id: 'b', updated: 2 },
			{ id: 'c', updated: 3 },
		],
	};
	const f = await activated(
		{ embedLimit: 0, issues: [{ id: '1', updated: 3 }], comments, costMs: 4_000 },
		{ params: { resource: 'comment' } },
	);
	f.ctx.getPollBudgetMs = () => 9_000;
	f.clock.now = 10;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['a', 'b']);
	assert.equal(f.state.jiraPollState.checkpoint, epoch);
	const { partial } = f.state.jiraPollState.window;
	assert.equal(partial.issue.id, '1');
	assert.deepEqual([partial.startAt, partial.lastCommentId, partial.done], [2, 'b', false]);
	f.clock.now = 100_000;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['c']);
	assert.equal(f.state.jiraPollState.window.partial, undefined);
	assert.equal(f.state.jiraPollState.checkpoint, epoch + 10, 'the first window closed');
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now = 200_000;
	assert.equal(await onClock(f.clock, f.ctx), null);
	assert.equal(f.state.jiraPollState.window, undefined);
});
test('a rate limit on the first request whose wait cannot fit fails visibly without advancing', async () => {
	const f = fixture({
		read: async () => {
			throw Object.assign(new Error('rate limited'), {
				response: { status: 429, headers: { 'retry-after': '30' } },
			});
		},
	});
	f.ctx.getPollBudgetMs = () => 20_000;
	await at(0, f.ctx);
	const before = structuredClone(f.state.jiraPollState);
	const started = Date.now();
	await assert.rejects(at(10, f.ctx), /stopped before reading anything new \(HTTP 429\)/);
	assert.ok(Date.now() - started < 5_000, 'must not wait for Retry-After');
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.state.jiraPollState, before);
});
test('an authentication failure after the deadline stays an error', async () => {
	const f = fixture({
		read: async () => {
			throw { statusCode: 401 };
		},
	});
	f.ctx.getPollBudgetMs = () => 1_000;
	await at(0, f.ctx);
	await assert.rejects(at(10, f.ctx), /HTTP 401/);
});
test('every request timeout is capped to the remaining budget, and a capped timeout stops rather than fails', async () => {
	const issues = [1, 2, 3, 4, 5, 6].map((n) => ({ id: String(n), updated: n }));
	const f = await activated({ issues, costMs: 8_000 });
	f.ctx.getPollBudgetMs = () => 20_000;
	f.clock.now = 10;
	// The third page cannot finish inside its 4 second cap: the poll keeps the
	// four issues it read and continues next time.
	assert.deepEqual(emittedIds(await onClock(f.clock, f.ctx)), ['1', '2', '3', '4']);
	assert.deepEqual(
		f.requests.map((request) => request.timeout),
		[20_000, 12_000, 4_000],
	);
	assert.equal(f.state.jiraPollState.window.afterId, '4');
	f.clock.now = 100_000;
	assert.deepEqual(emittedIds(await onClock(f.clock, f.ctx)), ['5', '6']);
});
test('manual runs ignore the host budget', async () => {
	const f = fixture({
		manual: true,
		read: async (_, count) =>
			count === 1
				? { issues: [issue('1')], isLast: false, nextPageToken: 'next' }
				: { issues: [issue('2')], isLast: true },
	});
	f.ctx.getPollBudgetMs = () => 0;
	assert.deepEqual(emittedIds(await at(10, f.ctx)), ['1', '2']);
	assert.deepEqual(f.state, {});
});

test('sustained arrivals faster than the scan rate still close windows, because a window is bounded by creation time', async () => {
	// Two pages per poll; every search adds four issues created "now", after
	// the open window's bound. The window closes on its original members and
	// later windows deliver the arrivals: nothing waits forever.
	const issues = [1, 2, 3, 4, 5, 6].map((n) => ({ id: String(n), created: n, updated: n }));
	const f = await activated({ issues, costMs: 4_000 });
	const server = f.ctx.helpers.httpRequestWithAuthentication;
	f.ctx.helpers.httpRequestWithAuthentication = async function (name, request) {
		const result = await server.call(this, name, request);
		if (request.method === 'POST' && !request.body.nextPageToken)
			for (let n = 0; n < 4; n++) {
				const id = String(issues.length + 1);
				issues.push({ id, created: f.clock.now, updated: f.clock.now });
			}
		return result;
	};
	f.ctx.getPollBudgetMs = () => 10_000;
	const delivered = [];
	const checkpoints = new Set();
	for (f.clock.now = 100; delivered.length < 30; f.clock.now += minute) {
		delivered.push(...emittedIds(await onClock(f.clock, f.ctx)));
		checkpoints.add(f.state.jiraPollState.checkpoint);
	}
	assert.deepEqual(
		delivered.slice(0, 6),
		['1', '2', '3', '4', '5', '6'],
		'the first window closes on its own members',
	);
	assert.equal(new Set(delivered).size, delivered.length, 'no duplicates');
	assert.ok(checkpoints.size > 2, 'checkpoints keep advancing');
});
test('a late-indexed lower ID does not displace the outstanding partial issue or replay its comments', async () => {
	const issues = [{ id: '20', created: 3, updated: 3 }];
	const comments = {
		20: [
			{ id: 'a', updated: 1 },
			{ id: 'b', updated: 2 },
		],
		15: [{ id: 'c15', updated: 2 }],
	};
	const f = await activated(
		{ embedLimit: 0, issues, comments, costMs: 4_000, pageSize: 1 },
		{ params: { resource: 'comment' } },
	);
	f.ctx.getPollBudgetMs = () => 10_000;
	f.clock.now = 10;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['a']);
	assert.equal(f.state.jiraPollState.window.partial.issue.id, '20');
	// Issue 15 only becomes searchable now, though it belongs to the window.
	issues.push({ id: '15', created: 2, updated: 2 });
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now = 100_000;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['b', 'c15']);
	assert.equal(f.state.jiraPollState.window, undefined);
	f.clock.now = 200_000;
	assert.equal(await onClock(f.clock, f.ctx), null);
});
test('a slow search followed by a slow comment read still drains, because the fetched issue is saved before enrichment', async () => {
	const issues = [1, 2].map((n) => ({ id: String(n), created: n, updated: n }));
	const comments = { 1: [{ id: 'c1', updated: 1 }], 2: [{ id: 'c2', updated: 2 }] };
	const f = await activated(
		{ embedLimit: 0, issues, comments, costMs: () => 20_000 },
		{ params: { resource: 'comment' } },
	);
	const { delivered, polls } = await drain(f, 36_000, 2, { from: 10, pick: commentIds });
	assert.deepEqual(delivered, ['c1', 'c2']);
	assert.ok(polls <= 5, `drained in ${polls} polls`);
	assert.ok(
		f.requests.every((request) => request.timeout <= 36_000),
		'no request outlives the budget',
	);
});
test('more than 40,000 events drain across polls instead of failing forever', async () => {
	// Twenty thousand issues edited inside one fifteen-minute window.
	const issues = Array.from({ length: 20_001 }, (_, n) => ({
		id: String(n + 1),
		created: n * 40,
		updated: n * 40 + 1,
	}));
	const f = await activated(
		{ issues, pageSize: 5_000 },
		{ params: { options: { overlapMinutes: 1 } } },
	);
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now = 6 * 60 * minute;
	const first = await onClock(f.clock, f.ctx);
	assert.equal(first[0].length, 40_000);
	assert.ok(f.state.jiraPollState.window, 'the cap stops the scan like a spent budget');
	assert.ok(f.state.jiraPollState.seen.length < 40_000, 'retired keys make room');
	f.clock.now += minute;
	const second = await onClock(f.clock, f.ctx);
	assert.equal(second[0].length, 2);
	assert.equal(f.state.jiraPollState.window, undefined);
	const ids = new Set([...first[0], ...second[0]].map((item) => item.json.eventId));
	assert.equal(ids.size, 40_002);
});
test('a rate limit after progress stops quietly on the output but warns in the log', async () => {
	const warnings = [];
	const f = fixture({
		read: async (request) => {
			if (request.body.nextPageToken)
				throw Object.assign(new Error('rate limited'), {
					response: { status: 429, headers: { 'retry-after': '30' } },
				});
			return { issues: [issue('1'), issue('2')], isLast: false, nextPageToken: 'next' };
		},
	});
	f.ctx.logger = { warn: (message) => warnings.push(message) };
	f.ctx.getPollBudgetMs = () => 20_000;
	await at(0, f.ctx);
	assert.deepEqual(emittedIds(await at(10, f.ctx)), ['1', '2']);
	assert.equal(f.state.jiraPollState.window.afterId, '2');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /HTTP 429/);
});

test('a deleted partial issue is dropped with a warning and the issues behind it still flow', async () => {
	const issues = [
		{ id: '1', created: 1, updated: 1 },
		{ id: '2', created: 2, updated: 2 },
	];
	const comments = { 1: [{ id: 'a', updated: 1 }], 2: [{ id: 'b', updated: 2 }] };
	const f = await activated(
		{ embedLimit: 0, issues, comments, costMs: () => 20_000 },
		{ params: { resource: 'comment' } },
	);
	f.ctx.getPollBudgetMs = () => 36_000;
	f.clock.now = 10;
	assert.equal(await onClock(f.clock, f.ctx), null);
	assert.equal(f.state.jiraPollState.window.partial.issue.id, '1');
	const warnings = [];
	f.ctx.logger = { warn: (message) => warnings.push(message) };
	// Issue 1 is deleted before its comments could be read: search no longer
	// lists it and its comment endpoint answers 404.
	issues.shift();
	const server = f.ctx.helpers.httpRequestWithAuthentication;
	f.ctx.helpers.httpRequestWithAuthentication = async function (name, request) {
		if (request.url.includes('/issue/1/')) throw { statusCode: 404 };
		return await server.call(this, name, request);
	};
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now = 100_000;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['b']);
	assert.equal(f.state.jiraPollState.window, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /dropped issue 1/);
});
test('a later stop that overwrites a finished partial does not replay its comments', async () => {
	// Issue 1 is finished ahead of the search, then the search stops inside
	// issue 2, whose partial replaces the finished one. Issue 1 is searched
	// again afterwards and its comments must not be emitted twice.
	const issues = [
		{ id: '1', created: 1, updated: 1 },
		{ id: '2', created: 2, updated: 2 },
	];
	const comments = {
		1: [{ id: 'a', updated: 1 }],
		2: [
			{ id: 'b', updated: 1 },
			{ id: 'c', updated: 2 },
		],
	};
	const f = await activated(
		{ embedLimit: 0, issues, comments, costMs: 4_000, pageSize: 1 },
		{ params: { resource: 'comment' } },
	);
	f.ctx.getPollBudgetMs = () => 6_000;
	f.clock.now = 10;
	assert.equal(await onClock(f.clock, f.ctx), null, 'search only; issue 1 saved at offset 0');
	f.ctx.getPollBudgetMs = () => 17_000;
	f.clock.now += minute;
	// Issue 1 comments 4s, two search pages 8s, issue 2 page one 4s, page two cannot fit.
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['a', 'b']);
	assert.equal(f.state.jiraPollState.window.partial.issue.id, '2');
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now += minute;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['c']);
	assert.equal(f.state.jiraPollState.window, undefined);
});
test('a comment created after the window bound on an older issue is emitted in the next window', async () => {
	const issues = [{ id: '1', created: 1, updated: 1 }];
	const comments = { 1: [{ id: 'a', updated: 5 }] };
	const f = await activated({ issues, comments }, { params: { resource: 'comment' } });
	f.ctx.getPollBudgetMs = () => 300_000;
	f.clock.now = 10;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['a']);
	comments[1].push({ id: 'b', updated: 50 });
	issues[0].updated = 50;
	f.clock.now = 100;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['b']);
	f.clock.now = 200;
	assert.equal(await onClock(f.clock, f.ctx), null);
});

test('an outage drains in time order: windows of fifteen minutes, whatever the issue IDs', async () => {
	// The newest issue has the oldest update: ID order alone would deliver 3 first.
	const issues = [
		{ id: '3', updated: 40 * minute },
		{ id: '2', updated: 20 * minute },
		{ id: '1', updated: 1 },
	];
	const f = await activated({ issues, pageSize: 100 });
	f.clock.now = 60 * minute;
	assert.deepEqual(emittedIds(await onClock(f.clock, f.ctx)), ['1', '2', '3']);
	assert.equal(
		f.state.jiraPollState.checkpoint,
		epoch + 60 * minute,
		'no budget: one poll reaches the present',
	);
	assert.deepEqual(
		f.requests.map((request) => /created <= (\d+)/.exec(request.body.jql)[1] - epoch),
		[15 * minute, 25 * minute, 35 * minute, 45 * minute, 55 * minute, 60 * minute],
		'each window spans fifteen minutes and starts an overlap before the last',
	);
});
test('comment mode uses the comments embedded in the search and requests none for small issues', async () => {
	const issues = [{ id: '1', updated: 3 }];
	const comments = {
		1: [
			{ id: 'a', updated: 1 },
			{ id: 'b', updated: 2 },
		],
	};
	const f = await activated(
		{ issues, comments },
		{ params: { resource: 'comment', options: { simplify: true } } },
	);
	f.clock.now = 10;
	const result = await onClock(f.clock, f.ctx);
	assert.deepEqual(
		result[0].map((item) => [item.json.id, item.json.body, 'comment' in item.json]),
		[
			['a', '<p>a</p>', false],
			['b', '<p>b</p>', false],
		],
	);
	assert.equal(f.requests.length, 1);
	assert.ok(f.requests[0].body.fields.includes('comment'));
});
test('comment mode requests comment pages only for an issue with more comments than the search embeds', async () => {
	const issues = [
		{ id: '1', updated: 3 },
		{ id: '2', updated: 4 },
	];
	const comments = {
		1: [{ id: 'a', updated: 1 }],
		2: [
			{ id: 'b', updated: 1 },
			{ id: 'c', updated: 2 },
			{ id: 'd', updated: 3 },
		],
	};
	const f = await activated(
		{ issues, comments, embedLimit: 2 },
		{ params: { resource: 'comment' } },
	);
	f.clock.now = 10;
	assert.deepEqual(commentIds(await onClock(f.clock, f.ctx)), ['a', 'b', 'c', 'd']);
	assert.deepEqual(
		f.requests.map((request) => request.url.split('/rest/api/3/')[1]),
		['search/jql', 'issue/2/comment', 'issue/2/comment'],
	);
});

// Authentication.
const oauthCredentials = {
	domain: 'example.atlassian.net/',
	oauthTokenData: { access_token: 'synthetic-access-token', refresh_token: 'r' },
};
const oauthServer = (resources) => async (request, count) => {
	if (request.url.endsWith('/oauth/token/accessible-resources')) return resources;
	assert.ok(request.url.startsWith('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/'));
	return { issues: count > 2 ? [issue()] : [], isLast: true };
};
test('OAuth2 routes through the gateway by cloud ID, caches it, and keeps the site in event IDs', async () => {
	const f = fixture({
		credentialType: 'jiraSoftwareCloudOAuth2Api',
		credentials: structuredClone(oauthCredentials),
		params: { authentication: 'oAuth2' },
		read: oauthServer([
			{ id: 'cloud-0', url: 'https://other.atlassian.net', name: 'Other' },
			{ id: 'cloud-1', url: 'https://EXAMPLE.atlassian.net', name: 'Example' },
		]),
	});
	assert.equal(await at(0, f.ctx), null);
	assert.equal(await at(10, f.ctx), null);
	const events = await at(20, f.ctx);
	assert.equal(events[0][0].json.eventId.split('/')[0], 'example.atlassian.net');
	assert.equal(
		f.requests.filter((request) => request.url.includes('accessible-resources')).length,
		1,
	);
	assert.equal(
		f.requests.at(-1).url,
		'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/search/jql',
	);
	assert.equal(f.requests.at(-1).disableFollowRedirect, true);
	assert.ok(f.requests.every((request) => request.timeout === 30_000));
	assert.deepEqual(f.options.at(-1), { oauth2: { tokenExpiredStatusCode: 403 } });
	assert.equal(f.state.jiraPollState.window, undefined);
	assert.equal(
		JSON.parse(f.state.jiraPollState.fingerprint).baseUrl,
		'https://example.atlassian.net',
	);
	assert.equal(JSON.stringify(f.state).includes('synthetic-access-token'), false);
});
test('OAuth2 fingerprint survives token refresh and refetches sites once on a cache miss', async () => {
	const resources = [];
	const f = fixture({
		credentialType: 'jiraSoftwareCloudOAuth2Api',
		credentials: structuredClone(oauthCredentials),
		params: { authentication: 'oAuth2' },
		read: oauthServer(resources),
	});
	await assert.rejects(at(0, f.ctx), /No Jira site matched example.atlassian.net/);
	assert.deepEqual(f.state, {});
	resources.push({ id: 'cloud-1', url: 'https://example.atlassian.net' });
	assert.equal(await at(10, f.ctx), null);
	const activation = f.state.jiraPollState.activation;
	f.credentials.oauthTokenData = { access_token: 'rotated-token', refresh_token: 'r2' };
	assert.equal(await at(20, f.ctx), null);
	assert.equal(f.state.jiraPollState.activation, activation);
	assert.equal(f.state.jiraPollState.checkpoint, epoch + 20);
	f.params.options.domain = 'https://second.atlassian.net';
	await assert.rejects(at(30, f.ctx), /No Jira site matched second.atlassian.net/);
	assert.equal(
		f.requests.filter((request) => request.url.includes('accessible-resources')).length,
		3,
	);
});
test('the API token path resumes state saved by the previous release without a reset', async () => {
	const f = fixture({ read: async () => ({ issues: [issue()], isLast: true }) });
	const { createHash } = require('node:crypto');
	f.state.jiraPollState = {
		version: 1,
		fingerprint: JSON.stringify({
			credential: `fixture-credential-${fixtureSequence}`,
			credentialRevision: createHash('sha256')
				.update(JSON.stringify([f.credentials.email, f.credentials.apiToken]))
				.digest('hex'),
			baseUrl: 'https://example.atlassian.net',
			resource: 'issue',
			event: 'createdOrUpdated',
			jql: '',
			excludedAccountIds: [],
			publicOnly: false,
			fields: ['summary', 'description', 'project', 'status', 'created', 'updated'],
		}),
		activation: epoch,
		checkpoint: epoch,
		seen: [],
	};
	assert.deepEqual(emittedIds(await at(10, f.ctx)), ['1']);
	assert.equal(f.state.jiraPollState.activation, epoch);
	assert.equal(f.requests[0].url, 'https://example.atlassian.net/rest/api/3/search/jql');
	assert.equal(f.requests[0].timeout, 30_000);
	assert.equal(f.options[0], undefined);
});
test('OAuth2 refreshes on 403 first and retries once on a 401 or 404 with that code', async () => {
	const calls = [];
	const f = fixture({
		credentialType: 'jiraSoftwareCloudOAuth2Api',
		credentials: structuredClone(oauthCredentials),
		params: { authentication: 'oAuth2' },
		read: async (request, count) => {
			calls.push([f.options[count - 1].oauth2.tokenExpiredStatusCode, request.timeout]);
			if (request.url.endsWith('/oauth/token/accessible-resources'))
				return [{ id: 'cloud-1', url: 'https://example.atlassian.net' }];
			if (calls.length === 2) throw { statusCode: 401 };
			if (calls.length === 4) throw { statusCode: 404 };
			return { issues: [issue()], isLast: true };
		},
	});
	f.ctx.getPollBudgetMs = () => 20_000;
	assert.equal(await at(0, f.ctx), null);
	assert.deepEqual(emittedIds(await at(10, f.ctx)), ['1']);
	assert.deepEqual(emittedIds(await at(20, f.ctx)), []);
	assert.deepEqual(calls, [
		[403, 20_000],
		[403, 20_000],
		[401, 20_000],
		[403, 20_000],
		[404, 20_000],
	]);
	f.ctx.helpers.httpRequestWithAuthentication = async () => {
		throw { statusCode: 403 };
	};
	await assert.rejects(at(30, f.ctx), /HTTP 403/);
});
