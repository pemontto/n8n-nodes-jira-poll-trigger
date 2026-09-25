import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [pack] = JSON.parse(
	execFileSync(
		'npm',
		['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', '/tmp/jira-pack-cache'],
		{ encoding: 'utf8' },
	),
);
const files = pack.files.map((file) => file.path);
assert.deepEqual(pkg.n8n.credentials, []);
for (const entry of pkg.n8n.nodes) assert(files.includes(entry), `Missing ${entry}`);
assert(files.includes('dist/nodes/JiraPollTrigger/jira.svg'));
assert(files.includes('dist/nodes/JiraPollTrigger/JiraPollTrigger.node.json'));
assert(!files.some((file) => file.endsWith('.tsbuildinfo')), 'TypeScript build info must not ship');
assert(
	!files.some((file) => file.endsWith('.map')),
	'Source maps to local source files must not ship',
);
assert(
	files.every(
		(file) =>
			file.startsWith('dist/') || ['README.md', 'LICENSE.md', 'package.json'].includes(file),
	),
);
assert(
	!files.some((file) =>
		/(?:^|\/)(?:credentials|captures?|snapshots?|node_modules|\.env)(?:\/|$)/i.test(file),
	),
);
console.log(
	`Package check passed: ${files.length} files; built-in credential reused, no credentials, test captures, build info, or source maps.`,
);
