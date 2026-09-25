const test = require('node:test');
const assert = require('node:assert/strict');
const { JiraTransport, buildPollingJql } = require('../dist/nodes/JiraPollTrigger/transport');
const { NodeApiError } = require('n8n-workflow');
const fixtureNode = {
	id: 'fixture-node',
	name: 'Jira Poll Trigger',
	type: 'jiraPollTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
/** n8n rewrites message and httpCode and keeps the axios error under `cause` only. */
const nodeApiError = (status, headers) =>
	new NodeApiError(
		fixtureNode,
		Object.assign(new Error(`Request failed with status code ${status}`), {
			isAxiosError: true,
			code: 'ERR_BAD_REQUEST',
			response: { status, headers, data: {} },
		}),
	);
const issue = (id) => ({
	id,
	key: `TEST-${id}`,
	fields: { created: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z' },
});
const comment = (id) => ({
	id,
	created: '2020-01-01T00:00:00Z',
	updated: '2026-01-02T00:00:00Z',
	body: { type: 'doc' },
	renderedBody: '<p>Latest</p>',
	jsdPublic: false,
});
async function collect(iterator) {
	const items = [];
	for await (const item of iterator) items.push(item);
	return items;
}

test('API version rejects unsupported values', () => {
	for (const apiVersion of [1, 4, '2', 0])
		assert.throws(() => new JiraTransport(async () => ({}), { apiVersion }), /API version/);
});
test('API v2 paginates issues and comments while preserving native wiki markup and metadata', async () => {
	const calls = [];
	const transport = new JiraTransport(
		async (request) => {
			calls.push(request);
			if (request.method === 'POST') {
				const second = request.body.nextPageToken === 'next';
				return {
					issues: [
						{
							...issue(second ? '2' : '1'),
							fields: { ...issue('1').fields, description: 'h2. Details\n*bold*' },
						},
					],
					isLast: second,
					...(second ? {} : { nextPageToken: 'next' }),
				};
			}
			return {
				comments: [
					{
						...comment(String(request.qs.startAt + 1)),
						body: '*Comment* [link|https://example.org]',
						author: { accountId: 'author' },
						updateAuthor: { accountId: 'editor' },
					},
				],
				startAt: request.qs.startAt,
				maxResults: 100,
				total: 2,
			};
		},
		{ apiVersion: 2 },
	);
	const issues = await collect(transport.searchIssues('project=A', 10, []));
	const comments = await collect(transport.comments('A/B'));
	assert.equal(issues.length, 2);
	assert.equal(comments.length, 2);
	for (const item of issues) assert.equal(item.fields.description, 'h2. Details\n*bold*');
	for (const item of comments) {
		assert.equal(item.body, '*Comment* [link|https://example.org]');
		assert.equal(item.author.accountId, 'author');
		assert.equal(item.updateAuthor.accountId, 'editor');
		assert.equal(item.jsdPublic, false);
	}
	for (const request of calls.slice(0, 2)) {
		assert.equal(request.path, '/rest/api/2/search/jql');
		assert.equal(request.body.expand, 'renderedFields');
		assert.equal(request.body.jql, '(project=A) AND updated >= 10 ORDER BY created ASC, key ASC');
	}
	for (const request of calls.slice(2)) {
		assert.equal(request.path, '/rest/api/2/issue/A%2FB/comment');
		assert.equal(request.qs.expand, 'renderedBody');
		assert.equal(request.qs.orderBy, 'created');
	}
});

test('JQL groups OR predicates and uses epoch lower boundary without an upper constraint', () => {
	assert.equal(
		buildPollingJql('project=A OR project=B', 1234),
		'(project=A OR project=B) AND updated >= 1234 ORDER BY created ASC, key ASC',
	);
	assert.equal(buildPollingJql('  ', 0), 'updated >= 0 ORDER BY created ASC, key ASC');
	assert.equal(
		buildPollingJql('project=A', 10, 'ASC', 60, 120),
		'(project=A) AND updated >= 10 AND created <= 120 AND created >= 60 ORDER BY created ASC, key ASC',
	);
});
test('JQL sorts ascending by default and descending on request', async () => {
	assert.equal(
		buildPollingJql('project=A', 1),
		'(project=A) AND updated >= 1 ORDER BY created ASC, key ASC',
	);
	assert.equal(
		buildPollingJql('project=A', 1, 'DESC'),
		'(project=A) AND updated >= 1 ORDER BY created DESC, key DESC',
	);
	const requests = [];
	const transport = new JiraTransport(async (request) => {
		requests.push(request);
		return { issues: [], isLast: true };
	});
	await collect(transport.searchIssues('project=A', 10, []));
	await collect(transport.searchIssues('project=A', 10, [], { direction: 'DESC' }));
	assert.deepEqual(
		requests.map((request) => request.body.jql),
		[
			'(project=A) AND updated >= 10 ORDER BY created ASC, key ASC',
			'(project=A) AND updated >= 10 ORDER BY created DESC, key DESC',
		],
	);
});
test('JQL distinguishes top-level ORDER BY from quoted and escaped literals', () => {
	for (const query of [
		'summary ~ "ORDER BY"',
		"summary ~ 'order by'",
		'summary ~ "escaped \\" ORDER BY"',
		'issueFunction in expression("order by")',
	])
		assert.doesNotThrow(() => buildPollingJql(query, 0));
	for (const query of [
		'project=A ORDER BY updated',
		'ORDER\nBY updated',
		'summary ~ "x" order by created',
	])
		assert.throws(() => buildPollingJql(query, 0), /ORDER BY/);
	for (const query of ['project=(A', 'project=A)', 'summary ~ "unclosed'])
		assert.throws(() => buildPollingJql(query, 0), /JQL/);
	assert.throws(() => buildPollingJql('', NaN), /boundary/);
});
test('search follows tokens and requests timestamps and rendered descriptions on every page', async () => {
	const calls = [];
	const transport = new JiraTransport(async (request) => {
		calls.push(request);
		// No isLast: the token key alone decides whether a page is the last one.
		return calls.length === 1
			? { issues: [issue('1')], nextPageToken: 'next' }
			: { issues: [issue('2')], nextPageToken: null };
	});
	assert.equal((await collect(transport.searchIssues('project=A', 10, ['summary']))).length, 2);
	assert.equal(calls[0].path, '/rest/api/3/search/jql');
	assert.equal(calls[0].method, 'POST');
	for (const call of calls) {
		assert.deepEqual(call.body.fields, ['created', 'updated', 'project', 'summary']);
		assert.equal(call.body.expand, 'renderedFields');
	}
	assert.equal(calls[1].body.nextPageToken, 'next');
});
test('a tokenless page replay verifies its request digest and last issue before continuing', async () => {
	const minute = Date.parse('2026-01-01T00:00:00Z');
	let savedPage;
	const initial = new JiraTransport(async (request) =>
		request.body.nextPageToken
			? { issues: [issue('2')], isLast: true }
			: { issues: [issue('1')], isLast: false, nextPageToken: 'next' },
	);
	assert.deepEqual(
		await collect(
			initial.searchIssues('', minute, [], {
				createdBefore: minute + 60_000,
				pageProgress: (requestToken, key, created, requestKey) => {
					if (requestToken === undefined) savedPage = { key, created, requestKey };
				},
			}),
		),
		[issue('1'), issue('2')],
	);
	assert(savedPage);
	const calls = [];
	let resumed = false;
	const fallbacks = [];
	const replay = new JiraTransport(async (request) => {
		calls.push(request);
		return request.body.nextPageToken
			? { issues: [issue('2')], isLast: true }
			: { issues: [issue('1')], isLast: false, nextPageToken: 'next' };
	});
	assert.deepEqual(
		(
			await collect(
				replay.searchIssues('', minute, [], {
					afterCreated: minute,
					createdBefore: minute + 60_000,
					resumeWithPageToken: true,
					pageTokenLastKey: savedPage.key,
					pageTokenLastCreated: savedPage.created,
					pageTokenRequestKey: savedPage.requestKey,
					fallbackAfterCreated: minute,
					pageTokenResume: () => {
						resumed = true;
					},
					pageTokenFallback: (reason) => fallbacks.push(reason),
				}),
			)
		).map((item) => item.id),
		['2'],
	);
	assert.equal(resumed, true);
	assert.deepEqual(fallbacks, []);
	assert.equal(calls[0].body.nextPageToken, undefined);
	assert.match(calls[0].body.jql, new RegExp(`created >= ${minute}`));
	assert.equal(calls[1].body.nextPageToken, 'next');

	const changedDigest = new JiraTransport(async () => ({ issues: [], isLast: true }));
	await collect(
		changedDigest.searchIssues('', minute, [], {
			afterCreated: minute,
			createdBefore: minute + 60_000,
			resumeWithPageToken: true,
			pageTokenLastKey: savedPage.key,
			pageTokenLastCreated: savedPage.created,
			pageTokenRequestKey: 'different-request',
			fallbackAfterCreated: minute,
			pageTokenFallback: (reason) => fallbacks.push(reason),
		}),
	);
	assert.deepEqual(fallbacks, ['request-mismatch']);
});
test('only expired or inconsistent page tokens fall back to the minute query', async () => {
	for (const status of [400, 404, 410]) {
		const calls = [];
		const fallbacks = [];
		const transport = new JiraTransport(
			async (request) => {
				calls.push(request);
				if (request.body.nextPageToken) throw nodeApiError(status);
				return { issues: [], isLast: true };
			},
			{ maxRetries: 0 },
		);
		assert.deepEqual(
			await collect(
				transport.searchIssues('', 0, [], {
					pageToken: 'saved',
					pageTokenLastKey: 'TEST-1',
					fallbackAfterCreated: 0,
					pageTokenFallback: (reason) => fallbacks.push(reason),
				}),
			),
			[],
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].body.nextPageToken, 'saved');
		assert.equal(calls[1].body.nextPageToken, undefined);
		assert.deepEqual(fallbacks, ['rejected']);
	}
	for (const status of [401, 403, 408, 429]) {
		const calls = [];
		const fallbacks = [];
		const transport = new JiraTransport(
			async (request) => {
				calls.push(request);
				throw nodeApiError(status, { 'Retry-After': '0' });
			},
			{ maxRetries: 0 },
		);
		await assert.rejects(
			collect(
				transport.searchIssues('', 0, [], {
					pageToken: 'saved',
					pageTokenLastKey: 'TEST-1',
					fallbackAfterCreated: 0,
					pageTokenFallback: (reason) => fallbacks.push(reason),
				}),
			),
			(error) => error.status === status,
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(fallbacks, []);
	}
});
test('isLast is optional and cross-checked against the token key', async () => {
	for (const last of [{ nextPageToken: '' }, { nextPageToken: null }, { isLast: true }]) {
		assert.deepEqual(
			await collect(
				new JiraTransport(async () => ({ issues: [issue('1')], ...last })).searchIssues('', 0, []),
			),
			[issue('1')],
		);
	}
	for (const contradiction of [
		{ isLast: true, nextPageToken: 'next' },
		{ isLast: false, nextPageToken: '' },
	]) {
		await assert.rejects(
			collect(
				new JiraTransport(async () => ({
					issues: [issue('1')],
					...contradiction,
				})).searchIssues('', 0, []),
			),
			/invalid search pagination/,
		);
	}
	await assert.rejects(
		collect(new JiraTransport(async () => ({ issues: [issue('1')] })).searchIssues('', 0, [])),
		/invalid search pagination/,
	);
});
test('search preserves structured and rendered descriptions without duplicating requested fields', async () => {
	const returned = issue('1');
	returned.fields.description = {
		type: 'doc',
		version: 1,
		content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Details' }] }],
	};
	returned.renderedFields = { description: '<p>Details</p>' };
	const transport = new JiraTransport(async (request) => {
		assert.deepEqual(request.body.fields, ['created', 'updated', 'project', 'description']);
		assert.equal(request.body.expand, 'renderedFields');
		return { issues: [returned], isLast: true };
	});
	assert.deepEqual(await collect(transport.searchIssues('', 0, ['description'])), [returned]);
});
test('comment pagination fetches old comments, preserves raw data and advances by returned count', async () => {
	const calls = [];
	const transport = new JiraTransport(async (request) => {
		calls.push(request);
		return {
			comments: [comment(String(calls.length))],
			startAt: calls.length - 1,
			maxResults: 100,
			total: 2,
		};
	});
	const comments = await collect(transport.comments('A/B'));
	assert.deepEqual(comments, [comment('1'), comment('2')]);
	assert.equal(calls[0].path, '/rest/api/3/issue/A%2FB/comment');
	assert.equal(calls[1].qs.startAt, 1);
	assert.equal(calls[0].qs.expand, 'renderedBody');
	assert.equal(calls[0].qs.orderBy, 'created');
});
test('later page failures propagate and do not become partial success', async () => {
	let calls = 0;
	const transport = new JiraTransport(async () => {
		if (++calls === 1) return { issues: [issue('1')], isLast: false, nextPageToken: 'next' };
		throw { statusCode: 403, message: 'secret token' };
	});
	await assert.rejects(
		collect(transport.searchIssues('', 0, [])),
		(error) => /403/.test(error.message) && !/secret/.test(error.message),
	);
	assert.equal(calls, 2);
});
test('malformed and non-progressing pagination fail', async () => {
	for (const response of [
		{ issues: [] },
		{ issues: [], isLast: false, nextPageToken: 'next' },
		{ issues: [issue('1')], isLast: false },
		{ issues: [{}], isLast: true },
	]) {
		await assert.rejects(
			collect(new JiraTransport(async () => response).searchIssues('', 0, [])),
			/invalid|advance/,
		);
	}
	await assert.rejects(
		collect(
			new JiraTransport(async () => ({
				issues: [issue('1')],
				isLast: false,
				nextPageToken: 'same',
			})).searchIssues('', 0, []),
		),
		/advance/,
	);
	for (const response of [
		{ comments: [], startAt: 0, total: 1, maxResults: 100 },
		{ comments: [], startAt: 4, total: 1, maxResults: 100 },
		{ comments: [], startAt: 0, total: -1, maxResults: 100 },
	]) {
		await assert.rejects(
			collect(new JiraTransport(async () => response).comments('1')),
			/invalid|advance/,
		);
	}
});
test('empty complete pages return no items', async () => {
	assert.deepEqual(
		await collect(
			new JiraTransport(async () => ({ issues: [], isLast: true })).searchIssues('', 0, []),
		),
		[],
	);
	assert.deepEqual(
		await collect(
			new JiraTransport(async () => ({
				comments: [],
				startAt: 0,
				total: 0,
				maxResults: 100,
			})).comments('1'),
		),
		[],
	);
});
test('manual page limits and early iterator termination bound requests', async () => {
	let calls = 0;
	const transport = new JiraTransport(async () => ({
		issues: [issue(String(++calls))],
		isLast: false,
		nextPageToken: String(calls),
	}));
	assert.equal((await collect(transport.searchIssues('', 0, [], { maxPages: 2 }))).length, 2);
	assert.equal(calls, 2);
	for await (const item of transport.searchIssues('', 0, [])) {
		assert.ok(item);
		break;
	}
	assert.equal(calls, 3);
	await assert.rejects(collect(transport.searchIssues('', 0, [], { maxPages: 0 })), /limit/);
});
test('transient failures retry with exponential delay then succeed', async () => {
	let calls = 0;
	const waits = [];
	const transport = new JiraTransport(
		async () => {
			if (++calls < 3) throw { response: { status: 503 } };
			return { issues: [], isLast: true };
		},
		{
			sleep: async (ms) => {
				waits.push(ms);
			},
		},
	);
	await collect(transport.searchIssues('', 0, []));
	assert.deepEqual(waits, [1000, 2000]);
});
test('Retry-After seconds and HTTP dates survive the NodeApiError wrapper', async () => {
	for (const retryAfter of ['4', 'Thu, 01 Jan 1970 00:00:04 GMT']) {
		let calls = 0;
		const waits = [];
		const transport = new JiraTransport(
			async () => {
				if (++calls === 1) throw nodeApiError(429, { 'Retry-After': retryAfter });
				return { issues: [], isLast: true };
			},
			{
				now: () => 0,
				sleep: async (ms) => {
					waits.push(ms);
				},
			},
		);
		await collect(transport.searchIssues('', 0, []));
		assert.deepEqual(waits, [4000]);
	}
});
test('retry budget fails without shortening excessive Retry-After', async () => {
	let calls = 0;
	let waited = false;
	const transport = new JiraTransport(
		async () => {
			calls++;
			throw nodeApiError(429, { 'retry-after': '120' });
		},
		{
			sleep: async () => {
				waited = true;
			},
		},
	);
	await assert.rejects(collect(transport.searchIssues('', 0, [])), /429/);
	assert.equal(calls, 1);
	assert.equal(waited, false);
});
test('a wrapped network failure retries on the code held under cause', async () => {
	let calls = 0;
	await assert.rejects(
		collect(
			new JiraTransport(
				async () => {
					calls++;
					throw new NodeApiError(
						fixtureNode,
						Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
					);
				},
				{ sleep: async () => {} },
			).searchIssues('', 0, []),
		),
		/Jira read failed/,
	);
	assert.equal(calls, 4);
});
test('network retries are bounded and permanent errors do not retry', async () => {
	for (const [error, expected] of [
		[{ code: 'ECONNRESET' }, 4],
		[{ statusCode: 401 }, 1],
		[{ statusCode: 400 }, 1],
	]) {
		let calls = 0;
		await assert.rejects(
			collect(
				new JiraTransport(
					async () => {
						calls++;
						throw error;
					},
					{ sleep: async () => {} },
				).searchIssues('', 0, []),
			),
			/Jira read failed/,
		);
		assert.equal(calls, expected);
	}
});

test('permanent Jira errors retain status and Jira error and warning text', async () => {
	await assert.rejects(
		collect(
			new JiraTransport(async () => {
				throw Object.assign(new Error('Request failed'), {
					response: {
						status: 403,
						data: {
							errorMessages: ['Permission denied.'],
							warningMessages: ['Token revoked.'],
						},
					},
				});
			}).searchIssues('', 0, []),
		),
		(error) => {
			assert.equal(error.status, 403);
			assert.equal(error.details, 'Permission denied.; Token revoked.');
			assert.match(error.message, /HTTP 403/);
			assert.match(error.message, /Permission denied\./);
			assert.match(error.message, /Token revoked\./);
			return true;
		},
	);
});

test('timed out reads are labelled as timeouts rather than access failures', async () => {
	await assert.rejects(
		collect(
			new JiraTransport(
				async () => {
					throw Object.assign(new Error('timeout of 30 seconds exceeded'), {
						code: 'ECONNABORTED',
					});
				},
				{ maxRetries: 0 },
			).searchIssues('', 0, []),
		),
		(error) => {
			assert.equal(error.timedOut, true);
			assert.match(error.message, /timed out/i);
			assert.doesNotMatch(error.message, /check Jira access/i);
			return true;
		},
	);
});

test('search warnings cannot silently accept potentially truncated results', async () => {
	await assert.rejects(
		collect(
			new JiraTransport(async () => ({
				issues: [issue('1')],
				isLast: true,
				warnings: [{ message: 'secret private query' }],
			})).searchIssues('', 0, []),
		),
		(error) => /incomplete/.test(error.message) && !/secret/.test(error.message),
	);
	await assert.rejects(
		collect(
			new JiraTransport(async () => ({
				issues: [],
				isLast: true,
				warningMessages: ['private warning'],
			})).searchIssues('', 0, []),
		),
		(error) => /incomplete/.test(error.message) && !/private warning/.test(error.message),
	);
});

test('repeated entities fail even when pagination markers keep advancing', async () => {
	let calls = 0;
	await assert.rejects(
		collect(
			new JiraTransport(async () => ({
				issues: [issue('1')],
				isLast: false,
				nextPageToken: String(++calls),
			})).searchIssues('', 0, []),
		),
		/repeated/,
	);
	calls = 0;
	await assert.rejects(
		collect(
			new JiraTransport(async () => ({
				comments: [comment('1')],
				startAt: calls++,
				maxResults: 100,
				total: 3,
			})).comments('1'),
		),
		/repeated/,
	);
});
test('a continuation resumes by creation minute without naming handled keys', () => {
	assert.equal(
		buildPollingJql('project=A', 61_500, 'ASC', 60_000, 70_000),
		'(project=A) AND updated >= 61500 AND created <= 70000 AND created >= 60000 ORDER BY created ASC, key ASC',
	);
	assert.equal(
		buildPollingJql('project=A', 61_500, 'ASC', 60_000),
		'(project=A) AND updated >= 61500 AND created >= 60000 ORDER BY created ASC, key ASC',
	);
	assert.throws(() => buildPollingJql('', 1, 'ASC', NaN), /continuation/);
});
test('the deadline caps every timeout, refuses a request once passed, and stops rather than sleeping past it', async () => {
	const { PollBudgetExhausted } = require('../dist/nodes/JiraPollTrigger/poll-state');
	let clock = 0;
	const calls = [];
	const transport = new JiraTransport(
		async (request) => {
			calls.push(request);
			clock += 500;
			return {
				issues: [issue(String(calls.length))],
				isLast: false,
				nextPageToken: `p${calls.length}`,
			};
		},
		{ now: () => clock, deadline: 1_200 },
	);
	const issues = [];
	await assert.rejects(
		(async () => {
			for await (const item of transport.searchIssues('', 0, [])) issues.push(item);
		})(),
		PollBudgetExhausted,
	);
	assert.deepEqual(
		calls.map((call) => call.timeout),
		[1_200, 700, 200],
	);
	assert.equal(issues.length, 3);
	const { requestTimeout } = require('../dist/nodes/JiraPollTrigger/transport');
	assert.equal(requestTimeout(1_000, 999), 1);
	assert.equal(requestTimeout(undefined, 0), 30_000);
	assert.throws(() => requestTimeout(1_000, 1_000), PollBudgetExhausted);
	const sleeps = [];
	let attempts = 0;
	await assert.rejects(
		collect(
			new JiraTransport(
				async () => {
					attempts++;
					throw nodeApiError(429, { 'Retry-After': '5' });
				},
				{ now: () => 0, deadline: 4_000, sleep: async (ms) => sleeps.push(ms) },
			).searchIssues('', 0, []),
		),
		PollBudgetExhausted,
	);
	assert.equal(attempts, 1);
	assert.deepEqual(sleeps, []);
});
test('a timeout on the final retry at the deadline is a budget stop, but a 401 is not', async () => {
	const { PollBudgetExhausted } = require('../dist/nodes/JiraPollTrigger/poll-state');
	let clock = 0;
	let attempts = 0;
	await assert.rejects(
		collect(
			new JiraTransport(
				async () => {
					attempts++;
					clock = 10_000;
					throw { code: 'ECONNABORTED' };
				},
				{ now: () => clock, deadline: 10_000, maxRetries: 0, sleep: async () => {} },
			).searchIssues('', 0, []),
		),
		PollBudgetExhausted,
	);
	assert.equal(attempts, 1);
	await assert.rejects(
		collect(
			new JiraTransport(
				async () => {
					throw { statusCode: 401 };
				},
				{ now: () => 0, deadline: 10_000 },
			).searchIssues('', 0, []),
		),
		/HTTP 401/,
	);
});
test('comments resume one comment early, verify it, and restart from the top after a deletion', async () => {
	const run = async (resumeAfter) => {
		const calls = [];
		const progress = [];
		const transport = new JiraTransport(async (request) => {
			calls.push(request.qs.startAt);
			return {
				comments: [comment(String(request.qs.startAt))],
				startAt: request.qs.startAt,
				maxResults: 1,
				total: 302,
			};
		});
		const items = await collect(
			transport.comments('1', {
				resumeAt: 300,
				resumeAfter,
				maxPages: 3,
				progress: (next, last) => progress.push([next, last]),
			}),
		);
		return { calls, progress, ids: items.map((item) => item.id) };
	};
	assert.deepEqual(await run('299'), {
		calls: [299, 300, 301],
		progress: [
			[300, '299'],
			[301, '300'],
			[302, '301'],
		],
		ids: ['299', '300', '301'],
	});
	assert.deepEqual((await run('deleted')).calls, [299, 0, 1, 2]);
	const transport = new JiraTransport(async () => ({}));
	await assert.rejects(collect(transport.comments('1', { resumeAt: -1 })), /continuation/);
});
