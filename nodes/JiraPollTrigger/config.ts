// Pure validation errors are wrapped as NodeOperationError by the node entry point.
/* eslint-disable @n8n/community-nodes/require-node-api-error */
export function cloudBaseUrl(value: unknown): string {
	let url: URL;
	try {
		url = new URL(String(value));
	} catch {
		throw new Error('Set a valid Jira Cloud domain in the node or credential');
	}
	if (
		url.protocol !== 'https:' ||
		!url.hostname.endsWith('.atlassian.net') ||
		url.username ||
		url.password ||
		url.port ||
		(url.pathname !== '/' && url.pathname !== '') ||
		url.search ||
		url.hash
	) {
		throw new Error('Use an HTTPS Jira Cloud tenant domain such as https://example.atlassian.net');
	}
	return url.origin;
}
