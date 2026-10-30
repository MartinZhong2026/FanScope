// Production-equivalent upgrade of an EXISTING legacy database (K3): the first
// start stops at MIGRATIONS_PENDING after the legacy bootstrap, the reviewed
// migrations are applied explicitly, and later starts are normal.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../../src/migrate-cli.mjs',import.meta.url));
export function startThenApplyReviewed(start,env){
 try{start()}catch(e){if(!/MIGRATIONS_PENDING/.test(String(e.stderr)))throw e}
 const run=args=>{const r=spawnSync(process.execPath,['--experimental-sqlite',cli,...args],{env,encoding:'utf8'});const out=JSON.parse(r.stdout);if(r.status!==0)throw Error(JSON.stringify(out.error));return out};
 const plan=run(['status']);
 return run(['apply','--expect',plan.pending.map(p=>`${p.id}:${p.checksum}`).join(',')]);
}
