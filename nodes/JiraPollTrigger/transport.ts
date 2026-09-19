import { sleep } from 'n8n-workflow';
import type { Issue, Comment } from './poll-state';

export type JsonRecord = Record<string, unknown>;
export interface ReadRequest {
	method: 'GET' | 'POST';
	path: string;
	qs?: Record<string, string | number>;
	body?: JsonRecord;
}
export type Read = (request: ReadRequest) => Promise<unknown>;
export interface PageLimits {
	maxPages?: number;
}
export interface SearchOptions extends PageLimits {
	direction?: 'ASC' | 'DESC';
}
export interface TransportOptions {
	apiVersion?: 2 | 3;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
}

function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep quoted strings intact while checking the top-level predicate. */
export function buildPollingJql(
	predicate: string,
	lowerBound: number,
	direction: 'ASC' | 'DESC' = 'ASC',
): string {
	if (!Number.isSafeInteger(lowerBound) || lowerBound < 0)
		throw new Error('Invalid polling boundary.');
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
	// Order by a stable key: `updated` moves mid-pagination and trips the repeat guard.
	return `${predicate.trim() ? `(${predicate.trim()}) AND ` : ''}updated >= ${lowerBound} ORDER BY id ${direction}`;
}

function httpStatus(value: unknown): number | undefined {
	const status = Number(value);
	return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function retryDetails(error: unknown): {
	status: number;
	headers: JsonRecord;
	code: unknown;
} {
	// NodeApiError keeps the axios error under `cause` only, so walk the chain.
	// Its `httpCode` holds a network code such as ECONNRESET when there is no
	// response, so only accept a candidate that reads as an HTTP status.
	let status: number | undefined;
	let headers: JsonRecord | undefined;
	let code: unknown;
	let source: unknown = error;
	for (let depth = 0; depth < 5 && record(source); depth++) {
		const response = record(source.response) ? source.response : {};
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
		source = source.cause;
	}
	return { status: Number(status), headers: headers ?? {}, code };
}

export class JiraTransport {
	private readonly apiVersion: 2 | 3;
	private readonly maxRetries: number;
	private readonly maxRetryDelayMs: number;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly now: () => number;

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
		if (
			!Number.isInteger(this.maxRetries) ||
			this.maxRetries < 0 ||
			this.maxRetries > 10 ||
			!Number.isFinite(this.maxRetryDelayMs) ||
			this.maxRetryDelayMs < 0
		)
			throw new Error('Invalid retry settings.');
	}

	private async request(request: ReadRequest): Promise<JsonRecord> {
		for (let attempt = 0; ; attempt++) {
			let result: unknown;
			try {
				result = await this.read(request);
			} catch (error) {
				const { status, headers, code } = retryDetails(error);
				const transient =
					[408, 429, 500, 502, 503, 504].includes(status) ||
					['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'].includes(String(code));
				const failure = () =>
					new Error(
						`Jira read failed${Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : ''}. Check access and retry the poll.`,
					);
				if (!transient || attempt >= this.maxRetries) throw failure();
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
				// Do not shorten a server-requested wait just to fit the retry budget.
				if (delay > this.maxRetryDelayMs) throw failure();
				await this.sleep(delay);
				continue;
			}
			if (!record(result)) throw new Error('Jira returned an invalid response.');
			return result;
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
		const jql = buildPollingJql(predicate, lowerBound, limits.direction);
		const limit = this.pageLimit(limits);
		const tokens = new Set<string>();
		const issueIds = new Set<string>();
		let nextPageToken: string | undefined;
		for (let page = 0; page < limit; page++) {
			const result = await this.request({
				method: 'POST',
				path: `/rest/api/${this.apiVersion}/search/jql`,
				body: {
					jql,
					fields: [...new Set(['created', 'updated', 'project', ...fields])],
					expand: 'renderedFields',
					maxResults: 100,
					...(nextPageToken ? { nextPageToken } : {}),
				},
			});
			if (
				result.warnings !== undefined &&
				(!Array.isArray(result.warnings) || result.warnings.length > 0)
			)
				throw new Error(
					'Jira search returned warnings and may be incomplete. Narrow the JQL before retrying.',
				);
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
			if (!isLast) {
				if (
					typeof result.nextPageToken !== 'string' ||
					!result.nextPageToken ||
					tokens.has(result.nextPageToken) ||
					result.issues.length === 0
				)
					throw new Error('Jira search pagination did not advance.');
				nextPageToken = result.nextPageToken;
				tokens.add(nextPageToken);
			}
			for (const issue of result.issues) {
				if (issueIds.has(issue.id as string))
					throw new Error('Jira search repeated an issue across pages. Retry the poll.');
				issueIds.add(issue.id as string);
				yield issue as Issue;
			}
			if (isLast) return;
		}
	}

	async *comments(issueId: string, limits: PageLimits = {}): AsyncGenerator<Comment> {
		const limit = this.pageLimit(limits);
		let startAt = 0;
		const commentIds = new Set<string>();
		for (let page = 0; page < limit; page++) {
			const result = await this.request({
				method: 'GET',
				path: `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(issueId)}/comment`,
				qs: {
					startAt,
					maxResults: 100,
					orderBy: 'created',
					expand: 'renderedBody',
				},
			});
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
			const next = startAt + result.comments.length;
			if (next < (result.total as number) && next <= startAt)
				throw new Error('Jira comment pagination did not advance.');
			for (const comment of result.comments) {
				if (commentIds.has(comment.id as string))
					throw new Error('Jira comment pagination repeated a comment. Retry the poll.');
				commentIds.add(comment.id as string);
				yield comment as Comment;
			}
			if (next >= (result.total as number)) return;
			startAt = next;
		}
	}
}
