// Read-only connectivity and metadata probe for the configured Chinese journals.
// Run from the network that will do the collecting (the production host), e.g.:
//   sudo docker exec -i fanscope-api node --input-type=module - < scripts/ops/probe-cn-sources.mjs > probe.json
// GET only, sequential, 1.5 s apart, identifying User-Agent, honours robots "Disallow: /",
// never bypasses JavaScript challenges, logins or TLS errors. Stores statuses only.
import fs from 'node:fs';
const cfgDir = ['/app/config', 'api/config', 'config'].find(d => fs.existsSync(d + '/chinese-journal-inventory.json'));
if (!cfgDir) throw Error('chinese-journal-inventory.json not found');
const invFile = cfgDir + '/chinese-journal-inventory.json', jFile = cfgDir + '/journals.json';
const inv = JSON.parse(fs.readFileSync(invFile, 'utf8'));
const cfg = JSON.parse(fs.readFileSync(jFile, 'utf8')).filter(j => j.market === 'chinese');
const UA = 'FanScope-SourceProbe/1.0 (academic metadata availability check; read-only)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, {max = 3, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'} = {}) {
  let current = url;
  for (let hop = 0; hop <= max; hop++) {
    await sleep(1500);
    try {
      const r = await fetch(current, {redirect: 'manual', headers: {'User-Agent': UA, Accept: accept}, signal: AbortSignal.timeout(20000)});
      if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location')) { current = new URL(r.headers.get('location'), current).href; await r.body?.cancel(); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      let text = buf.toString('utf8');
      if (/charset=gb/i.test(ct) || /<meta[^>]+charset=["']?gb/i.test(text.slice(0, 2000))) text = new TextDecoder('gbk').decode(buf);
      return {status: r.status, url: current, contentType: ct, bytes: buf.length, text};
    } catch (e) { return {status: 0, url: current, error: (e.cause?.code || e.name || 'error') + ': ' + String(e.cause?.message || e.message).slice(0, 120)}; }
  }
  return {status: 0, url: current, error: 'too many redirects'};
}
const meta = (html, name) => [...html.matchAll(new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, 'gi'))].map(m => (m[0].match(/content=["']([^"']*)["']/i) || [])[1] || '');
function platform(html, url) {
  const h = (html || '').slice(0, 200000);
  if (/cbpt\.cnki\.net/.test(url) || /cbpt\.cnki/i.test(h)) return 'cnki-cbpt';
  if (/ajcass\.com/.test(url)) return 'ajcass';
  if (/sciopen\.com/.test(url)) return 'sciopen';
  if (/showOldVolumn|\/CN\/Y\d{4}\/V\d+|magtech|玛格泰克/i.test(h)) return 'magtech';
  if (/qinyun|勤云/i.test(h)) return 'qinyun';
  return 'unknown';
}
function articleLinks(html, base) {
  const out = new Set();
  for (const m of (html || '').matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = m[1];
    if (/\/CN\/(?:Y\d{4}\/V\d+\/I\d+\/\d+|10\.\d{4,}\/[^"']+)|abstract\/abstract\d+\.shtml|article\/doi\/|paperDigest\.aspx|\/html\/\d+|ArticleDetail|article\/\d{4}\//i.test(href)) {
      try { out.add(new URL(href, base).href); } catch {}
    }
  }
  return [...out].slice(0, 3);
}
function robotsDisallowAll(txt) {
  if (!txt) return null;
  const lines = txt.split(/\r?\n/).map(l => l.trim());
  let star = false, all = false;
  for (const l of lines) { if (/^user-agent:\s*\*/i.test(l)) star = true; else if (/^user-agent:/i.test(l)) star = false; else if (star && /^disallow:\s*\/\s*$/i.test(l)) all = true; }
  return all;
}
const results = [];
for (const j of cfg) {
  const i = inv.find(x => x.id === j.id) || {};
  const home = i.homepage || j.homepage || '';
  const issn = j.issn || i.issn || '';
  const row = {id: j.id, title: j.title, issn, homepage: home};
  if (home) {
    const h = await get(home);
    row.home = {status: h.status, finalUrl: h.url, error: h.error, bytes: h.bytes, platform: platform(h.text, h.url),
      titleMatch: h.text ? h.text.includes(j.title) : null, issnOnPage: h.text ? h.text.includes(issn) : null,
      jsChallenge: h.text ? /enable javascript|captcha|验证码|滑动验证|TOKEN无效|acw_sc__v2|安全验证/i.test(h.text) : null,
      rssLinks: h.text ? [...new Set([...h.text.matchAll(/href=["']([^"']*(?:rss|feed|atom)[^"']*)["']/gi)].map(m => { try { return new URL(m[1], h.url).href } catch { return m[1] } }))].slice(0, 4) : [],
      oaiHint: h.text ? /oai[-_]?pmh|\/oai\?|verb=Identify/i.test(h.text) : null};
    let origin = ''; try { origin = new URL(h.url || home).origin; } catch {}
    if (origin) { const r = await get(origin + '/robots.txt', {accept: 'text/plain'}); row.robots = {status: r.status, disallowAll: r.status === 200 ? robotsDisallowAll(r.text) : null}; }
    const links = h.text ? articleLinks(h.text, h.url) : [];
    row.articleCandidates = links;
    if (links.length && row.robots?.disallowAll !== true) {
      const a = await get(links[0]);
      row.article = {url: links[0], status: a.status, error: a.error, platform: platform(a.text, a.url),
        citationTitle: a.text ? meta(a.text, 'citation_title').length > 0 : null,
        citationIssn: a.text ? meta(a.text, 'citation_issn')[0] || null : null,
        citationDate: a.text ? meta(a.text, 'citation_publication_date')[0] || meta(a.text, 'citation_date')[0] || null : null,
        citationDoi: a.text ? !!meta(a.text, 'citation_doi')[0] : null,
        descriptions: a.text ? meta(a.text, 'description').concat(meta(a.text, 'Description')).filter(Boolean).length : 0,
        zhAbstract: a.text ? /<meta[^>]+name=["']description["'][^>]+xml:lang=["']zh/i.test(a.text) || /摘要/.test(a.text) : null,
        enAbstract: a.text ? /<meta[^>]+name=["']description["'][^>]+xml:lang=["']en/i.test(a.text) || /Abstract/.test(a.text) : null,
        dcMeta: a.text ? /name=["']DC\./i.test(a.text) : null};
    }
  }
  if (issn) {
    const c = await get(`https://api.crossref.org/journals/${issn}/works?rows=5&sort=published&order=desc&select=DOI,title,published,abstract,type&mailto=fanscope-probe@example.invalid`, {accept: 'application/json'});
    try { const m = JSON.parse(c.text).message; row.crossref = {status: c.status, total: m['total-results'], latest: m.items?.[0]?.published?.['date-parts']?.[0]?.join('-') || null, withAbstractInLatest5: m.items?.filter(x => x.abstract).length ?? 0, sampleDoi: m.items?.[0]?.DOI || null}; }
    catch { row.crossref = {status: c.status, error: c.error || 'non-json'}; }
  }
  results.push(row);
  process.stderr.write(`${j.id} ${row.home?.status ?? '-'} ${row.home?.platform ?? ''} article:${row.article?.status ?? '-'} crossref:${row.crossref?.total ?? row.crossref?.status}\n`);
}
process.stdout.write(JSON.stringify({probedAt: new Date().toISOString(), userAgent: UA, results}, null, 2) + '\n');
