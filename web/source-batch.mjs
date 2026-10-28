// Browser-only orchestration. The existing protected API independently verifies
// Crossref ISSN, journal identity and DOI evidence before changing journal state.
export function pendingEnglishSources(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter(j => j.market === 'international' && !j.enabled)
    .map(j => ({
      id: String(j.id || ''),
      title: String(j.title || j.id || ''),
      issn: String(j.issn || j.candidate_issn || '').trim().toUpperCase()
    }));
}

export async function activatePendingEnglishSources({
  items = [], submit, onProgress = () => {}, isCancelled = () => false, delayMs = 850
} = {}) {
  if (typeof submit !== 'function') throw new TypeError('A submit function is required');
  const targets = pendingEnglishSources(items);
  const report = {total: targets.length, processed: 0, activated: 0, failed: 0,
    skipped: 0, failures: [], cancelled: false, unauthorized: false};
  onProgress({...report, failures: []});
  for (let index = 0; index < targets.length; index++) {
    if (isCancelled()) { report.cancelled = true; break; }
    const target = targets[index];
    if (!/^\d{4}-\d{3}[\dX]$/.test(target.issn)) {
      report.skipped++;
      report.failures.push({title: target.title, message: '缺少有效格式的候选 ISSN，请人工核对'});
    } else {
      try {
        const result = await submit(target);
        if (!result?.verified || !result?.enabled)
          throw new Error('ISSN、期刊名称或 DOI 来源核验未通过；保留待配置');
        report.activated++;
      } catch (error) {
        report.failed++;
        report.failures.push({title: target.title,
          message: String(error?.message || '来源请求失败').slice(0, 240)});
        if (error?.status === 401 || error?.status === 403)
          report.unauthorized = true;
      }
    }
    report.processed++;
    onProgress({...report, failures: [...report.failures]});
    if (report.unauthorized) break;
    if (index < targets.length - 1 && !isCancelled() && delayMs > 0)
      await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (isCancelled() && report.processed < report.total) report.cancelled = true;
  onProgress({...report, failures: [...report.failures]});
  return report;
}
