/* eslint-disable @n8n/community-nodes/no-credential-reuse */
import { createHash } from 'node:crypto';
import type {
	IAdditionalCredentialOptions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { atlassianApiBaseUrl, resolveCloudId } from './atlassian';
import { checkSnapshot, recordReplacement } from './snapshot-guard';
import { cloudBaseUrl, looseSiteUrl } from './config';
import { properties } from './properties';
import { formatEvent, type OutputFormat } from './output';
import {
	scanPoll,
	serializePoll,
	type CommentReadOptions,
	type PollConfig,
	type PollState,
	type SearchReadOptions,
	type Issue,
	type Comment,
	PollBudgetExhausted,
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
function pollDeadline(context: object): number | undefined {
	const host = context as { getPollBudgetMs?: unknown };
	if (typeof host.getPollBudgetMs !== 'function') return undefined;
	const budget: unknown = host.getPollBudgetMs();
	if (typeof budget !== 'number' || !Number.isFinite(budget)) return undefined;
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
		const legacy = { ...this.getNode().parameters };
		for (const name of [
			'simplify',
			'domain',
			'visibility',
			'excludedAccountIds',
			'additionalFields',
		]) {
			const value = legacy[name];
			if (suppliedOptions[name] === undefined && typeof value === 'string' && value.startsWith('='))
				legacy[name] = this.getNodeParameter(name, undefined, {
					skipValidation: true,
				}) as typeof value;
		}

		const outputOptions = {
			simplify: legacy.simplify,
			domain: legacy.domain,
			visibility: legacy.visibility,
			excludedAccountIds: legacy.excludedAccountIds,
			additionalFields: legacy.additionalFields,
			...suppliedOptions,
		} as IDataObject;
		const simplify = outputOptions.simplify !== false;
		const outputFormat = (outputOptions.outputFormat ?? 'rendered') as OutputFormat;
		if (!['rendered', 'text', 'adf', 'wiki'].includes(outputFormat))
			throw new NodeOperationError(this.getNode(), 'Select a valid Output Format');
		const key = `${this.getWorkflow().id}:${this.getNode().id}`;
		return await serializePoll(key, async () => {
			const pollStart = Date.now();
			try {
				const oauth = this.getNodeParameter('authentication', 'apiToken') === 'oAuth2';
				const credentialType: CredentialType = oauth
					? 'jiraSoftwareCloudOAuth2Api'
					: 'jiraSoftwareCloudApi';
				const credentials = await this.getCredentials(credentialType);
				const options = outputOptions as IDataObject;
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
					const attempt = (status: number) => call(url, request, oauthRefreshOn(status));
					try {
						return await attempt(403);
					} catch (error) {
						// The poll's catch wraps these as NodeOperationError.
						// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
						if (error instanceof PollBudgetExhausted) throw error;
						const { status } = retryDetails(error);
						// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
						if (status !== 401 && status !== 404) throw error;
						return await attempt(status);
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
						.update(
							JSON.stringify(
								oauth ? [credentialSite, cloudId] : [credentials.email, credentials.apiToken],
							),
						)
						.digest('hex'),
					baseUrl,
					resource,
					event,
					jql,
					excludedAccountIds,
					publicOnly,
					fields,
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
							const { comment, ...rest } = issue.fields;
							void comment;
							const { comment: renderedComment, ...renderedRest } = issue.renderedFields ?? {};
							void renderedComment;
							yield { ...issue, fields: rest, renderedFields: renderedRest } as unknown as Issue;
							if (manual && ++count >= 100) return;
						}
					},
					async *comments(issue: Issue, read?: CommentReadOptions): AsyncIterable<Comment> {
						const known = embedded.get(issue.id);
						if (known) {
							yield* known;
							return;
						}
						for await (const comment of transport.comments(issue.id, {
							...(manual ? { maxPages: 2 } : {}),
							...read,
						}))
							yield comment as unknown as Comment;
					},
				};
				const data = manual ? undefined : this.getWorkflowStaticData('node');
				const before = data?.jiraPollState as unknown as PollState | undefined;
				if (!manual) checkSnapshot(key, before);
				const result = await scanPoll({
					config,
					state: before,
					pollStart,
					source,
					manual,
					manualLimit,
					budgeted: deadline !== undefined,
				});
				// Format before committing: a formatting failure must not advance the checkpoint.
				const items = result.events.length
					? [
							this.helpers.returnJsonArray(
								result.events.map((event) =>
									formatEvent(event, simplify, outputFormat),
								) as unknown as IDataObject[],
							),
						]
					: null;
				if (!manual && data && result.state) {
					// The runtime owns durable commit. Do not call its internal cursor methods.
					if (data.jiraPollState !== before)
						throw new NodeOperationError(
							this.getNode(),
							'Polling state changed during this poll; retry without advancing the checkpoint',
						);
					data.jiraPollState = result.state as unknown as IDataObject;
					recordReplacement(key, result.state);
					if (result.dropped !== undefined)
						this.logger.warn(
							`Jira Poll Trigger dropped issue ${result.dropped}: Jira no longer serves its comments`,
							{ node: this.getNode().name },
						);
					// A stop on a failed request is quiet on the output; say so in the log.
					if (result.stopped !== undefined && result.stopped !== 'deadline')
						this.logger.warn(
							`Jira Poll Trigger stopped early (${result.stopped}); progress saved, continuing next poll`,
							{ node: this.getNode().name },
						);
				}
				return items;
			} catch (error) {
				throw new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error.message : 'Jira polling failed',
				);
			}
		});
	}
}
