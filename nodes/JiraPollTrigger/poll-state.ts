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

/** A fixed window resumed at an immutable creation timestamp and handled issue IDs. */
export interface PollWindow {
	since: number;
	until: number;
	/** Exact epoch millisecond creation cursor. */
	afterCreated?: number;
	/** Issue IDs already processed at afterCreated. Never evicted. */
	afterIds?: string[];
	/**
	 * Issue whose comments are outstanding: its search payload, the first unread
	 * offset, the comment before that offset, and whether it was finished ahead
	 * of the search. It stays until the search passes that exact issue.
	 */
	partial?: { issue: Issue; startAt: number; lastCommentId: string; done: boolean };
}

export interface PollState {
	version: 2;
	fingerprint: string;
	activation: number;
	/** Upper bound of the last completed window. */
	checkpoint: number;
	window?: PollWindow;
	seen: Array<{ key: string; time: number }>;
	/** Confirmed missing issues are skipped while their search results may overlap. */
	droppedIssues?: Array<{ id: string; through: number }>;
}

export interface PollEvent {
	eventType: 'issue.created' | 'issue.updated' | 'comment.created' | 'comment.updated';
	eventId: string;
	eventTime: string;
	issue: Issue;
	comment?: Comment;
}

export interface SearchReadOptions {
	/** Resume at this exact creation timestamp; handled IDs are skipped by the scanner. */
	afterCreated?: number;
	/** Return only issues created at or before this epoch millisecond. */
	createdBefore?: number;
}

export interface CommentReadOptions {
	/** First unread comment offset. */
	resumeAt?: number;
	/** ID of the comment just before `resumeAt`; a mismatch restarts the read from the beginning. */
	resumeAfter?: string;
	/** Called after each page with the offset of the first unread comment and the ID before it. */
	progress?: (nextStartAt: number, lastCommentId: string) => void;
}

export interface PollSource {
	issues(updatedSince: number, options?: SearchReadOptions): AsyncIterable<Issue>;
	comments(issue: Issue, options?: CommentReadOptions): AsyncIterable<Comment>;
}

export const MAX_DEDUP_KEYS = 40_000;

/** A Jira read failure with its HTTP and retry identity preserved. */
export class JiraReadError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		options: {
			details?: string;
			code?: unknown;
			transient?: boolean;
			timedOut?: boolean;
			issueMissing?: boolean;
		} = {},
	) {
		super(message);
		this.details = options.details;
		this.code = options.code;
		this.transient = options.transient ?? false;
		this.timedOut = options.timedOut ?? false;
		this.issueMissing = options.issueMissing ?? false;
	}
	public readonly details?: string;
	public readonly code?: unknown;
	public readonly transient: boolean;
	public readonly timedOut: boolean;
	public readonly issueMissing: boolean;
}

/** Stops a scan with its progress kept: the budget cannot fit the next step. */
export class PollBudgetExhausted extends Error {
	constructor(public readonly reason: string) {
		super(`Jira poll budget exhausted: ${reason}.`);
	}
}

function validateState(state: PollState): void {
	const { window } = state;

	if (
		state.version !== 2 ||
		typeof state.fingerprint !== 'string' ||
		!Number.isFinite(state.activation) ||
		!Number.isFinite(state.checkpoint) ||
		state.checkpoint < state.activation ||
		(window !== undefined &&
			(!window ||
				!Number.isFinite(window.since) ||
				!Number.isFinite(window.until) ||
				window.since < state.activation ||
				window.until < window.since ||
				(window.afterCreated !== undefined &&
					(!Number.isSafeInteger(window.afterCreated) || window.afterCreated < 0)) ||
				(window.afterIds !== undefined &&
					(!Array.isArray(window.afterIds) ||
						window.afterIds.length < 1 ||
						window.afterIds.length > MAX_DEDUP_KEYS ||
						window.afterIds.some((id) => typeof id !== 'string'))) ||
				(window.afterCreated === undefined) !== (window.afterIds === undefined) ||
				(window.partial !== undefined &&
					(!window.partial ||
						!window.partial.issue ||
						typeof window.partial.issue.id !== 'string' ||
						typeof window.partial.lastCommentId !== 'string' ||
						typeof window.partial.done !== 'boolean' ||
						!Number.isSafeInteger(window.partial.startAt) ||
						window.partial.startAt < 0)))) ||
		!Array.isArray(state.seen) ||
		state.seen.length > MAX_DEDUP_KEYS ||
		(state.droppedIssues !== undefined &&
			(!Array.isArray(state.droppedIssues) ||
				state.droppedIssues.length > MAX_DEDUP_KEYS ||
				state.droppedIssues.some(
					(entry) => !entry || typeof entry.id !== 'string' || !Number.isFinite(entry.through),
				))) ||
		state.seen.some(
			(entry) => !entry || typeof entry.key !== 'string' || !Number.isFinite(entry.time),
		)
	) {
		throw new Error(
			'Invalid saved Jira polling state. Clear the saved polling state before activating this trigger again.',
		);
	}
}

export interface ScanOptions {
	config: PollConfig;
	state?: PollState;
	pollStart: number;
	source: PollSource;
	manual?: boolean;
	manualLimit?: number;
	/** Reports bounded recent-key eviction to the host logger. */
	warn?: (message: string) => void;
}

export interface ScanResult {
	events: PollEvent[];
	state: PollState | undefined;
	stopped?: string;
	/** ID of a partly read issue that was dropped because Jira no longer serves it. */
	dropped?: string;
}

/**
 * Scans windows in time order until the present or the budget is reached. A
 * complete window checkpoints at its upper bound; a window the budget stops
 * early returns what it processed and saves where to continue.
 */
export async function scanPoll(options: ScanOptions): Promise<ScanResult> {
	const { config, state, pollStart, manual = false, manualLimit = 1 } = options;

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

	if (state?.version === 2) validateState(state);

	if (!manual && (!state || state.version !== 2 || state.fingerprint !== config.fingerprint)) {
		return {
			events: [],
			state: {
				version: 2,
				fingerprint: config.fingerprint,
				activation: pollStart,
				checkpoint: pollStart,
				seen: [],
			},
		};
	}

	if (
		!manual &&
		state &&
		(pollStart < state.checkpoint || (state.window && pollStart < state.window.until))
	)
		throw new Error('Stale Jira poll cannot replace a newer checkpoint.');
	const events: PollEvent[] = [];
	let current = state;
	let advanced = false;
	let dropped: string | undefined;

	for (;;) {
		const result = await scanWindow({ ...options, state: current });
		events.push(...result.events);

		if (manual) return { events, state };
		current = result.state;
		advanced ||= result.advanced;
		dropped ??= result.dropped;

		if (result.stopped !== undefined) {
			if (!advanced) throw noProgressError(config, current!, result, result.stopped);

			return {
				events,
				state: current,
				stopped: result.stopped,
				dropped,
			};
		}

		// Scheduled scans return a state; manual scans returned above.
		if (current!.checkpoint >= pollStart) return { events, state: current, dropped };
	}
}

/** Scans the open window, or opens one through the current poll boundary. */
async function scanWindow(
	options: ScanOptions & { state: PollState | undefined },
): Promise<ScanResult & { advanced: boolean }> {
	const { config, state, pollStart, source, manual = false, manualLimit = 1, warn } = options;

	// An interrupted window is finished before a new one opens. Both host types
	// scan one interval within the host deadline.
	const since = manual ? 0 : Math.max(state!.activation, state!.checkpoint - config.overlapMs);
	const until = pollStart;

	const window: PollWindow = manual
		? { since, until: pollStart }
		: (state!.window ?? { since, until });

	const lower = window.since;
	const upper = window.until;
	const retainFrom = manual ? 0 : Math.max(state!.activation, upper - config.overlapMs);

	const seen = new Map(
		(manual ? [] : state!.seen)
			.filter((entry) => entry.time >= lower)
			.map((entry) => [entry.key, entry.time]),
	);

	const droppedIssues = new Map(
		(manual ? [] : (state!.droppedIssues ?? []))
			.filter((entry) => entry.through >= lower)
			.map((entry) => [entry.id, entry]),
	);

	const excluded = new Set(config.excludedAccountIds);
	const events: PollEvent[] = [];
	let evictionWarned = false;

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

			if (time < lower || time > upper) continue;
			const actor = kind === 'created' ? comment?.author : comment?.updateAuthor;

			if (actor?.accountId && excluded.has(actor.accountId)) continue;
			const eventType: PollEvent['eventType'] = `${config.resource}.${kind}`;
			const key = JSON.stringify([config.resource, issue.id, comment?.id ?? issue.id, kind, time]);

			if (seen.has(key)) continue;

			if (!manual && seen.size >= MAX_DEDUP_KEYS) {
				const oldest = seen.keys().next().value;

				if (oldest !== undefined) seen.delete(oldest);

				if (!evictionWarned) {
					warn?.(
						'Jira recent-event cache reached 40,000 keys; oldest keys were evicted and overlap events may repeat.',
					);
					evictionWarned = true;
				}
			}

			seen.set(key, time);
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

	let afterCreated = window.afterCreated;
	let afterIds = window.afterIds ? [...window.afterIds] : undefined;

	let partial = window.partial;
	let activeIssueId: string | undefined;
	let current: { issue: Issue; next: number; last: string } | undefined;
	let stopped: string | undefined;
	let dropped: string | undefined;

	/** Reads an issue's comments; returns true when the manual limit is reached. */
	const readComments = async (
		issue: Issue,
		resume?: { startAt: number; lastCommentId: string },
	): Promise<boolean> => {
		activeIssueId = issue.id;
		current = { issue, next: resume?.startAt ?? 0, last: resume?.lastCommentId ?? '' };

		const read: CommentReadOptions = {
			resumeAt: resume?.startAt,
			resumeAfter: resume?.lastCommentId,
			progress: (next, last) => {
				if (current) current = { ...current, next, last };
			},
		};

		for await (const comment of source.comments(issue, manual ? undefined : read)) {
			// Comments arrive in creation order: from the first one created after
			// the window, every later one is newer too, so the read is finite.
			if (!manual && Date.parse(String(comment.created)) > upper) break;
			consider(issue, comment);

			if (manual && events.length >= manualLimit) return true;
		}

		current = undefined;
		activeIssueId = undefined;

		return false;
	};

	const advancePosition = (issue: Issue): void => {
		const created = Date.parse(String(issue.fields.created ?? ''));

		if (!Number.isFinite(created))
			throw new Error('Jira returned an invalid issue creation timestamp.');

		if (afterCreated === created) {
			if (!afterIds?.includes(issue.id)) {
				if (afterIds!.length >= MAX_DEDUP_KEYS)
					throw new Error(
						'Jira creation cursor exceeded 40,000 issues at one timestamp. Narrow the JQL.',
					);
				afterIds = [...(afterIds ?? []), issue.id];
			}
		} else {
			afterCreated = created;
			afterIds = [issue.id];
		}
	};

	const alreadyHandled = (issue: Issue): boolean => {
		if (afterCreated === undefined) return false;
		const created = Date.parse(String(issue.fields.created ?? ''));

		if (!Number.isFinite(created))
			throw new Error('Jira returned an invalid issue creation timestamp.');

		return (
			created < afterCreated || (created === afterCreated && Boolean(afterIds?.includes(issue.id)))
		);
	};

	const dropMissingIssue = (issue: Issue): void => {
		dropped = issue.id;
		droppedIssues.set(issue.id, { id: issue.id, through: upper + config.overlapMs });
		advancePosition(issue);
		partial = undefined;
		current = undefined;
		activeIssueId = undefined;
	};

	try {
		// Finish the outstanding issue before searching: the search that found it
		// may not fit in the budget alongside its comments.
		if (partial && !partial.done) {
			try {
				await readComments(partial.issue, partial);
				partial = { ...partial, done: true };
			} catch (error) {
				// A deleted or hidden issue cannot be finished; drop it rather than
				// block every other issue behind it.
				const gone = error instanceof JiraReadError && error.issueMissing;

				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				if (!gone) throw error;
				dropMissingIssue(partial.issue);
			}
		}

		for await (const issue of source.issues(
			lower,
			manual ? undefined : { afterCreated, createdBefore: upper },
		)) {
			if (!manual && alreadyHandled(issue)) continue;

			if (!manual && droppedIssues.has(issue.id)) {
				advancePosition(issue);
				continue;
			}

			if (partial?.issue.id === issue.id) {
				// Already finished ahead of the search; its keys can retire now.
				partial = undefined;
			} else if (config.resource === 'issue') {
				activeIssueId = issue.id;
				consider(issue);
				activeIssueId = undefined;
			} else {
				try {
					if (await readComments(issue)) return { events, state, advanced: true };
				} catch (error) {
					const gone = error instanceof JiraReadError && error.issueMissing;

					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					if (!gone) throw error;
					dropMissingIssue(issue);
				}
			}

			if (manual && events.length >= manualLimit) return { events, state, advanced: true };
			advancePosition(issue);
			activeIssueId = undefined;
		}
	} catch (error) {
		// Only our deadline or page cap can hand over a completed prefix.
		if (error instanceof PollBudgetExhausted) {
			if (manual) return { events, state, advanced: true };
			stopped = error.reason;
		} else if (manual) {
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw error;
		} else if (error instanceof JiraReadError && state?.window !== undefined) {
			throw positionedError(error, config, state, lower, upper);
		} else if (isPaginationProgressError(error)) {
			throw positionedError(error, config, state!, lower, upper);
		} else {
			// Let the node entry point preserve JiraReadError status and details.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw error;
		}
	}

	if (manual) return { events, state, advanced: true };
	let advanced = true;

	if (stopped !== undefined) {
		if (current)
			partial = {
				issue: withoutComments(current.issue),
				startAt: current.next,
				lastCommentId: current.last,
				done: false,
			};

		const mark = (value: PollWindow['partial']) =>
			value ? [value.issue.id, value.startAt, value.lastCommentId, value.done].join('/') : '';

		const positionAdvanced =
			afterCreated !== window.afterCreated ||
			JSON.stringify(afterIds ?? []) !== JSON.stringify(window.afterIds ?? []);

		advanced = events.length > 0 || positionAdvanced || mark(partial) !== mark(window.partial);
	}

	// During a stopped window, the issue cursor excludes completed issues. Keep
	// recent overlap keys for the next window and all keys for a partial issue.
	const keepIssue =
		stopped !== undefined ? (partial?.issue.id ?? activeIssueId ?? current?.issue.id) : undefined;

	const priorKeys = new Set(
		(manual ? [] : state!.seen).filter((entry) => entry.time >= lower).map((entry) => entry.key),
	);

	const retained = [...seen].filter(([key, time]) =>
		stopped !== undefined
			? priorKeys.has(key) || time >= retainFrom || issueOf(key) === keepIssue
			: time >= retainFrom,
	);

	return {
		events,
		stopped,
		dropped,
		advanced,
		state: {
			version: 2,
			fingerprint: config.fingerprint,
			activation: state!.activation,
			checkpoint: stopped !== undefined ? state!.checkpoint : upper,
			...(stopped !== undefined
				? {
						window: {
							since: lower,
							until: upper,
							afterCreated,
							afterIds,
							partial,
						},
					}
				: {}),
			seen: retained.map(([key, time]) => ({ key, time })),
			...(droppedIssues.size ? { droppedIssues: [...droppedIssues.values()] } : {}),
		},
	};
}

function noProgressError(
	config: PollConfig,
	state: PollState,
	result: ScanResult,
	reason: string,
): Error {
	// Only scheduled scans call this helper, and they always return a state.
	const window = result.state!.window;

	const position = window
		? `window [${window.since}, ${window.until}], creation cursor ${window.afterCreated ?? 'start'}`
		: 'no open window';

	const prefix = `Jira ${config.resource} poll for ${config.site ?? 'the configured site'} made no progress at checkpoint ${state.checkpoint}, ${position}`;

	return new Error(`${prefix}: ${reason}. Increase the poll budget or narrow the JQL.`);
}

function isPaginationProgressError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(/pagination (?:did not advance|repeated)/i.test(error.message) ||
			/repeated (?:an issue|a comment) across pages/i.test(error.message))
	);
}

function positionedError(
	error: unknown,
	config: PollConfig,
	state: PollState,
	lower: number,
	upper: number,
): Error {
	const message =
		error instanceof Error ? error.message : 'Jira pagination failed without an error message';

	const positioned = `Jira ${config.resource} poll for ${config.site ?? 'the configured site'} made no progress at checkpoint ${state.checkpoint}, window [${lower}, ${upper}]: ${message}`;

	if (error instanceof JiraReadError)
		return new JiraReadError(positioned, error.status, {
			details: error.details,
			code: error.code,
			transient: error.transient,
			timedOut: error.timedOut,
			issueMissing: error.issueMissing,
		});

	return new Error(positioned);
}

/** Embedded comments are re-read on resume, so the saved payload leaves them out. */
function withoutComments(issue: Issue): Issue {
	const { comment, ...fields } = issue.fields;
	void comment;

	return { ...issue, fields };
}

function issueOf(key: string): string | undefined {
	try {
		const parts: unknown = JSON.parse(key);

		return Array.isArray(parts) && typeof parts[1] === 'string' ? parts[1] : undefined;
	} catch {
		return undefined;
	}
}
