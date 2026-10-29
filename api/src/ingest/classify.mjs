// Document type and publication status classifier (pure, no I/O).
// Two independent dimensions, each record carries confidence and the rule ids
// that fired, so every statistic can be explained. DOI or journal name alone
// never makes a record a verified journal article.
export const CLASSIFIER_VERSION = 'doc-v1';

export const DOC_TYPES = ['research_article', 'review', 'short_communication', 'conference_abstract', 'conference_paper',
  'editorial', 'news', 'letter_comment', 'book_review', 'correction_retraction', 'protocol', 'preprint', 'other', 'unknown'];
export const PUB_STATUSES = ['issue_published', 'online_first', 'supplement', 'preprint', 'unknown'];

// Title rules are anchored to how the item is labelled, not to topic words.
const TITLE_RULES = [
  ['T-correction', 'correction_retraction', /^(?:(?:an?\s+)?(?:correction|corrigendum|erratum|errata)\b|retraction\b|retracted\b|notice of retraction|expression of concern|更正|勘误|撤稿)/i],
  ['T-editorial', 'editorial', /^(?:editorial\b|editor'?s?\s+(?:note|introduction)|guest editorial|introduction to (?:the|this) special (?:issue|section)|卷首语|编者按|主编寄语|编后记)/i],
  ['T-book-review', 'book_review', /^(?:book reviews?\b|review of\s|书评)|\bbook review\b/i],
  // Chinese tables of contents and notices often start with the journal name in 《》.
  ['T-news', 'news', /^(?:in memoriam\b|obituary\b|news\b|announcement\b|call for papers\b)|^(?:《[^》]{1,30}》\s*)?(?:\d{4}\s*年(?:度)?\s*)?(?:总目录|目录|征稿启事|征稿|启事|编辑部公告|公告|会议综述|学术会议综述)/i],
  ['T-letter', 'letter_comment', /^(?:letter to the editor|letters?\b|comment on\b|commentary on\b|response to\b|reply to\b|author'?s? reply)/i],
  ['T-protocol', 'protocol', /\bstudy protocol\b|\bprotocol for (?:a |an )?(?:randomi[sz]ed|systematic|scoping|cluster)/i],
];
const REVIEW_TITLE = /\b(?:systematic(?:\s+literature)?\s+review|scoping review|umbrella review|meta-analys[ie]s|narrative review|literature review|integrative review|rapid review)\b|综述|述评|研究进展|文献回顾|研究回顾/i;
const SESSION_TITLE = /^(?:session\s+\d+|symposium\b|poster\b)|\((?:symposium|poster|paper session)\)\s*$|^late[-\s]breaking/i;

const PROVIDER_TYPES = [
  // [normalised provider label, doc_type]
  ['posted content', 'preprint'], ['preprint', 'preprint'],
  ['proceedings article', 'conference_paper'], ['conference paper', 'conference_paper'],
  ['meeting abstract', 'conference_abstract'], ['conference abstract', 'conference_abstract'], ['proceedings abstract', 'conference_abstract'],
  ['research article', 'research_article'], ['original article', 'research_article'], ['original research', 'research_article'],
  ['review article', 'review'], ['review', 'review'], ['systematic review', 'review'], ['meta analysis', 'review'],
  ['brief report', 'short_communication'], ['short communication', 'short_communication'], ['research letter', 'short_communication'],
  ['editorial', 'editorial'], ['editorial material', 'editorial'], ['book review', 'book_review'],
  ['erratum', 'correction_retraction'], ['correction', 'correction_retraction'], ['retraction', 'correction_retraction'],
  ['published erratum', 'correction_retraction'], ['retraction of publication', 'correction_retraction'],
  ['letter', 'letter_comment'], ['comment', 'letter_comment'], ['news', 'news'], ['paratext', 'other'],
];
const norm = s => String(s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
// The previous classifier's explicit types are trusted only when they came from provider labels.
const LEGACY_TYPE = {original_research: 'research_article', review: 'review', conference_abstract: 'conference_abstract', editorial: 'editorial', book_review: 'book_review'};

function providerLabels(rec) {
  const out = [];
  const add = v => { if (Array.isArray(v)) v.forEach(add); else if (typeof v === 'string' && v.trim()) out.push(v); };
  add(rec.provider_types);
  for (const raw of [rec.article_type_evidence_json, rec.source_evidence_json]) {
    let e = raw;
    if (typeof raw === 'string') { try { e = JSON.parse(raw || '{}'); } catch { e = {}; } }
    if (e && typeof e === 'object') { add(e.raw_labels); add(e.raw_types); add(e.publication_types); add(e.type_evidence?.raw_labels); add(e.openalex_type); }
  }
  // Generic container labels say nothing about the kind of article.
  return [...new Set(out.map(norm))].filter(l => !['journal article', 'article', 'journal', 'text'].includes(l));
}

const isSupplement = rec => /suppl/i.test(`${rec.issue || ''} ${rec.volume || ''}`);

export function publicationStatus(rec, docType) {
  if (docType === 'preprint') return {pub_status: 'preprint', rule: 'S-preprint'};
  if (isSupplement(rec)) return {pub_status: 'supplement', rule: 'S-supplement'};
  const hasIssue = String(rec.volume || '').trim() && String(rec.issue || '').trim();
  if (hasIssue || String(rec.published_print_date || '').trim()) return {pub_status: 'issue_published', rule: hasIssue ? 'S-volume-issue' : 'S-print-date'};
  // Online version of record without an issue yet; a later issue assignment updates
  // the same row (same identity), so it is never counted twice.
  if (String(rec.published_online_date || '').trim()) return {pub_status: 'online_first', rule: 'S-online-date'};
  return {pub_status: 'unknown', rule: 'S-none'};
}

export function classifyRecord(rec = {}, policy = {}) {
  const title = String(rec.title || '').trim();
  const abstractLen = String(rec.abstract || '').trim().length;
  const rules = [];
  let doc_type = 'unknown', confidence = 'low';
  const set = (t, c, r) => { doc_type = t; confidence = c; rules.push(r); };
  const labels = providerLabels(rec);
  const providerTypes = [...new Set(labels.map(l => PROVIDER_TYPES.find(([k]) => k === l)?.[1]).filter(Boolean))];

  const titleRule = TITLE_RULES.find(([, , re]) => re.test(title));
  if (titleRule) set(titleRule[1], 'high', titleRule[0]);
  else if (policy.supplementPolicy === 'meeting_abstracts' && isSupplement(rec)) set('conference_abstract', 'high', 'J-supplement-meeting-abstracts');
  else if (providerTypes.length === 1) set(providerTypes[0], 'high', 'P-provider-type');
  else if (providerTypes.length > 1) { set('unknown', 'low', 'P-conflicting-provider-types'); }
  else if (LEGACY_TYPE[rec.article_type] && labels.length) set(LEGACY_TYPE[rec.article_type], 'high', 'P-legacy-explicit-type');
  else if (SESSION_TITLE.test(title)) set('conference_abstract', 'medium', 'H-session-title');
  else if (REVIEW_TITLE.test(title) && abstractLen >= 150) set('review', 'medium', 'H-review-title');
  else if (abstractLen >= 150 && title.length >= 12 && !isSupplement(rec)) set('research_article', 'medium', 'H-substantive-abstract-regular-issue');
  else if (abstractLen >= 150 && title.length >= 12 && isSupplement(rec) && policy.supplementPolicy === 'regular') set('research_article', 'medium', 'H-substantive-abstract-regular-supplement');
  else rules.push(abstractLen < 150 ? 'U-no-substantive-abstract' : 'U-unconfirmed-supplement');

  const status = publicationStatus(rec, doc_type);
  rules.push(status.rule);
  const identityVerified = rec.source_verification_status === 'verified';
  if (!identityVerified) rules.push('I-identity-unverified');
  const formal = ['research_article', 'review', 'short_communication'].includes(doc_type);
  // Default trends: formal articles, reasonably confirmed, from a verified journal identity.
  const default_scope = formal && confidence !== 'low' && identityVerified && ['issue_published', 'online_first', 'supplement'].includes(status.pub_status);
  const scope_group = default_scope ? (doc_type === 'review' ? 'review' : 'research')
    : ['conference_abstract', 'conference_paper'].includes(doc_type) ? 'conference'
    : doc_type === 'preprint' ? 'preprint'
    : doc_type === 'unknown' || (formal && !default_scope) ? 'unconfirmed' : 'non_research';
  return {doc_type, pub_status: status.pub_status, confidence, default_scope, scope_group, rules, version: CLASSIFIER_VERSION};
}
