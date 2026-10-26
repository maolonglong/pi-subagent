import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("launch identity survives stale child writes; failed launches can be stopped safely", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-launch-test-"));
	t.diagnostic(`Evidence: ${dir}`);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "rex"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('session.new_window')) {
 console.log(JSON.stringify({block_ids:['block:fixture']}));
} else if (args.includes('ls')) {
 if (process.env.FIXTURE_MODE === 'unavailable') process.exit(1);
 const block={block_id:'block:recovered',label:'subagent abcdef'};
 console.log(JSON.stringify({blocks:process.env.FIXTURE_MODE === 'ambiguous' ? [block,{...block,block_id:'block:other'}] : process.env.FIXTURE_MODE === 'found' ? [block] : []}));
} else if (args.includes('process')) {
 console.log(JSON.stringify({child:{pid:123}}));
} else if (args.includes('close')) {
 const fs=await import('node:fs');
 fs.writeFileSync(process.env.PI_CODING_AGENT_DIR+'/closed.json',JSON.stringify(args));
 console.log('{}');
} else process.exit(1);
`, { mode: 0o700 });
	const env = { ...process.env, PI_SUBAGENT_RUN_DIR: "", PI_CODING_AGENT_DIR: dir, PATH: `${bin}:${process.env.PATH}` };
	const source = `
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync, readFileSync} from 'node:fs';
import {launchRun,writeMetadata,readMetadata} from ${JSON.stringify(join(root, "shared.ts"))};
const runDir=join(process.env.PI_CODING_AGENT_DIR,'subagents','abcdef');
const now=new Date().toISOString();
const run={version:1,handle:'abcdef',rexSession:process.env.REX_SESSION||'fixture',runDir,sessionFile:join(runDir,'session.jsonl'),cwd:process.env.PI_CODING_AGENT_DIR,provider:'fixture',model:'fixture',thinking:'off',state:'idle',hasStarted:false,createdAt:now,updatedAt:now};
writeMetadata(run);
launchRun(run);
// A child can finish a read-modify-write with the snapshot taken before launch returned.
writeMetadata({...run,state:'busy',hasStarted:true});
assert.equal(readMetadata(runDir).rexBlock,'block:fixture');
assert.equal(readMetadata(runDir).state,'busy');
writeFileSync(join(process.env.PI_CODING_AGENT_DIR,'identity-result.json'),JSON.stringify(readMetadata(runDir),null,2));
`;
	const identity = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8", timeout: 10000 });
	writeFileSync(join(dir, "identity-stderr.txt"), identity.stderr);
	assert.equal(identity.status, 0, identity.stderr);
	const results = [];
	for (const mode of ["missing", "found", "unavailable", "ambiguous"]) {
		const config = join(dir, mode);
		const runDir = join(config, "subagents", "abcdef");
		mkdirSync(runDir, { recursive: true });
		const run = JSON.parse(readFileSync(join(dir, "identity-result.json"), "utf8"));
		delete run.rexBlock;
		Object.assign(run, { runDir, state: "error", hasStarted: false });
		writeFileSync(join(runDir, "metadata.json"), JSON.stringify(run));
		const result = spawnSync(process.execPath, [join(root, "subagent.ts"), "stop", "abcdef"], {
			env: { ...env, PI_CODING_AGENT_DIR: config, FIXTURE_MODE: mode }, encoding: "utf8", timeout: 10000,
		});
		results.push({ mode, status: result.status, stdout: result.stdout, stderr: result.stderr });
		writeFileSync(join(dir, "stop-results.json"), JSON.stringify(results, null, 2));
		const preserved = mode === "unavailable" || mode === "ambiguous";
		assert.equal(result.status, preserved ? 1 : 0, result.stderr);
		assert.equal(existsSync(runDir), preserved);
		assert.equal(existsSync(join(config, "closed.json")), mode === "found");
		if (mode === "found") assert.equal(JSON.parse(readFileSync(join(config, "closed.json"), "utf8")).at(-1), "block:recovered");
	}
});
