import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {classifyRecord,publicationStatus,DOC_TYPES,PUB_STATUSES,CLASSIFIER_VERSION} from '../src/ingest/classify.mjs';
const policies=JSON.parse(fs.readFileSync(new URL('../config/journal-policies.json',import.meta.url),'utf8')).journals;
const abstract='This study uses three waves of national panel survey data to examine how pension reform affected the labour supply of older rural residents, using a difference-in-differences design.';
const base={title:'Pension reform and labour supply among older rural residents',abstract,volume:'12',issue:'3',published_online_date:'2026-03-01',source_verification_status:'verified'};

test('meeting-abstract supplements are conference abstracts only for journals with that policy',()=>{
 const iia={...base,issue:'Supplement_1',title:'Caregiver burden and respite use'};
 const r=classifyRecord(iia,policies['candidate-21']);
 assert.equal(r.doc_type,'conference_abstract');assert.equal(r.confidence,'high');assert.equal(r.default_scope,false);assert.equal(r.scope_group,'conference');
 assert.ok(r.rules.includes('J-supplement-meeting-abstracts'));
 // A thematic supplement elsewhere is not assumed to be abstracts, nor assumed to be research.
 const other=classifyRecord({...iia},{});
 assert.equal(other.doc_type,'unknown');assert.equal(other.scope_group,'unconfirmed');assert.equal(other.default_scope,false);
 const regular=classifyRecord({...iia},{supplementPolicy:'regular'});
 assert.equal(regular.doc_type,'research_article');assert.equal(regular.pub_status,'supplement');assert.equal(regular.default_scope,true);
});

test('online first counts once and moves to issue_published when the issue is assigned',()=>{
 const online=classifyRecord({...base,volume:'',issue:''});
 assert.equal(online.pub_status,'online_first');assert.equal(online.default_scope,true);
 const issued=classifyRecord({...base});
 assert.equal(issued.pub_status,'issue_published');assert.equal(issued.default_scope,true);
 assert.equal(publicationStatus({published_print_date:'2026-05-01'},'research_article').pub_status,'issue_published');
 assert.equal(publicationStatus({},'research_article').pub_status,'unknown');
});

test('reviews are formal articles but grouped separately from original research',()=>{
 const r=classifyRecord({...base,title:'Long-term care insurance and health: a systematic review and meta-analysis'});
 assert.equal(r.doc_type,'review');assert.equal(r.scope_group,'review');assert.equal(r.default_scope,true);
 const zh=classifyRecord({...base,title:'中国长期护理保险研究进展与展望',abstract:'本文系统梳理了近十年长期护理保险试点政策的研究文献，从制度设计、筹资机制、服务供给与政策效果四个方面总结已有研究的主要发现与不足，并提出未来研究方向。'.repeat(2)});
 assert.equal(zh.doc_type,'review');
});

test('non-research items are excluded by explicit labelling, in English and Chinese',()=>{
 for(const [title,type] of [['Correction to: Pension reform and labour supply','correction_retraction'],['Editorial: Ageing societies','editorial'],['Book review: The Welfare State','book_review'],['In memoriam: A scholar','news'],['Response to Smith et al.','letter_comment'],['编者按','editorial'],['《社会》2025年总目录','other']]){
  const r=classifyRecord({...base,title});
  if(type==='other'){assert.notEqual(r.default_scope,true,title);continue;}
  assert.equal(r.doc_type,type,title);assert.equal(r.default_scope,false,title);assert.equal(r.confidence,'high',title);
 }
});

test('provider types are used when explicit, and conflicts stay unconfirmed',()=>{
 assert.equal(classifyRecord({...base,provider_types:['posted-content']}).doc_type,'preprint');
 assert.equal(classifyRecord({...base,provider_types:['posted-content']}).pub_status,'preprint');
 assert.equal(classifyRecord({...base,provider_types:['proceedings-article']}).scope_group,'conference');
 assert.equal(classifyRecord({...base,source_evidence_json:JSON.stringify({publication_types:['Journal Article','Research Article']})}).rules.includes('P-provider-type'),true);
 const conflict=classifyRecord({...base,provider_types:['Review','Research Article']});
 assert.equal(conflict.doc_type,'unknown');assert.equal(conflict.default_scope,false);
 // Generic container labels are not evidence.
 assert.ok(classifyRecord({...base,provider_types:['journal-article']}).rules.includes('H-substantive-abstract-regular-issue'));
});

test('a DOI or journal name alone never makes a verified journal article',()=>{
 const bare=classifyRecord({title:'Ageing and care in East Asia',doi:'10.1234/x',journal_title:'Social Science & Medicine',volume:'1',issue:'1',source_verification_status:'verified'});
 assert.equal(bare.doc_type,'unknown');assert.equal(bare.default_scope,false);assert.ok(bare.rules.includes('U-no-substantive-abstract'));
 const unverified=classifyRecord({...base,source_verification_status:'unverified'});
 assert.equal(unverified.default_scope,false);assert.equal(unverified.scope_group,'unconfirmed');assert.ok(unverified.rules.includes('I-identity-unverified'));
});

test('conference session titles are recognised as conference abstracts',()=>{
 const r=classifyRecord({...base,title:'SESSION 1234 (SYMPOSIUM): Family caregiving across the life course'});
 assert.equal(r.doc_type,'conference_abstract');assert.equal(r.default_scope,false);
});

test('outputs stay within the declared vocabularies and carry a version',()=>{
 for(const rec of [base,{},{title:'x'},{...base,issue:'Suppl 2'},{...base,provider_types:['news']}]){
  const r=classifyRecord(rec,{});assert.ok(DOC_TYPES.includes(r.doc_type));assert.ok(PUB_STATUSES.includes(r.pub_status));
  assert.ok(['high','medium','low'].includes(r.confidence));assert.equal(r.version,CLASSIFIER_VERSION);assert.ok(r.rules.length>=1);
 }
});
