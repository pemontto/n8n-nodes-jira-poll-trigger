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
 * finite. It runs in issue ID order and continues after the last fully
 * processed issue; nothing depends on timestamps Jira may change between pages.
 */
export interface PollWindow {
	since: number;
	until: number;
	/** Last fully processed issue ID. The scan continues with `id > afterId`. */
	afterId?: string;
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
}
export interface PollEvent {
	eventType: 'issue.created' | 'issue.updated' | 'comment.created' | 'comment.updated';
	eventId: string;
	eventTime: string;
	issue: Issue;
	comment?: Comment;
}
export interface SearchReadOptions {
	/** Return only issues whose numeric ID is greater than this. */
	afterId?: string;
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

/** A Jira read that failed for good; `status` is the HTTP status when there was one. */
export class JiraReadError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
	}
}

/** Stops a scan with its progress kept: the budget cannot fit the next step. */
export class PollBudgetExhausted extends Error {
	constructor(public readonly reason: string) {
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
		state.seen.some(
			(entry) => !entry || typeof entry.key !== 'string' || !Number.isFinite(entry.time),
		)
	) {
		throw new Error(
			'Invalid saved Jira polling state. Clear the saved polling state before activating this trigger again.',
		);
	}
}

/** Longest time span one window covers, so delivery stays in time order at this granularity. */
export const WINDOW_SPAN_MS = 15 * 60_000;

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
				throw new Error(
					`Jira poll stopped before reading anything new (${result.stopped}). Checkpoint unchanged; check Jira rate limits and the poll interval.`,
				);
			return { events, state: current, stopped: result.stopped, dropped };
		}
		if (current.checkpoint >= pollStart) return { events, state: current, dropped };
	}
}

/** Scans the open window, or opens the next one, in issue ID order. */
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
	// An interrupted window is finished before a new one opens, and a new one
	// spans at most WINDOW_SPAN_MS, so delivery stays in time order at that
	// granularity. It starts an overlap before the last checkpoint to catch
	// updates that were indexed late, and always reaches past that checkpoint.
	const since = manual ? 0 : Math.max(state!.activation, state!.checkpoint - config.overlapMs);
	const span = Math.max(WINDOW_SPAN_MS, 2 * config.overlapMs);
	const window: PollWindow = manual
		? { since, until: pollStart }
		: (state!.window ?? { since, until: Math.min(pollStart, since + span) });
	const lower = window.since;
	const upper = window.until;
	const retainFrom = manual ? 0 : Math.max(state!.activation, upper - config.overlapMs);
	const seen = new Map(
		(manual ? [] : state!.seen)
			.filter((entry) => entry.time >= lower)
			.map((entry) => [entry.key, entry.time]),
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
	let afterId = window.afterId;
	let partial = window.partial;
	let current: { issue: Issue; next: number; last: string } | undefined;
	let stopped: string | undefined;
	let dropped: string | undefined;
	/** Reads an issue's comments; returns true when the manual limit is reached. */
	const readComments = async (
		issue: Issue,
		resume?: { startAt: number; lastCommentId: string },
	): Promise<boolean> => {
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
		return false;
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
				const gone = error instanceof JiraReadError && [403, 404].includes(error.status ?? 0);
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				if (!gone) throw error;
				dropped = partial.issue.id;
				partial = undefined;
				current = undefined;
			}
		}
		for await (const issue of source.issues(
			lower,
			manual ? undefined : { afterId, createdBefore: upper },
		)) {
			if (partial?.issue.id === issue.id) {
				// Already finished ahead of the search; its keys can retire now.
				partial = undefined;
			} else if (config.resource === 'issue') consider(issue);
			else if (await readComments(issue))
				return { events, state: state as PollState, advanced: true };
			if (manual && events.length >= manualLimit)
				return { events, state: state as PollState, advanced: true };
			afterId = issue.id;
		}
	} catch (error) {
		// Budget stops hand over the processed prefix; every other failure propagates
		// and the node entry point wraps it as NodeOperationError.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		if (manual || !(error instanceof PollBudgetExhausted)) throw error;
		stopped = error.reason;
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
			events.length > 0 || afterId !== window.afterId || mark(partial) !== mark(window.partial);
	}
	// Keys retire with their window: the overlap the next window rescans is kept,
	// and while a window is open so are the keys of issues its search has not
	// passed yet, which bounds them by the overlap's density.
	const keepIssue = stopped !== undefined ? partial?.issue.id : undefined;
	const pending = (id: string | undefined) =>
		stopped !== undefined &&
		id !== undefined &&
		(afterId === undefined || Number(id) > Number(afterId) || id === keepIssue);
	const retained = [...seen].filter(([key, time]) => time >= retainFrom || pending(issueOf(key)));
	return {
		events,
		stopped,
		dropped,
		advanced,
		state: {
			version: 1,
			fingerprint: config.fingerprint,
			activation: state!.activation,
			checkpoint: stopped !== undefined ? state!.checkpoint : upper,
			...(stopped !== undefined
				? { window: { since: lower, until: upper, afterId, partial } }
				: {}),
			seen: retained.map(([key, time]) => ({ key, time })),
		},
	};
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
