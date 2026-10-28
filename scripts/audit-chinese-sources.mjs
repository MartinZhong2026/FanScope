// Creates no DB and contacts no production service.
import fs from 'node:fs';
const journals=JSON.parse(fs.readFileSync(new URL('../api/config/journals.json',import.meta.url)));
const items=journals.filter(j=>j.market==='chinese').map(j=>({id:j.id,title:j.title,market:j.market,source:j.source,enabled:j.enabled,issn:j.issn||null,rank_system:j.rank_system,rank_year:j.rank_year,rank_verification_status:j.rank_verification_status||'pending',rss_url:j.rss_url||null,approved_hosts:j.rss_allowed_hosts||[],gap:!j.enabled?'Disabled: no verified automatic source; authorized import required':'Check runtime diagnostics'}));
console.log(JSON.stringify({scope:'repository configuration, not production state',productionInspected:false,items},null,2));
