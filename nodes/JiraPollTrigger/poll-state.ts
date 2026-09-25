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
/**
 * A window the poll budget interrupted. Its events lie in [since, until] and
 * its issues were created by `until`, a bound no edit can move, so the scan is
 * finite. It runs in immutable creation-time order and resumes at a minute
 * boundary while excluding issue keys already handled at that position.
 */
export interface PollWindow {
	since: number;
	until: number;
	/** Legacy cursor retained while older saved state is upgraded. */
	afterId?: string;
	/** Creation time rounded down to Jira's one-minute JQL precision. */
	afterCreated?: number;
	/** Issue keys already processed at afterCreated. */
	afterKeys?: string[];
	/**
	 * Issue whose comments are outstanding: its search payload, the first unread
	 * offset, the comment before that offset, and whether it was finished ahead
	 * of the search. It stays until the search passes that exact issue.
	 */
	partial?: { issue: Issue; startAt: number; lastCommentId: string; done: boolean };
}
export interface PollState {
	version: 1;
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
	/** Resume at this creation minute, excluding keys already handled there. */
	afterCreated?: number;
	afterKeys?: string[];
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
	constructor(
		public readonly reason: string,
		public readonly status?: number,
		public readonly details?: string,
		public readonly code?: unknown,
		public readonly timedOut = false,
	) {
		super(`Jira poll budget exhausted: ${reason}.`);
	}
}

const issueIdPattern = /^\d{1,15}$/;

function validateState(state: PollState): void {
	const { window } = state;
	if (
		state.version !== 1 ||
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
				(window.afterId !== undefined && !issueIdPattern.test(String(window.afterId))) ||
				(window.afterCreated !== undefined &&
					(!Number.isSafeInteger(window.afterCreated) || window.afterCreated < 0)) ||
				(window.afterKeys !== undefined &&
					(!Array.isArray(window.afterKeys) ||
						window.afterKeys.length < 1 ||
						window.afterKeys.length > MAX_DEDUP_KEYS ||
						window.afterKeys.some((key) => typeof key !== 'string'))) ||
				((window.afterCreated === undefined) !== (window.afterKeys === undefined)) ||
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
	/** The host enforces a poll budget; without one the key cap fails the poll as it always did. */
	budgeted?: boolean;
}
export interface ScanResult {
	events: PollEvent[];
	state: PollState | undefined;
	stopped?: string;
	stopError?: JiraReadError;
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
			if (!advanced)
				throw noProgressError(config, current!, result, result.stopped);
			return {
				events,
				state: current,
				stopped: result.stopped,
				stopError: result.stopError,
				dropped,
			};
		}
		if (current.checkpoint >= pollStart) return { events, state: current, dropped };
	}
}

/** Scans the open window, or opens one through the current poll boundary. */
async function scanWindow(
	options: ScanOptions & { state: PollState | undefined },
): Promise<ScanResult & { state: PollState; advanced: boolean }> {
	const {
		config,
		state,
		pollStart,
		source,
		manual = false,
		manualLimit = 1,
		budgeted = false,
	} = options;
	// An interrupted window is finished before a new one opens. A new window
	// spans the full gap, so old issues are searched once rather than once per
	// fixed-size slice. The overlap catches updates that were indexed late.
	const since = manual ? 0 : Math.max(state!.activation, state!.checkpoint - config.overlapMs);
	const window: PollWindow = manual
		? { since, until: pollStart }
		: (state!.window ?? { since, until: pollStart });
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
			const eventType = `${config.resource}.${kind}` as PollEvent['eventType'];
			const key = JSON.stringify([config.resource, issue.id, comment?.id ?? issue.id, kind, time]);
			if (seen.has(key)) continue;
			// Under a budget the key cap stops the scan like a spent budget, so a
			// backlog drains across polls; keys retire as windows close. Without a
			// budget the poll fails as it always did.
			if (!manual && seen.size >= MAX_DEDUP_KEYS) {
				if (budgeted) throw new PollBudgetExhausted('deduplication keys reached the 40,000 limit');
				throw new Error(
					'Jira polling deduplication exceeded 40,000 events. Checkpoint unchanged. Narrowing JQL resets from now and abandons the backlog.',
				);
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
	let afterKeys = window.afterKeys ? [...window.afterKeys] : undefined;
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
		if (!Number.isFinite(created)) throw new Error('Jira returned an invalid issue creation timestamp.');
		const minute = Math.floor(created / 60_000) * 60_000;
		if (afterCreated === minute) {
			if (!afterKeys?.includes(issue.key)) afterKeys = [...(afterKeys ?? []), issue.key];
		} else {
			afterCreated = minute;
			afterKeys = [issue.key];
		}
	};
	const dropMissingIssue = (issue: Issue): void => {
		dropped = issue.id;
		droppedIssues.set(issue.id, { id: issue.id, through: upper + config.overlapMs });
		advancePosition(issue);
		partial = undefined;
		current = undefined;
		activeIssueId = undefined;
	};
	let stopError: JiraReadError | undefined;
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
			manual ? undefined : { afterCreated, afterKeys, createdBefore: upper },
		)) {
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
					if (await readComments(issue))
						return { events, state: state as PollState, advanced: true };
				} catch (error) {
					const gone = error instanceof JiraReadError && error.issueMissing;
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					if (!gone) throw error;
					dropMissingIssue(issue);
				}
			}
			if (manual && events.length >= manualLimit)
				return { events, state: state as PollState, advanced: true };
			advancePosition(issue);
			activeIssueId = undefined;
		}
	} catch (error) {
		// Budget stops and exhausted transient reads hand over the processed prefix.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		if (manual) throw error;
		if (error instanceof PollBudgetExhausted) {
			stopped = error.reason;
			if (error.status !== undefined || error.timedOut)
				stopError = new JiraReadError(error.message, error.status, {
					details: error.details,
					code: error.code,
					transient: true,
					timedOut: error.timedOut,
				});
			} else if (budgeted && error instanceof JiraReadError && (error.transient || error.timedOut)) {
			stopped = error.message;
			stopError = error;
		} else if (isPaginationProgressError(error)) {
			throw positionedError(error, config, state!, lower, upper);
		} else {
			// Let the node entry point preserve JiraReadError status and details.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw error;
		}
	}
	if (manual) return { events, state: state as PollState, advanced: true };
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
		advanced =
			events.length > 0 ||
			afterCreated !== window.afterCreated ||
			JSON.stringify(afterKeys ?? []) !== JSON.stringify(window.afterKeys ?? []) ||
			mark(partial) !== mark(window.partial);
	}
	// Keys retire with their window; the partial issue stays covered if its
	// comment page is re-read after a budget stop.
	const keepIssue =
		stopped !== undefined ? (partial?.issue.id ?? activeIssueId ?? current?.issue.id) : undefined;
	const priorKeys = new Set(
		(manual ? [] : state!.seen)
			.filter((entry) => entry.time >= lower)
			.map((entry) => entry.key),
	);
	const retained = [...seen].filter(([key, time]) =>
		stopped !== undefined
			? priorKeys.has(key) || time >= retainFrom || issueOf(key) === keepIssue
			: time >= retainFrom,
	);
	return {
		events,
		stopped,
		stopError,
		dropped,
		advanced,
		state: {
			version: 1,
			fingerprint: config.fingerprint,
			activation: state!.activation,
			checkpoint: stopped !== undefined ? state!.checkpoint : upper,
			...(stopped !== undefined
				? { window: { since: lower, until: upper, afterCreated, afterKeys, partial } }
				: {}),
			seen: retained.map(([key, time]) => ({ key, time })),
			...(droppedIssues.size ? { droppedIssues: [...droppedIssues.values()] } : {}),
		},
	};
}

function noProgressError(
	config: PollConfig,
	state: PollState,
	result: ScanResult & { state: PollState },
	reason: string,
): Error {
	const window = result.state.window;
	const position = window ? `window [${window.since}, ${window.until}]` : 'no open window';
	const prefix = `Jira ${config.resource} poll for ${config.site ?? 'the configured site'} made no progress at checkpoint ${state.checkpoint}, ${position}`;
	if (result.stopError instanceof JiraReadError)
		return new JiraReadError(`${prefix}: ${reason}`, result.stopError.status, {
			details: result.stopError.details,
			code: result.stopError.code,
			transient: result.stopError.transient,
			timedOut: result.stopError.timedOut,
		});
	return new Error(`${prefix}: ${reason}. Check Jira availability and the poll interval.`);
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
	return new Error(
		`Jira ${config.resource} poll for ${config.site ?? 'the configured site'} made no progress at checkpoint ${state.checkpoint}, window [${lower}, ${upper}]: ${message}`,
	);
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
