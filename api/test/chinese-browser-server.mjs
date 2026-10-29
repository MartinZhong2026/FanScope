// New isolated browser DB only; real public metadata + labelled synthetic controls.
// This local workbench fixture must never be mistaken for a production entry.
if(process.env.NODE_ENV==='production')throw Error('Chinese browser fixture refuses production NODE_ENV');
process.env.CHINESE_AUTH_IMPORT_ENABLED='false';
await import('./mobile-browser-server.mjs');
const fs=await import('node:fs');const {db}=await import('../src/db.mjs');
const {citationArticle,importChinese}=await import('../src/chinese-ingestion.mjs');
// Remove the mobile suite's synthetic Chinese controls so acceptance shows actual metadata.
db.prepare("DELETE FROM articles WHERE market='chinese'").run();
db.prepare("UPDATE journals SET issn='1000-6087' WHERE id='candidate-1'").run();
const j=db.prepare("SELECT * FROM journals WHERE id='candidate-1'").get(),url='https://rkyj.ruc.edu.cn/CN/Y2026/V50/I5/3';
const a=citationArticle(fs.readFileSync(new URL('./fixtures/chinese-official-2026.html',import.meta.url),'utf8'),j,url);
importChinese({journalId:j.id,items:[a],authorized:true,evidenceUrl:url});
console.log('Chinese acceptance: one real, public metadata record; no AI calls.');
