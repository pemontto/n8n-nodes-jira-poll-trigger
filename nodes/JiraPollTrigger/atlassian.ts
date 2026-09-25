// OAuth2 calls go through the Atlassian gateway, addressed by cloud ID rather
// than site hostname. Community nodes cannot import n8n's utils/atlassian, so
// this is the minimal subset of it.
export interface AccessibleResource {
	id: string;
	url: string;
}
export type ReadAccessibleResources = () => Promise<unknown>;

// credentialId to accessible-resources, for the life of the process.
const accessibleResources = new Map<string, AccessibleResource[]>();

export function atlassianApiBaseUrl(cloudId: string): string {
	return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}`;
}

function resources(value: unknown): AccessibleResource[] {
	return (Array.isArray(value) ? value : []).filter(
		(item): item is AccessibleResource =>
			item !== null &&
			typeof item === 'object' &&
			typeof (item as AccessibleResource).id === 'string' &&
			(item as AccessibleResource).id !== '' &&
			typeof (item as AccessibleResource).url === 'string',
	);
}

/**
 * Resolves a site hostname to its cloud ID. A cached list that has no match is
 * refetched once, so a site granted after a reconnect is found without a restart.
 */
export async function resolveCloudId(
	read: ReadAccessibleResources,
	credentialId: string | undefined,
	hostname: string,
): Promise<string> {
	const wanted = hostname.toLowerCase();
	const match = (sites: AccessibleResource[]) =>
		sites.find((site) => {
			try {
				return new URL(site.url).hostname.toLowerCase() === wanted;
			} catch {
				return false;
			}
		});
	let sites = credentialId ? accessibleResources.get(credentialId) : undefined;
	if (!sites || !match(sites)) {
		sites = resources(await read());
		if (credentialId) accessibleResources.set(credentialId, sites);
	}
	const site = match(sites);
	if (!site) {
		const urls = sites.map((item) => item.url).filter(Boolean);
		throw new Error(
			`No Jira site matched ${hostname}. This connection can access: ${
				urls.length ? urls.slice(0, 5).join(', ') : 'no sites'
			}${urls.length > 5 ? `, and ${urls.length - 5} more` : ''}.`,
		);
	}
	return site.id;
}
