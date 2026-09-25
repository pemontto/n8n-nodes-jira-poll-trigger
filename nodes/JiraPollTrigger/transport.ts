import { createHash } from 'node:crypto';
import { sleep } from 'n8n-workflow';
import {
	JiraReadError,
	PollBudgetExhausted,
	type Issue,
	type Comment,
	type CommentReadOptions,
	type SearchReadOptions,
} from './poll-state';

export type JsonRecord = Record<string, unknown>;
export interface ReadRequest {
	method: 'GET' | 'POST';
	path: string;
	qs?: Record<string, string | number>;
	body?: JsonRecord;
	/** Milliseconds; capped to the remaining poll budget. */
	timeout: number;
}
export type Read = (request: ReadRequest) => Promise<unknown>;
export interface PageLimits {
	maxPages?: number;
}
export interface SearchOptions extends PageLimits, SearchReadOptions {
	direction?: 'ASC' | 'DESC';
	/** Also request the `comment` field so most issues need no comment request. */
	withComments?: boolean;
}
export interface TransportOptions {
	apiVersion?: 2 | 3;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	/** Epoch ms. No request or retry wait starts once it has passed. */
	deadline?: number;
}
export const REQUEST_TIMEOUT_MS = 30_000;

/** Request timeout capped strictly to the time left; past the deadline it stops the scan. */
export function requestTimeout(deadline: number | undefined, now = Date.now()): number {
	if (deadline === undefined) return REQUEST_TIMEOUT_MS;
	const remaining = deadline - now;
	// scanPoll handles this error; the node wraps everything else.
	if (remaining <= 0) throw new PollBudgetExhausted('deadline');
	return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep quoted strings intact while checking the top-level predicate. */
export function buildPollingJql(
	predicate: string,
	lowerBound: number,
	direction: 'ASC' | 'DESC' = 'ASC',
	afterCreated?: number,
	createdBefore?: number,
): string {
	if (
		!Number.isSafeInteger(lowerBound) ||
		lowerBound < 0 ||
		(createdBefore !== undefined && (!Number.isSafeInteger(createdBefore) || createdBefore < 0))
	)
		throw new Error('Invalid polling boundary.');
	if (afterCreated !== undefined && (!Number.isSafeInteger(afterCreated) || afterCreated < 0))
		throw new Error('Invalid polling continuation.');
	let quote = '';
	let depth = 0;
	let visible = '';
	for (let i = 0; i < predicate.length; i++) {
		const character = predicate[i];
		if (quote) {
			if (character === '\\') i++;
			else if (character === quote) quote = '';
			visible += ' ';
		} else if (character === '"' || character === "'") {
			quote = character;
			visible += ' ';
		} else if (character === '(') {
			depth++;
			visible += ' ';
		} else if (character === ')') {
			if (--depth < 0) throw new Error('JQL contains unbalanced parentheses.');
			visible += ' ';
		} else visible += depth === 0 ? character : ' ';
	}
	if (quote || depth) throw new Error('JQL contains an unclosed quote or parenthesis.');
	if (/\border\s+by\b/i.test(visible))
		throw new Error('Remove the top-level ORDER BY clause from JQL.');
	// Creation time is immutable and Jira compares date bounds at minute
	// precision. The poller skips processed keys in code so stale keys are never
	// sent back to Jira, including keys for issues that are now missing.
	const bound = `updated >= ${lowerBound}${
		createdBefore === undefined ? '' : ` AND created <= ${createdBefore}`
	}${afterCreated === undefined ? '' : ` AND created >= ${afterCreated}`}`;
	return `${predicate.trim() ? `(${predicate.trim()}) AND ` : ''}${bound} ORDER BY created ${direction}, key ${direction}`;
}

function httpStatus(value: unknown): number | undefined {
	const status = Number(value);
	return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export function retryDetails(error: unknown): {
	status?: number;
	headers: JsonRecord;
	code: unknown;
	details?: string;
	transient: boolean;
	timedOut: boolean;
} {
	// NodeApiError keeps the axios error under `cause` only, so walk the chain.
	// Its `httpCode` holds a network code such as ECONNRESET when there is no
	// response, so only accept a candidate that reads as an HTTP status.
	let status: number | undefined;
	let headers: JsonRecord | undefined;
	let code: unknown;
	let details: string | undefined;
	let timedOut = false;
	let source: unknown = error;
	for (let depth = 0; depth < 5 && record(source); depth++) {
		const response = record(source.response) ? source.response : {};
		const data = record(response.data)
			? response.data
			: record(source.data)
				? source.data
				: record(source.body)
					? source.body
					: {};
		status ??=
			httpStatus(source.statusCode) ??
			httpStatus(source.httpCode) ??
			httpStatus(source.status) ??
			httpStatus(response.status) ??
			httpStatus(response.statusCode);
		headers ??= record(response.headers)
			? response.headers
			: record(source.headers)
				? source.headers
				: undefined;
		code ??= source.code ?? source.httpCode;
		const jiraDetails = jiraMessageText(data);
		if (jiraDetails) details = jiraDetails;
		else details ??= stringValue(source.description);
		timedOut ||= /timeout|timed out/i.test(String(source.message ?? ''));
		source = source.cause;
	}
	const timedOutCode = ['ETIMEDOUT', 'ECONNABORTED', 'ESOCKETTIMEDOUT'].includes(String(code));
	timedOut ||= timedOutCode;
	const transient =
		[408, 429, 500, 502, 503, 504].includes(status ?? 0) ||
		['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED', 'ESOCKETTIMEDOUT'].includes(
			String(code),
		);
	return { status, headers: headers ?? {}, code, details, transient, timedOut };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function jiraMessageText(body: JsonRecord): string | undefined {
	const messages = [body.errorMessages, body.warningMessages]
		.flatMap((value) => (Array.isArray(value) ? value : []))
		.map((value) =>
			typeof value === 'string' ? value : record(value) ? stringValue(value.message) : undefined,
		)
		.filter((value): value is string => value !== undefined);
	return messages.length ? [...new Set(messages)].join('; ') : undefined;
}

export class JiraTransport {
	private readonly apiVersion: 2 | 3;
	private readonly maxRetries: number;
	private readonly maxRetryDelayMs: number;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly now: () => number;
	private readonly deadline: number | undefined;

	constructor(
		private readonly read: Read,
		options: TransportOptions = {},
	) {
		this.apiVersion = options.apiVersion ?? 3;
		if (this.apiVersion !== 2 && this.apiVersion !== 3)
			throw new Error('Invalid Jira API version.');
		this.maxRetries = options.maxRetries ?? 3;
		this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
		this.sleep = options.sleep ?? sleep;
		this.now = options.now ?? Date.now;
		this.deadline = options.deadline;
		if (
			!Number.isInteger(this.maxRetries) ||
			this.maxRetries < 0 ||
			this.maxRetries > 10 ||
			!Number.isFinite(this.maxRetryDelayMs) ||
			this.maxRetryDelayMs < 0
		)
			throw new Error('Invalid retry settings.');
	}

	private async request(request: Omit<ReadRequest, 'timeout'>): Promise<JsonRecord> {
		for (let attempt = 0; ; attempt++) {
			const timeout = requestTimeout(this.deadline, this.now());
			let result: unknown;
			try {
				result = await this.read({ ...request, timeout });
			} catch (error) {
				// scanPoll consumes this sentinel and hands over saved progress.
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				if (error instanceof PollBudgetExhausted) throw error;
				const { status, headers, code, details, transient, timedOut } = retryDetails(error);
				const known = status !== undefined;
				const description = details ? ` Jira response: ${details}.` : '';
				const message = timedOut
					? `Jira read timed out${known ? ` (HTTP ${status})` : ''}.${description} Retry the poll.`
					: `Jira read failed${known ? ` (HTTP ${status})` : ''}.${description} ${transient ? 'Retry the poll.' : 'Check Jira access and retry the poll.'}`;
				const failure = () =>
					new JiraReadError(message, known ? status : undefined, {
						details,
						code,
						transient,
						timedOut,
					});
				if (!transient) throw failure();
				const retryAfter = Object.entries(headers).find(
					([key]) => key.toLowerCase() === 'retry-after',
				)?.[1];
				let delay = 1000 * 2 ** attempt;
				if (typeof retryAfter === 'string' || typeof retryAfter === 'number') {
					const seconds = Number(retryAfter);
					const requested = Number.isFinite(seconds)
						? seconds * 1000
						: Date.parse(String(retryAfter)) - this.now();
					if (Number.isFinite(requested)) delay = Math.max(delay, requested);
				}
				// A transient failure the budget cannot absorb, including a timeout the
				// capped request hit, stops the scan with its progress kept. scanPoll
				// handles this error; the node wraps everything else.
				if (this.deadline !== undefined && this.now() + delay >= this.deadline)
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					throw new PollBudgetExhausted(
						Number.isInteger(status) ? `HTTP ${status}` : String(code ?? 'request failed'),
						status,
						details,
						code,
						timedOut,
					);
				if (attempt >= this.maxRetries) throw failure();
				// Do not shorten a server-requested wait just to fit the retry budget.
				if (delay > this.maxRetryDelayMs) throw failure();
				await this.sleep(delay);
				continue;
			}
			if (!record(result)) throw new Error('Jira returned an invalid response.');
			return result;
		}
	}

	private async issueWasDeleted(issueId: string): Promise<boolean> {
		// Establish that the credential still works before interpreting an issue 404.
		await this.request({ method: 'GET', path: `/rest/api/${this.apiVersion}/myself` });
		try {
			await this.request({
				method: 'GET',
				path: `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(issueId)}`,
				qs: { fields: 'id' },
			});
			return false;
		} catch (error) {
			if (error instanceof JiraReadError && error.status === 404) return true;
			// Preserve the auth and network error for the node entry point.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw error;
		}
	}

	private pageLimit(limits: PageLimits): number {
		const limit = limits.maxPages ?? Infinity;
		if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1))
			throw new Error('Invalid manual page limit.');
		return limit;
	}

	async *searchIssues(
		predicate: string,
		lowerBound: number,
		fields: string[],
		limits: SearchOptions = {},
	): AsyncGenerator<Issue> {
		let afterCreated = limits.afterCreated;
		let jql = buildPollingJql(
			predicate,
			lowerBound,
			limits.direction,
			afterCreated,
			limits.createdBefore,
		);
		const limit = this.pageLimit(limits);
		const path = `/rest/api/${this.apiVersion}/search/jql`;
		const searchBody = (pageToken?: string, searchJql = jql): JsonRecord => ({
			jql: searchJql,
			fields: [
				...new Set([
					'created',
					'updated',
					'project',
					...fields,
					...(limits.withComments ? ['comment'] : []),
				]),
			],
			expand: 'renderedFields',
			maxResults: 100,
			...(pageToken ? { nextPageToken: pageToken } : {}),
		});
		const requestKey = (searchJql = jql) =>
			createHash('sha256')
				.update(JSON.stringify({ path, body: searchBody(undefined, searchJql) }))
				.digest('hex');
		const tokens = new Set<string>();
		const issueIds = new Set<string>();
		let nextPageToken = limits.pageToken;
		const validateIssues = (result: JsonRecord): Issue[] => {
			if (
				!Array.isArray(result.issues) ||
				!result.issues.every(
					(issue) =>
						record(issue) &&
						typeof issue.id === 'string' &&
						issue.id.length > 0 &&
						typeof issue.key === 'string' &&
						record(issue.fields) &&
						typeof issue.fields.created === 'string' &&
						typeof issue.fields.updated === 'string',
				)
			)
				throw new Error('Jira returned invalid issues.');
			return result.issues as Issue[];
		};
		const requestPage = (pageToken?: string, searchJql = jql) =>
			this.request({
				method: 'POST',
				path,
				body: searchBody(pageToken, searchJql),
			});
		let savedPageRequested = limits.resumeWithPageToken === true || nextPageToken !== undefined;
		if (
			limits.resumeWithPageToken === true &&
			(limits.pageTokenLastKey === undefined || limits.pageTokenRequestKey === undefined)
		)
			throw new Error('Invalid saved search page resume.');
		const discardSavedPage = (reason: 'request-mismatch' | 'rejected' | 'position-mismatch') => {
			limits.pageTokenFallback?.(reason);
			savedPageRequested = false;
			nextPageToken = undefined;
			tokens.clear();
			issueIds.clear();
			afterCreated = limits.fallbackAfterCreated ?? limits.afterCreated;
			jql = buildPollingJql(
				predicate,
				lowerBound,
				limits.direction,
				afterCreated,
				limits.createdBefore,
			);
		};
		if (
			savedPageRequested &&
			limits.pageTokenRequestKey !== undefined &&
			limits.pageTokenRequestKey !== requestKey()
		)
			discardSavedPage('request-mismatch');
		if (nextPageToken !== undefined) {
			if (typeof nextPageToken !== 'string' || !nextPageToken)
				throw new Error('Invalid search continuation.');
			tokens.add(nextPageToken);
		}
		for (let page = 0; page < limit; page++) {
			let requestPageToken = nextPageToken;
			let validateSavedPageToken = page === 0 && savedPageRequested;
			let result: JsonRecord;
			try {
				result = await requestPage(requestPageToken);
			} catch (error) {
				const status =
					error instanceof JiraReadError || error instanceof PollBudgetExhausted
						? error.status
						: retryDetails(error).status;
				if (
					page !== 0 ||
					requestPageToken === undefined ||
					(status !== 400 && status !== 404 && status !== 410)
				)
					// The node entry point wraps the preserved Jira error after scan-state handling.
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					throw error;
				discardSavedPage('rejected');
				requestPageToken = undefined;
				validateSavedPageToken = false;
				result = await requestPage();
			}
			let pageIssues = validateIssues(result);
			let savedBoundaryIndex = -1;
			if (validateSavedPageToken && limits.pageTokenLastKey !== undefined) {
				savedBoundaryIndex = pageIssues.findIndex((issue) => {
					if (issue.key !== limits.pageTokenLastKey) return false;
					if (limits.pageTokenLastCreated === undefined) return true;
					const created = Date.parse(issue.fields.created ?? '');
					return Number.isFinite(created) && created === limits.pageTokenLastCreated;
				});
				if (savedBoundaryIndex < 0) {
					discardSavedPage('position-mismatch');
					requestPageToken = undefined;
					validateSavedPageToken = false;
					result = await requestPage();
					pageIssues = validateIssues(result);
				} else limits.pageTokenResume?.();
			}
			const warningValues = [result.warnings, result.warningMessages].filter(
				(value) => value !== undefined,
			);
			if (
				warningValues.some((value) => !Array.isArray(value)) ||
				warningValues.some((value) => Array.isArray(value) && value.length > 0)
			)
				throw new Error(
					'Jira search returned warnings and may be incomplete. Narrow the JQL before retrying.',
				);
			// `isLast` is being retired from the Jira search response. Prefer the
			// token key when it is present and treat `isLast` as a cross-check; a
			// response carrying neither could be a truncated page, so fail.
			const tokenReturned = 'nextPageToken' in result;
			const isLast = tokenReturned
				? result.nextPageToken === undefined ||
					result.nextPageToken === null ||
					result.nextPageToken === ''
				: result.isLast;
			if (
				typeof isLast !== 'boolean' ||
				(tokenReturned && typeof result.isLast === 'boolean' && result.isLast !== isLast)
			)
				throw new Error('Jira returned invalid search pagination.');
			let followingPageToken: string | undefined;
			if (!isLast) {
				if (
					typeof result.nextPageToken !== 'string' ||
					!result.nextPageToken ||
					tokens.has(result.nextPageToken) ||
					pageIssues.length === 0
				)
					throw new Error('Jira search pagination did not advance.');
				followingPageToken = result.nextPageToken;
				tokens.add(followingPageToken);
			}
			const pageIssuesAfterSavedPosition =
				page === 0 && validateSavedPageToken
					? pageIssues.slice(savedBoundaryIndex + 1)
					: pageIssues;
			for (const issue of pageIssuesAfterSavedPosition) {
				if (issueIds.has(issue.id as string))
					throw new Error('Jira search repeated an issue across pages. Retry the poll.');
				issueIds.add(issue.id as string);
				yield issue as Issue;
			}
			const lastIssue = pageIssues.at(-1);
			limits.pageProgress?.(
				requestPageToken,
				lastIssue?.key,
				lastIssue ? Date.parse(lastIssue.fields.created ?? '') : undefined,
				lastIssue && requestPageToken === undefined
					? requestKey(
							buildPollingJql(
								predicate,
								lowerBound,
								limits.direction,
								Math.floor(Date.parse(lastIssue.fields.created ?? '') / 60_000) * 60_000,
								limits.createdBefore,
							),
						)
					: requestKey(),
			);
			if (isLast) return;
			nextPageToken = followingPageToken;
		}
	}

	async *comments(
		issueId: string,
		limits: PageLimits & CommentReadOptions = {},
	): AsyncGenerator<Comment> {
		const limit = this.pageLimit(limits);
		const resumeAt = limits.resumeAt ?? 0;
		if (!Number.isSafeInteger(resumeAt) || resumeAt < 0)
			throw new Error('Invalid comment continuation.');
		// Resume one comment early and check it is still the one read last; a
		// deletion since then shifts the list, so the read restarts from the top.
		let startAt = Math.max(0, resumeAt - 1);
		let verify = resumeAt > 0;
		const commentIds = new Set<string>();
		for (let page = 0; page < limit; page++) {
			let result: JsonRecord;
			try {
				result = await this.request({
					method: 'GET',
					path: `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(issueId)}/comment`,
					qs: {
						startAt,
						maxResults: 100,
						orderBy: 'created',
						expand: 'renderedBody',
					},
				});
			} catch (error) {
				if (
					error instanceof JiraReadError &&
					error.status === 404 &&
					(await this.issueWasDeleted(issueId))
				)
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					throw new JiraReadError(error.message, error.status, {
						details: error.details,
						code: error.code,
						transient: error.transient,
						timedOut: error.timedOut,
						issueMissing: true,
					});
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				throw error;
			}
			if (
				!Array.isArray(result.comments) ||
				!result.comments.every(
					(comment) =>
						record(comment) &&
						typeof comment.id === 'string' &&
						comment.id.length > 0 &&
						typeof comment.created === 'string' &&
						typeof comment.updated === 'string',
				)
			)
				throw new Error('Jira returned invalid comments.');
			if (
				result.startAt !== startAt ||
				!Number.isSafeInteger(result.total) ||
				(result.total as number) < 0 ||
				!Number.isSafeInteger(result.maxResults) ||
				(result.maxResults as number) < 1 ||
				result.comments.length > (result.maxResults as number)
			)
				throw new Error('Jira returned invalid comment pagination.');
			if (verify) {
				verify = false;
				if ((result.comments[0] as Comment | undefined)?.id !== limits.resumeAfter) {
					startAt = 0;
					page--;
					continue;
				}
			}
			const next = startAt + result.comments.length;
			if (next < (result.total as number) && next <= startAt)
				throw new Error('Jira comment pagination did not advance.');
			for (const comment of result.comments) {
				if (commentIds.has(comment.id as string))
					throw new Error('Jira comment pagination repeated a comment. Retry the poll.');
				commentIds.add(comment.id as string);
				yield comment as Comment;
			}
			if (result.comments.length > 0)
				limits.progress?.(next, (result.comments[result.comments.length - 1] as Comment).id);
			if (next >= (result.total as number)) return;
			startAt = next;
		}
	}
}

const isComment = (value: unknown): value is Comment =>
	record(value) &&
	typeof value.id === 'string' &&
	value.id.length > 0 &&
	typeof value.created === 'string' &&
	typeof value.updated === 'string';

/**
 * The comments Jira embedded in a search result when they are all of them,
 * with rendered bodies from `renderedFields` when present. Undefined when
 * the issue has more comments than the search embedded.
 */
export function embeddedComments(issue: Issue): Comment[] | undefined {
	const field = issue.fields.comment;
	if (
		!record(field) ||
		!Array.isArray(field.comments) ||
		!Number.isSafeInteger(field.total) ||
		field.comments.length < (field.total as number) ||
		!field.comments.every(isComment)
	)
		return undefined;
	const rendered = issue.renderedFields?.comment;
	const bodies = new Map(
		(record(rendered) && Array.isArray(rendered.comments) ? rendered.comments : [])
			.filter(isComment)
			.map((comment) => [comment.id, comment.body]),
	);
	return field.comments.map((comment) =>
		bodies.has(comment.id) ? { ...comment, renderedBody: bodies.get(comment.id) } : comment,
	);
}
