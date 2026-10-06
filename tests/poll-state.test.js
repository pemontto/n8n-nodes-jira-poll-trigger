const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	scanPoll,
	PollBudgetExhausted,
	MAX_DEDUP_KEYS,
	JiraReadError,
	PaginationProgressError,
} = require('../dist/nodes/JiraPollTrigger/poll-state.js');
const iso = (n) => new Date(n).toISOString();
const config = {
	resource: 'comment',
	event: 'createdOrUpdated',
	fingerprint: 'a',
	overlapMs: 300,
	excludedAccountIds: [],
	publicOnly: false,
};
const issue = {
	id: '1',
	key: 'TEST-1',
	fields: { created: iso(1100), updated: iso(1200) },
};
const comment = (created = 1100, updated = 1200, extra = {}) => ({
	id: '2',
	created: iso(created),
	updated: iso(updated),
	body: { type: 'doc', content: [] },
	...extra,
});
const state = () => ({
	version: 2,
	fingerprint: 'a',
	activation: 1000,
	checkpoint: 1000,
	seen: [],
});
const source = (comments = []) => ({
	async *issues() {
		yield issue;
	},
	async *comments() {
		yield* comments;
	},
});
const poll = (comments, options = {}) =>
	scanPoll({
		config,
		state: state(),
		pollStart: 1300,
		source: source(comments),
		...options,
	});

test('activation and changed configuration start now without reading history', async () => {
	const unreadable = {
		issues() {
			throw new Error('read');
		},
		comments() {
			throw new Error('read');
		},
	};
	for (const previous of [undefined, { ...state(), fingerprint: 'old' }]) {
		const result = await scanPoll({
			config,
			state: previous,
			pollStart: 1500,
			source: unreadable,
		});
		assert.deepEqual(result.events, []);
		assert.equal(result.state.activation, 1500);
	}
});
for (const resource of ['issue', 'comment'])
	for (const event of ['created', 'updated', 'createdOrUpdated']) {
		test(`${resource} ${event} checks creation and edit independently`, async () => {
			const result = await poll([comment()], {
				config: { ...config, resource, event },
			});
			assert.deepEqual(
				result.events.map((e) => e.eventType),
				event === 'createdOrUpdated'
					? [`${resource}.created`, `${resource}.updated`]
					: [`${resource}.${event}`],
			);
			assert.equal(new Set(result.events.map((e) => e.eventId)).size, result.events.length);
			if (resource === 'comment')
				for (const e of result.events)
					assert.deepEqual(e.comment.body, { type: 'doc', content: [] });
		});
	}
test('an edit observed during pagination defers only edit, then emits it next poll', async () => {
	const first = await poll([comment(1100, 1400)]);
	assert.deepEqual(
		first.events.map((e) => e.eventType),
		['comment.created'],
	);
	const next = await poll([comment(1100, 1400)], {
		state: first.state,
		pollStart: 1500,
	});
	assert.deepEqual(
		next.events.map((e) => e.eventType),
		['comment.updated'],
	);
});
test('issue updated beyond upper bound does not suppress its creation', async () => {
	const result = await poll([], {
		config: { ...config, resource: 'issue' },
		source: {
			async *issues() {
				yield { ...issue, fields: { created: iso(1100), updated: iso(1500) } };
			},
			async *comments() {},
		},
	});
	assert.deepEqual(
		result.events.map((e) => e.eventType),
		['issue.created'],
	);
});
test('old comments are edited events and equal timestamps never imply edits', async () => {
	const result = await poll([comment(100, 1200), comment(1200, 1200, { id: '3' })]);
	assert.deepEqual(
		result.events.map((e) => e.eventType),
		['comment.updated', 'comment.created'],
	);
});
test('activation clamps overlap and boundaries are inclusive', async () => {
	const result = await poll([
		comment(999, 999),
		comment(1000, 1000, { id: 'a' }),
		comment(1300, 1300, { id: 'b' }),
		comment(1301, 1301, { id: 'c' }),
	]);
	assert.deepEqual(
		result.events.map((e) => e.comment.id),
		['a', 'b'],
	);
});
test('creation key expires by created time, edit key by updated time', async () => {
	const first = await poll([comment(1100, 1250)]);
	const next = await poll([comment(1100, 1250)], {
		state: first.state,
		pollStart: 1500,
	});
	assert.equal(next.events.length, 0);
	assert.deepEqual(
		next.state.seen.map((e) => e.time),
		[1250],
	);
	const third = await poll([comment(1100, 1550)], {
		state: next.state,
		pollStart: 1600,
	});
	assert.deepEqual(
		third.events.map((e) => e.eventType),
		['comment.updated'],
	);
	assert.deepEqual(
		third.state.seen.map((e) => e.time),
		[1550],
	);
});
test('duplicate issue or comment pages are deduplicated in the same scan', async () => {
	const result = await poll([comment(), comment()]);
	assert.equal(result.events.length, 2);
});
test('page failure never mutates saved checkpoint or seen keys', async () => {
	const previous = state();
	const original = structuredClone(previous);
	await assert.rejects(
		poll([], {
			state: previous,
			source: {
				async *issues() {
					yield issue;
					throw new Error('page failed');
				},
				async *comments() {
					yield comment();
				},
			},
		}),
		/page failed/,
	);
	assert.deepEqual(previous, original);
});
test('comment page failure never mutates saved state', async () => {
	const previous = state();
	await assert.rejects(
		poll([], {
			state: previous,
			source: {
				async *issues() {
					yield issue;
				},
				async *comments() {
					yield comment();
					throw new Error('comment page');
				},
			},
		}),
		/comment page/,
	);
	assert.deepEqual(previous, state());
});
test('excluded creation actor does not suppress allowed edit and vice versa', async () => {
	const result = await poll(
		[
			comment(1100, 1200, {
				author: { accountId: 'blocked' },
				updateAuthor: { accountId: 'allowed' },
			}),
			comment(1100, 1200, {
				id: '3',
				author: { accountId: 'allowed' },
				updateAuthor: { accountId: 'blocked' },
			}),
		],
		{ config: { ...config, excludedAccountIds: ['blocked'] } },
	);
	assert.deepEqual(
		result.events.map((e) => [e.comment.id, e.eventType]),
		[
			['2', 'comment.updated'],
			['3', 'comment.created'],
		],
	);
});
test('public only excludes false and unknown; all accessible preserves every comment', async () => {
	const comments = [
		comment(1100, 1100, { id: 'public', jsdPublic: true }),
		comment(1100, 1100, { id: 'private', jsdPublic: false }),
		comment(1100, 1100, { id: 'unknown' }),
	];
	assert.deepEqual(
		(await poll(comments, { config: { ...config, publicOnly: true } })).events.map(
			(e) => e.comment.id,
		),
		['public'],
	);
	assert.equal((await poll(comments)).events.length, 3);
});
test('manual sample finds one old matching event without modifying or replacing state', async () => {
	const previous = state();
	let reads = 0;
	const result = await poll([], {
		state: previous,
		manual: true,
		source: {
			async *issues() {
				yield issue;
				throw new Error('must stop');
			},
			async *comments() {
				reads++;
				yield comment(10, 20);
				throw new Error('must stop');
			},
		},
	});
	assert.equal(result.events.length, 1);
	assert.equal(result.state, previous);
	assert.deepEqual(previous, state());
	assert.equal(reads, 1);
});
test('empty successful scan advances replacement checkpoint', async () => {
	const result = await poll([]);
	assert.deepEqual(result.events, []);
	assert.equal(result.state.checkpoint, 1300);
});
test('ordinary restart resumes serialised saved state', async () => {
	const first = await poll([comment()]);
	const result = await poll([comment()], {
		state: JSON.parse(JSON.stringify(first.state)),
		pollStart: 1400,
	});
	assert.deepEqual(result.events, []);
	assert.equal(result.state.activation, 1000);
});
test('recent keys evict oldest entries with one warning and keep reading', async () => {
	const previous = state();
	const original = structuredClone(previous);
	const warnings = [];
	const result = await poll([], {
		state: previous,
		warn: (message) => warnings.push(message),
		source: {
			async *issues() {
				yield issue;
			},
			async *comments() {
				for (let i = 0; i < MAX_DEDUP_KEYS + 3; i++) yield comment(1200, 1200, { id: String(i) });
			},
		},
	});
	assert.equal(result.events.length, MAX_DEDUP_KEYS + 3);
	assert.equal(result.stopped, undefined);
	assert.equal(result.state.checkpoint, 1300);
	assert.equal(result.state.seen.length, MAX_DEDUP_KEYS);
	assert.equal(JSON.parse(result.state.seen[0].key)[2], '3');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /40,000.*evicted/);
	assert.deepEqual(previous, original);
});

test('Jira failures outside budget stops throw with status and leave saved state untouched', async () => {
	for (const status of [401, 403, 404, 429, 503]) {
		const previous = state();
		const original = structuredClone(previous);
		await assert.rejects(
			scanPoll({
				config: { ...config, resource: 'issue' },
				state: previous,
				pollStart: 1300,
				source: {
					async *issues() {
						yield issue;
						throw new JiraReadError(`Jira read failed (HTTP ${status})`, status);
					},
					async *comments() {},
				},
			}),
			(error) => error instanceof JiraReadError && error.status === status,
		);
		assert.deepEqual(previous, original);
	}
});

test('a deadline failure after issue progress returns the prefix and retains its HTTP failure', async () => {
	const failure = new JiraReadError('Jira read failed (HTTP 429)', 429);
	const result = await scanPoll({
		config: { ...config, resource: 'issue', site: 'example.atlassian.net' },
		state: state(),
		pollStart: 1300,
		source: {
			async *issues() {
				yield issue;
				throw new PollBudgetExhausted('deadline', failure);
			},
			async *comments() {},
		},
	});
	assert.deepEqual(
		result.events.map((event) => event.eventType),
		['issue.created', 'issue.updated'],
	);
	assert.equal(result.stopped, 'deadline');
	assert.equal(result.state.checkpoint, 1000);
	assert.deepEqual(result.state.window.afterIds, ['1']);
});

test('a deadline failure before progress keeps its status in the no-progress error', async () => {
	const failure = new JiraReadError('Jira read failed (HTTP 429)', 429);
	await assert.rejects(
		scanPoll({
			config: { ...config, resource: 'issue', site: 'example.atlassian.net' },
			state: state(),
			pollStart: 1300,
			source: {
				async *issues() {
					throw new PollBudgetExhausted('deadline', failure);
				},
				async *comments() {},
			},
		}),
		(error) => {
			assert(error instanceof JiraReadError);
			assert.equal(error.status, 429);
			assert.match(error.message, /made no progress/);
			return true;
		},
	);
});

test('positioned pagination errors describe the failure without claiming no progress', async () => {
	await assert.rejects(
		scanPoll({
			config: { ...config, resource: 'issue', site: 'example.atlassian.net' },
			state: {
				...state(),
				window: { since: 1000, until: 1200, afterCreated: 1100, afterIds: ['1'] },
			},
			pollStart: 1300,
			source: {
				async *issues() {
					throw new PaginationProgressError('repeated token');
				},
				async *comments() {},
			},
		}),
		(error) => {
			assert.match(error.message, /failed at checkpoint 1000/);
			assert.doesNotMatch(error.message, /made no progress/);
			return true;
		},
	);
});

test('a deadline hands over exact milliseconds and handled IDs, then resumes timestamp ties', async () => {
	const issues = [
		{ ...issue, fields: { created: iso(1101), updated: iso(1101) } },
		{ id: '2', key: 'ALPHA-1', fields: { created: iso(1101), updated: iso(1101) } },
		{ id: '3', key: 'TEST-3', fields: { created: iso(1102), updated: iso(1102) } },
	];
	const options = { config: { ...config, resource: 'issue' }, state: state(), pollStart: 1300 };
	const first = await scanPoll({
		...options,
		source: {
			async *issues() {
				yield issues[0];
				yield issues[1];
				throw new PollBudgetExhausted('deadline');
			},
			async *comments() {},
		},
	});
	assert.equal(first.state.window.afterCreated, 1101);
	assert.deepEqual(first.state.window.afterIds, ['1', '2']);
	assert.deepEqual(
		Object.keys(first.state.window).filter((key) => /Token|Keys|afterId$/.test(key)),
		[],
	);
	const second = await scanPoll({
		...options,
		state: first.state,
		source: {
			async *issues(lower, read) {
				assert.equal(read.afterCreated, 1101);
				assert.equal(read.createdBefore, 1300);
				yield { ...issues[0], key: 'RENAMED-99' };
				yield issues[1];
				yield issues[2];
			},
			async *comments() {},
		},
	});
	assert.deepEqual(
		second.events.map((event) => event.issue.id),
		['3'],
	);
	assert.equal(second.state.checkpoint, 1300);
	assert.equal(second.state.window, undefined);
});

test('a finite page cap saves a prefix and exact cursor until a fake Jira backlog drains', async () => {
	const { JiraTransport } = require('../dist/nodes/JiraPollTrigger/transport');
	const issues = Array.from({ length: 5 }, (_, index) => ({
		id: String(index + 1),
		key: `TEST-${index + 1}`,
		fields: { created: iso(1101 + index), updated: iso(1101 + index) },
	}));
	const requests = [];
	const transport = new JiraTransport(async (request) => {
		requests.push(request);
		const lower = Number(/updated >= (\d+)/.exec(request.body.jql)[1]);
		const upper = Number(/created <= (\d+)/.exec(request.body.jql)[1]);
		const after = Number(/created >= (\d+)/.exec(request.body.jql)?.[1] ?? 0);
		const matching = issues.filter(
			(issue) =>
				Date.parse(issue.fields.updated) >= lower &&
				Date.parse(issue.fields.created) <= upper &&
				Date.parse(issue.fields.created) >= after,
		);
		const offset = Number(request.body.nextPageToken ?? 0);
		return {
			issues: matching.slice(offset, offset + 2),
			...(offset + 2 < matching.length ? { nextPageToken: String(offset + 2) } : {}),
		};
	});
	const source = {
		async *issues(lower, read) {
			yield* transport.searchIssues('', lower, [], { ...read, maxPages: 1 });
		},
		async *comments() {},
	};
	let saved = state();
	const emitted = [];
	for (let index = 0; index < 4; index++) {
		const result = await scanPoll({
			config: { ...config, resource: 'issue' },
			state: saved,
			pollStart: 1300,
			source,
		});
		emitted.push(...result.events.map((event) => event.issue.id));
		saved = result.state;
		if (index < 3) {
			assert.equal(result.stopped, 'page cap');
			assert.equal(saved.checkpoint, 1000);
			assert.equal(saved.window.afterCreated, 1102 + index);
			assert.deepEqual(saved.window.afterIds, [String(2 + index)]);
		} else {
			assert.equal(saved.checkpoint, 1300);
			assert.equal(saved.window, undefined);
		}
	}
	assert.deepEqual(emitted, ['1', '2', '3', '4', '5']);
	assert.equal(requests.length, 4);
	assert(requests.every((request) => request.body.nextPageToken === undefined));
});

test('unknown and older state versions reset to a fresh activation without migration', async () => {
	for (const version of [undefined, 1, 3, '2']) {
		const result = await poll([], { state: { version, seen: null } });
		assert.deepEqual(result.events, []);
		assert.deepEqual(result.state, {
			version: 2,
			fingerprint: 'a',
			activation: 1300,
			checkpoint: 1300,
			seen: [],
		});
	}
});

test('stale polls and corrupt state fail explicitly', async () => {
	await assert.rejects(poll([], { state: { ...state(), checkpoint: 1500 } }), /Stale/);
	await assert.rejects(poll([], { state: { ...state(), seen: null } }), /Invalid saved/);
});

test('an old backlog completes after cache eviction and expires keys by the overlap', async () => {
	const result = await poll([], {
		pollStart: 10000,
		source: {
			async *issues() {
				yield issue;
			},
			async *comments() {
				for (let i = 0; i <= MAX_DEDUP_KEYS; i++) yield comment(1200, 1200, { id: String(i) });
			},
		},
	});
	assert.equal(result.events.length, MAX_DEDUP_KEYS + 1);
	assert.equal(result.state.window, undefined);
	assert.deepEqual(result.state.seen, []);
});

test('public event IDs are readable, tenant-scoped and independent of stored dedup keys', async () => {
	const one = await poll([comment()], { config: { ...config, site: 'one.atlassian.net' } });
	assert.equal(one.events[0].eventId, 'one.atlassian.net/comment/1/2/created/1100');
	assert.equal(one.events[1].eventId, 'one.atlassian.net/comment/1/2/updated/1200');
	const two = await poll([comment()], { config: { ...config, site: 'two.atlassian.net' } });
	assert.notEqual(one.events[0].eventId, two.events[0].eventId);
	assert(
		one.state.seen.some(
			(entry) => entry.key === JSON.stringify(['comment', '1', '2', 'created', 1100]),
		),
	);
	const repeat = await poll([comment()], {
		config: { ...config, site: 'one.atlassian.net' },
		state: one.state,
		pollStart: 1400,
	});
	assert.equal(repeat.events.length, 0);
});

test('manual event limit stops during a combined comment and closes both generators', async () => {
	let issueClosed = false,
		commentClosed = false,
		reads = 0;
	const boundedSource = {
		async *issues() {
			try {
				yield issue;
				throw new Error('unexpected next issue');
			} finally {
				issueClosed = true;
			}
		},
		async *comments() {
			try {
				for (let n = 0; n < 5; n++) {
					reads++;
					yield comment(1100, 1200, { id: String(n) });
				}
			} finally {
				commentClosed = true;
			}
		},
	};
	const before = state(),
		snapshot = structuredClone(before);
	const result = await poll([], {
		state: before,
		source: boundedSource,
		manual: true,
		manualLimit: 3,
	});
	assert.deepEqual(
		result.events.map((event) => event.eventType),
		['comment.created', 'comment.updated', 'comment.created'],
	);
	assert.equal(reads, 2);
	assert.equal(issueClosed, true);
	assert.equal(commentClosed, true);
	assert.equal(result.state, before);
	assert.deepEqual(before, snapshot);
});
test('manual limit allows fewer events when the bounded source is exhausted', async () => {
	const result = await poll([comment()], { manual: true, manualLimit: 10 });
	assert.equal(result.events.length, 2);
});
