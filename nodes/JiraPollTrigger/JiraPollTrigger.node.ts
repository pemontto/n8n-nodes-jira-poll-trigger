/* eslint-disable @n8n/community-nodes/no-credential-reuse */
import { createHash } from 'node:crypto';
import type {
	IAdditionalCredentialOptions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { atlassianApiBaseUrl, resolveCloudId } from './atlassian';
import { cloudBaseUrl, looseSiteUrl } from './config';
import { properties } from './properties';
import { formatEvent } from './output';
import {
	scanPoll,
	type CommentReadOptions,
	type PollConfig,
	type PollState,
	type SearchReadOptions,
	type Issue,
	type Comment,
	PollBudgetExhausted,
	JiraReadError,
} from './poll-state';
import {
	JiraTransport,
	buildPollingJql,
	embeddedComments,
	requestTimeout,
	retryDetails,
} from './transport';

type CredentialType = 'jiraSoftwareCloudApi' | 'jiraSoftwareCloudOAuth2Api';

// The Atlassian gateway answers an expired token with 403 or 404, not the 401
// n8n refreshes on. Hosts up to 2.38 refresh on one status code, so the first
// attempt asks for 403 and a 401 or 404 earns one more attempt on that code.
const oauthRefreshOn = (status: number): IAdditionalCredentialOptions => ({
	oauth2: { tokenExpiredStatusCode: status },
});

/** n8n 2.38.0 added getPollBudgetMs to IPollFunctions; older hosts and typings lack it. */
function pollDeadline(context: IPollFunctions): number {
	if (!('getPollBudgetMs' in context) || typeof context.getPollBudgetMs !== 'function')
		return Date.now() + 5 * 60_000;
	const budget: unknown = context.getPollBudgetMs();

	if (typeof budget !== 'number' || !Number.isFinite(budget)) return Date.now() + 5 * 60_000;

	return Date.now() + Math.max(0, budget);
}

function commaList(value: unknown): string[] {
	return [
		...new Set(
			String(value ?? '')
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean),
		),
	].sort();
}

const busy = new Set<string>();

const pendingBaselines = new Map<string, { state: PollState; updatedAt: number }>();

export class JiraPollTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jira Poll Trigger',
		name: 'jiraPollTrigger',
		icon: { light: 'file:jira.svg', dark: 'file:jira.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["event"]}}',
		description: 'Poll Jira Cloud issues and comments',
		defaults: { name: 'Jira Poll Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		polling: true,
		credentials: [
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
		],
		properties,
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const manual = this.getMode() === 'manual';
		// Manual runs have no budget; scheduled ones stop fetching at the deadline.
		const deadline = manual ? undefined : pollDeadline(this);
		const suppliedOptions = this.getNodeParameter('options', {}) as IDataObject;
		const outputOptions = suppliedOptions;
		const simplify = outputOptions.simplify !== false;
		const outputFormat = outputOptions.outputFormat ?? 'rendered';

		if (
			outputFormat !== 'rendered' &&
			outputFormat !== 'text' &&
			outputFormat !== 'adf' &&
			outputFormat !== 'wiki'
		)
			throw new NodeOperationError(this.getNode(), 'Select a valid Output Format');
		const key = `${this.getWorkflow().id}:${this.getNode().id}`;

		if (!manual && busy.has(key)) {
			this.logger.warn('Jira Poll Trigger skipped an overlapping poll', {
				node: this.getNode().name,
			});

			return null;
		}

		if (!manual) busy.add(key);

		try {
			const pollStart = Date.now();

			const oauth = this.getNodeParameter('authentication', 'apiToken') === 'oAuth2';

			const credentialType: CredentialType = oauth
				? 'jiraSoftwareCloudOAuth2Api'
				: 'jiraSoftwareCloudApi';

			const credentials = await this.getCredentials(credentialType);
			const options = outputOptions;
			const domainOverride = String(options.domain ?? '').trim();
			const credentialSite = oauth ? looseSiteUrl(credentials.domain) : credentials.domain;
			// The site origin names the tenant in state and event IDs even when
			// requests go through the OAuth2 gateway.
			const baseUrl = cloudBaseUrl(domainOverride || credentialSite);
			const credentialId = this.getNode().credentials?.[credentialType]?.id ?? undefined;

			const call = async (
				url: string,
				request: IDataObject,
				options?: IAdditionalCredentialOptions,
			) =>
				await this.helpers.httpRequestWithAuthentication.call(
					this,
					credentialType,
					{ ...request, url, json: true, disableFollowRedirect: true },
					options,
				);

			const authenticated = async (url: string, request: IDataObject) => {
				if (!oauth) return await call(url, request);

				const attempt = (status: number, timeout: number) =>
					call(url, { ...request, timeout }, oauthRefreshOn(status));

				try {
					return await attempt(403, Number(request.timeout));
				} catch (error) {
					// The poll's catch wraps these as NodeOperationError.
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					if (error instanceof PollBudgetExhausted) throw error;
					const retry = retryDetails(error);
					const { status } = retry;

					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					if (status !== 401 && status !== 404) throw error;
					const initialTimeout = Number(request.timeout);
					const remaining = deadline === undefined ? initialTimeout : deadline - Date.now();

					// A real authentication failure stays an error even at our deadline.
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					if (remaining <= 0) throw error;

					return await attempt(status, Math.min(initialTimeout, remaining));
				}
			};

			const cloudId = oauth
				? await resolveCloudId(
						async () =>
							await authenticated('https://api.atlassian.com/oauth/token/accessible-resources', {
								method: 'GET',
								timeout: requestTimeout(deadline),
							}),
						credentialId,
						new URL(baseUrl).hostname,
					)
				: undefined;

			const apiBaseUrl = cloudId === undefined ? baseUrl : atlassianApiBaseUrl(cloudId);
			const resource = this.getNodeParameter('resource') as PollConfig['resource'];
			const event = this.getNodeParameter('event') as PollConfig['event'];
			const jql = String(this.getNodeParameter('jql', '')).trim();
			buildPollingJql(jql, pollStart);

			if (
				!['issue', 'comment'].includes(resource) ||
				!['created', 'updated', 'createdOrUpdated'].includes(event)
			)
				throw new NodeOperationError(this.getNode(), 'Invalid Jira polling resource or event.');
			const manualLimit = Number(options.testLimit ?? 10);

			if (manual && (!Number.isInteger(manualLimit) || manualLimit < 1 || manualLimit > 100))
				throw new NodeOperationError(
					this.getNode(),
					'Set test limit to an integer between 1 and 100',
				);
			const overlapMinutes = Number(options.overlapMinutes ?? 5);

			if (!Number.isFinite(overlapMinutes) || overlapMinutes < 1 || overlapMinutes > 1440)
				throw new NodeOperationError(this.getNode(), 'Set overlap between 1 and 1440 minutes');
			const overlapMs = overlapMinutes * 60_000;

			const excludedAccountIds =
				resource === 'comment' ? commaList(options.excludedAccountIds ?? '') : [];

			const publicOnly = resource === 'comment' && options.visibility === 'public';

			const fields = [
				...new Set([
					'summary',
					...(resource === 'issue' ? ['description'] : []),
					'project',
					'status',
					'created',
					'updated',
					...commaList(options.additionalFields ?? ''),
				]),
			];

			// OAuth2 tokens rotate on refresh, so OAuth2 is fingerprinted by the
			// stable site identity instead of token material.
			const fingerprint = JSON.stringify({
				credential: credentialId,
				credentialRevision: createHash('sha256')
					.update(JSON.stringify(oauth ? [baseUrl, cloudId] : [baseUrl, credentials.email]))
					.digest('hex'),
				baseUrl,
				resource,
				event,
				jql,
			});

			const config: PollConfig = {
				site: new URL(baseUrl).hostname,
				resource,
				event,
				fingerprint,
				overlapMs,
				excludedAccountIds,
				publicOnly,
			};

			const transport = new JiraTransport(
				async (request) =>
					await authenticated(`${apiBaseUrl}${request.path}`, {
						method: request.method,
						qs: request.qs,
						body: request.body,
						timeout: request.timeout,
					}),
				{ apiVersion: simplify && outputFormat === 'wiki' ? 2 : 3, deadline },
			);

			// Comments the search embedded, by issue; only issues with more
			// comments than the search embeds need requests of their own.
			const embedded = new Map<string, Comment[]>();
			const withComments = resource === 'comment';

			const source = {
				async *issues(lower: number, read?: SearchReadOptions): AsyncIterable<Issue> {
					let count = 0;

					for await (const issue of transport.searchIssues(
						jql,
						manual ? pollStart - 30 * 86_400_000 : lower,
						fields,
						// A test step shows the newest issues; scheduled polling stays ascending.
						{ ...(manual ? { maxPages: 2, direction: 'DESC' as const } : read), withComments },
					)) {
						const comments = withComments ? embeddedComments(issue) : undefined;

						if (comments) embedded.set(issue.id, comments);

						if (withComments) {
							const { comment, ...rest } = issue.fields;
							const { comment: renderedComment, ...renderedRest } = issue.renderedFields ?? {};
							void comment;
							void renderedComment;
							yield { ...issue, fields: rest, renderedFields: renderedRest };
						} else yield issue;

						if (manual && ++count >= 100) return;
					}
				},
				async *comments(issue: Issue, read?: CommentReadOptions): AsyncIterable<Comment> {
					const known = embedded.get(issue.id);

					if (known) {
						yield* known;

						return;
					}

					try {
						for await (const comment of transport.comments(issue.id, {
							...(manual ? { maxPages: 2 } : {}),
							...read,
						}))
							yield comment;
					} catch (error) {
						if (manual && error instanceof PollBudgetExhausted && error.reason === 'page cap')
							return;
						// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
						throw error;
					}
				},
			};

			const data = manual ? undefined : this.getWorkflowStaticData('node');
			// SAFETY: jiraPollState is written below from scanPoll's PollState result and validated by scanPoll before scanning.
			const saved = data?.jiraPollState as PollState | undefined;
			const committed = saved?.version === 2 && saved.fingerprint === fingerprint;

			if (!manual) {
				for (const [pendingKey, pending] of pendingBaselines) {
					if (pollStart - pending.updatedAt >= 60 * 60_000) pendingBaselines.delete(pendingKey);
				}

				const pending = pendingBaselines.get(key);

				if (committed || pending?.state.fingerprint !== fingerprint) pendingBaselines.delete(key);
			}

			const before = committed ? saved : !manual ? pendingBaselines.get(key)?.state : undefined;

			if (!manual && !before) await transport.validateActivation(jql, pollStart);

			const result = await scanPoll({
				config,
				state: before,
				pollStart,
				source,
				manual,
				manualLimit,
				warn: (message) => this.logger.warn(message, { node: this.getNode().name }),
			});

			// Format before committing: a formatting failure must not advance the checkpoint.
			// SAFETY: formatEvent returns Jira JSON fields and poll metadata for n8n's JSON output helper.
			const items = result.events.length
				? [
						this.helpers.returnJsonArray(
							result.events.map((event) =>
								formatEvent(event, simplify, outputFormat),
							) as IDataObject[],
						),
					]
				: null;

			if (!manual && data && result.state) {
				// The runtime owns durable commit. Do not call its internal cursor methods.
				// SAFETY: scanPoll constructs PollState from JSON-compatible checkpoint, cursor, and Jira payload fields.
				data.jiraPollState = result.state as PollState & IDataObject;

				if (!committed && result.events.length === 0)
					pendingBaselines.set(key, { state: result.state, updatedAt: pollStart });

				if (result.dropped !== undefined)
					this.logger.warn(
						`Jira Poll Trigger dropped issue ${result.dropped}: Jira no longer serves its comments`,
						{ node: this.getNode().name },
					);

				// Page-cap stops hand over progress and remain visible in the log.
				if (result.stopped !== undefined && result.stopped !== 'deadline')
					this.logger.warn(
						`Jira Poll Trigger stopped early (${result.stopped}); progress saved, continuing next poll`,
						{ node: this.getNode().name },
					);
			}

			return items;
		} catch (caught) {
			const error =
				caught instanceof PollBudgetExhausted && caught.failure ? caught.failure : caught;

			// Preserve existing n8n API and operation error metadata.
			if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;

			if (error instanceof JiraReadError)
				throw new NodeApiError(
					this.getNode(),
					{ errorMessages: error.details ? [error.details] : [], message: error.message },
					{
						message: error.message,
						description:
							error.details ?? (error.timedOut ? 'Timed out while reading from Jira.' : undefined),
						httpCode:
							error.status !== undefined
								? String(error.status)
								: error.timedOut && typeof error.code === 'string'
									? error.code
									: undefined,
					},
				);
			const details = retryDetails(error);

			if (details.status !== undefined || details.timedOut)
				throw new NodeApiError(this.getNode(), error as JsonObject, {
					message:
						details.details ?? (error instanceof Error ? error.message : 'Jira polling failed'),
					httpCode: details.status !== undefined ? String(details.status) : String(details.code),
				});

			throw new NodeOperationError(
				this.getNode(),
				error instanceof Error ? error.message : 'Jira polling failed',
			);
		} finally {
			if (!manual) busy.delete(key);
		}
	}
}
