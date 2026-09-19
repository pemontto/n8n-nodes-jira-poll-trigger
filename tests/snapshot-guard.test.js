const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	checkSnapshot,
	recordReplacement,
} = require('../dist/nodes/JiraPollTrigger/snapshot-guard');
test('guard rejects discarded and stale snapshots including configuration changes', () => {
	const state = { version: 1, fingerprint: 'one', activation: 1, checkpoint: 2, seen: [] };
	checkSnapshot('guard-test', undefined);
	recordReplacement('guard-test', state);
	assert.doesNotThrow(() => checkSnapshot('guard-test', JSON.parse(JSON.stringify(state))));
	assert.throws(() => checkSnapshot('guard-test', undefined), /stale or uncommitted/);
	assert.throws(
		() => checkSnapshot('guard-test', { ...state, checkpoint: 1 }),
		/stale or uncommitted/,
	);
	assert.throws(
		() => checkSnapshot('guard-test', { ...state, fingerprint: 'old' }),
		/stale or uncommitted/,
	);
});
test('equivalent restored state can reorder object keys and dedup entries', () => {
	const state = {
		version: 1,
		fingerprint: 'one',
		activation: 1,
		checkpoint: 2,
		seen: [
			{ key: 'b', time: 2 },
			{ key: 'a', time: 1 },
		],
	};
	recordReplacement('canonical-test', state);
	assert.doesNotThrow(() =>
		checkSnapshot('canonical-test', {
			seen: [
				{ time: 1, key: 'a' },
				{ time: 2, key: 'b' },
			],
			checkpoint: 2,
			activation: 1,
			fingerprint: 'one',
			version: 1,
		}),
	);
});
