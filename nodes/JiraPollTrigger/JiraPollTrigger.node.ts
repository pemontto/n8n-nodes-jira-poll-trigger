/* eslint-disable @n8n/community-nodes/no-credential-reuse */
import { createHash } from 'node:crypto';
import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { checkSnapshot, recordReplacement } from './snapshot-guard';
import { cloudBaseUrl } from './config';
import { properties } from './properties';
import { formatEvent, type OutputFormat } from './output';
import {
	scanPoll,
	serializePoll,
	type PollConfig,
	type PollState,
	type Issue,
	type Comment,
} from './poll-state';
import { JiraTransport, buildPollingJql } from './transport';

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
		credentials: [{ name: 'jiraSoftwareCloudApi', required: true }],
		properties,
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const manual = this.getMode() === 'manual';
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
				const credentials = await this.getCredentials('jiraSoftwareCloudApi');
				const options = outputOptions as IDataObject;
				const domainOverride = String(options.domain ?? '').trim();
				const baseUrl = cloudBaseUrl(domainOverride || credentials.domain);
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
				const fingerprint = JSON.stringify({
					credential: this.getNode().credentials?.jiraSoftwareCloudApi?.id,
					credentialRevision: createHash('sha256')
						.update(JSON.stringify([credentials.email, credentials.apiToken]))
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
						await this.helpers.httpRequestWithAuthentication.call(this, 'jiraSoftwareCloudApi', {
							method: request.method,
							url: `${baseUrl}${request.path}`,
							qs: request.qs,
							body: request.body,
							json: true,
							timeout: 30_000,
							disableFollowRedirect: true,
						}),
					{ apiVersion: simplify && outputFormat === 'wiki' ? 2 : 3 },
				);
				const source = {
					async *issues(lower: number): AsyncIterable<Issue> {
						let count = 0;
						for await (const issue of transport.searchIssues(
							jql,
							manual ? pollStart - 30 * 86_400_000 : lower,
							fields,
							// A test step shows the newest issues; scheduled polling stays ascending.
							manual ? { maxPages: 2, direction: 'DESC' as const } : undefined,
						)) {
							yield issue as unknown as Issue;
							if (manual && ++count >= 100) return;
						}
					},
					async *comments(issue: Issue): AsyncIterable<Comment> {
						for await (const comment of transport.comments(
							issue.id,
							manual ? { maxPages: 2 } : undefined,
						))
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
