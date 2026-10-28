import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const failures=[];
for(const file of files){
 if(!fs.existsSync(file))continue;
 if(/(^|\/)(private_inputs|attachments|lab-documents)(\/|$)|\.sqlite(?:-|$)|\.xlsx$|Handoff.*\.zip$|(^|\/)\.env$/.test(file))failures.push(file+': private artifact');
 if(fs.statSync(file).size>2e6||/\.(png|pdf|docx|zip)$/.test(file))continue;
 const text=fs.readFileSync(file,'utf8');if(/sk-[A-Za-z0-9]{24,}|re_[A-Za-z0-9]{24,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text))failures.push(file+': credential pattern');
}
if(failures.length){console.error(failures.join('\n'));process.exit(1)}console.log('Sensitive artifact and credential-pattern scan passed.');
