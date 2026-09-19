export interface Issue {
	renderedFields?: Record<string, unknown>;
	id: string;
	key: string;
	fields: Record<string, unknown> & { created?: string; updated?: string };
}
export interface Comment {
	id: string;
	created: string;
	updated: string;
	author?: { accountId?: string };
	updateAuthor?: { accountId?: string };
	jsdPublic?: boolean;
	[key: string]: unknown;
}
export interface PollConfig {
	site?: string;
	resource: 'issue' | 'comment';
	event: 'created' | 'updated' | 'createdOrUpdated';
	fingerprint: string;
	overlapMs: number;
	excludedAccountIds: string[];
	publicOnly: boolean;
}
export interface PollState {
	version: 1;
	fingerprint: string;
	activation: number;
	checkpoint: number;
	seen: Array<{ key: string; time: number }>;
}
export interface PollEvent {
	eventType: 'issue.created' | 'issue.updated' | 'comment.created' | 'comment.updated';
	eventId: string;
	eventTime: string;
	issue: Issue;
	comment?: Comment;
}
export interface PollSource {
	issues(updatedSince: number): AsyncIterable<Issue>;
	comments(issue: Issue): AsyncIterable<Comment>;
}
export const MAX_DEDUP_KEYS = 40_000;

function validateState(state: PollState): void {
	if (
		state.version !== 1 ||
		typeof state.fingerprint !== 'string' ||
		!Number.isFinite(state.activation) ||
		!Number.isFinite(state.checkpoint) ||
		state.checkpoint < state.activation ||
		!Array.isArray(state.seen) ||
		state.seen.length > MAX_DEDUP_KEYS ||
		state.seen.some(
			(entry) => !entry || typeof entry.key !== 'string' || !Number.isFinite(entry.time),
		)
	) {
		throw new Error(
			'Invalid saved Jira polling state. Clear the saved polling state before activating this trigger again.',
		);
	}
}

/** Returns replacement state only after every required page has succeeded. */
export async function scanPoll(options: {
	config: PollConfig;
	state?: PollState;
	pollStart: number;
	source: PollSource;
	manual?: boolean;
	manualLimit?: number;
}): Promise<{ events: PollEvent[]; state: PollState | undefined }> {
	const { config, state, pollStart, source, manual = false, manualLimit = 1 } = options;
	if (manual && (!Number.isInteger(manualLimit) || manualLimit < 1 || manualLimit > 100))
		throw new Error('Set test limit to an integer between 1 and 100');
	if (
		!['issue', 'comment'].includes(config.resource) ||
		!['created', 'updated', 'createdOrUpdated'].includes(config.event)
	)
		throw new Error('Invalid Jira polling resource or event.');
	if (
		typeof config.fingerprint !== 'string' ||
		!Array.isArray(config.excludedAccountIds) ||
		config.excludedAccountIds.some((id) => typeof id !== 'string') ||
		typeof config.publicOnly !== 'boolean'
	)
		throw new Error('Invalid Jira polling configuration.');
	if (!Number.isFinite(pollStart) || !Number.isFinite(config.overlapMs) || config.overlapMs < 0)
		throw new Error('Invalid polling time or overlap.');
	if (state) validateState(state);
	if (!manual && (!state || state.fingerprint !== config.fingerprint)) {
		return {
			events: [],
			state: {
				version: 1,
				fingerprint: config.fingerprint,
				activation: pollStart,
				checkpoint: pollStart,
				seen: [],
			},
		};
	}
	if (!manual && state && pollStart < state.checkpoint)
		throw new Error('Stale Jira poll cannot replace a newer checkpoint.');
	const lower = manual ? 0 : Math.max(state!.activation, state!.checkpoint - config.overlapMs);
	const retainFrom = manual ? 0 : Math.max(state!.activation, pollStart - config.overlapMs);
	const seen = new Map(
		(manual ? [] : state!.seen)
			.filter((entry) => entry.time >= lower)
			.map((entry) => [entry.key, entry.time]),
	);
	const retained = new Map([...seen].filter(([, time]) => time >= retainFrom));
	const excluded = new Set(config.excludedAccountIds);
	const events: PollEvent[] = [];
	const consider = (issue: Issue, comment?: Comment): void => {
		if (comment && config.publicOnly && comment.jsdPublic !== true) return;
		const entity = comment ?? issue.fields;
		const created = Date.parse(String(entity.created ?? ''));
		const updated = Date.parse(String(entity.updated ?? ''));
		if (!Number.isFinite(created) || !Number.isFinite(updated))
			throw new Error('Jira returned an invalid created or updated timestamp.');
		for (const kind of ['created', 'updated'] as const) {
			if (config.event !== 'createdOrUpdated' && config.event !== kind) continue;
			const time = kind === 'created' ? created : updated;
			if (kind === 'updated' && updated <= created) continue;
			if (time < lower || time > pollStart) continue;
			const actor = kind === 'created' ? comment?.author : comment?.updateAuthor;
			if (actor?.accountId && excluded.has(actor.accountId)) continue;
			const eventType = `${config.resource}.${kind}` as PollEvent['eventType'];
			const key = JSON.stringify([config.resource, issue.id, comment?.id ?? issue.id, kind, time]);
			if (seen.has(key)) continue;
			seen.set(key, time);
			if (time >= retainFrom) retained.set(key, time);
			if (!manual && seen.size > MAX_DEDUP_KEYS)
				throw new Error(
					'Jira polling deduplication exceeded 40,000 events. Checkpoint unchanged. Narrowing JQL resets from now and abandons the backlog.',
				);
			events.push({
				eventType,
				eventId: [
					config.site ?? 'jira',
					config.resource,
					issue.id,
					...(comment ? [comment.id] : []),
					kind,
					String(time),
				]
					.map(encodeURIComponent)
					.join('/'),
				eventTime: new Date(time).toISOString(),
				issue,
				...(comment ? { comment } : {}),
			});
			if (manual && events.length >= manualLimit) return;
		}
	};
	for await (const issue of source.issues(lower)) {
		if (config.resource === 'issue') consider(issue);
		else {
			for await (const comment of source.comments(issue)) {
				consider(issue, comment);
				if (manual && events.length >= manualLimit) return { events, state };
			}
		}
		if (manual && events.length >= manualLimit) return { events, state };
	}
	return {
		events,
		state: manual
			? state
			: {
					version: 1,
					fingerprint: config.fingerprint,
					activation: state!.activation,
					checkpoint: pollStart,
					seen: [...retained].map(([key, time]) => ({ key, time })),
				},
	};
}

const polls = new Map<string, Promise<unknown>>();
/** Serializes polls within this process. Cross-process exclusion belongs to n8n. */
export async function serializePoll<T>(key: string, run: () => Promise<T>): Promise<T> {
	const previous = polls.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(run);
	polls.set(key, current);
	try {
		return await current;
	} finally {
		if (polls.get(key) === current) polls.delete(key);
	}
}
