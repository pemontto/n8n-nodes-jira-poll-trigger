import { createHash } from 'node:crypto';
import type { PollState } from './poll-state';

// A process-local rejection check, not a durable commit or a cross-process lock.
const replacements = new Map<string, string>();
function digest(state: PollState | undefined): string {
	const value = state
		? [
				state.version,
				state.fingerprint,
				state.activation,
				state.checkpoint,
				state.window
					? [
							state.window.since,
							state.window.until,
							state.window.afterId ?? null,
							state.window.partial
								? [
										state.window.partial.issue.id,
										state.window.partial.startAt,
										state.window.partial.lastCommentId,
										state.window.partial.done,
									]
								: null,
						]
					: null,
				state.seen
					.map(({ key, time }) => [key, time])
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
			]
		: null;
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function checkSnapshot(key: string, state: PollState | undefined): void {
	const expected = replacements.get(key);
	if (expected !== undefined && expected !== digest(state)) {
		throw new Error(
			'n8n supplied stale or uncommitted Jira polling state. Poll stopped without advancing. This host cannot provide the required cursor persistence; see the package README.',
		);
	}
}
export function recordReplacement(key: string, state: PollState): void {
	replacements.set(key, digest(state));
}
