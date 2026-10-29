// Build public assets only. Reuse the reviewed Chinese-workbench exclusion.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyPagesRelease} from '../verify-pages-release.mjs';

const preview=process.argv.includes('--preview');
const sha=process.env.RELEASE_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Full commit SHA required');
execFileSync(process.execPath,['scripts/prepare-chinese-pages-release.mjs',...(process.argv.includes('--allow-dirty')?['--allow-dirty']:[])],{stdio:'inherit'});
const manifest=JSON.parse(fs.readFileSync('work/release-readiness/pages-manifest.json'));
const out=path.resolve('dist',preview?'preview':'production');
if(fs.existsSync(out))throw Error('Build output must be new');
fs.cpSync(manifest.folder,out,{recursive:true});
fs.writeFileSync(path.join(out,'release.json'),JSON.stringify({commit:sha,preview})+'\n');
if(preview){
 fs.writeFileSync(path.join(out,'config.js'),"window.FANSCOPE_CONFIG={API_BASE_URL:'https://preview-api.invalid'};\n");
 // No scripts, frames, forms, external images, or API calls in untrusted previews.
 // This intentionally static preview has no production API access at all.
 fs.writeFileSync(path.join(out,'_headers'),"/*\n  Content-Security-Policy: default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; script-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  X-Robots-Tag: noindex, nofollow\n");
}
verifyPagesRelease(out);
console.log(JSON.stringify({out,sha,preview}));
