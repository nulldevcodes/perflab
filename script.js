/* Pro Website Performance Analyzer (single-file frontend)
   - Much richer analytics & graphs using Chart.js (CDN)
   - Works best in "Analyze Current Page" mode (same-origin).
   - External URL mode uses a public CORS proxy (best-effort).
   - Author: PerfLab (you can modify freely)
*/

/* ---------- Utilities ---------- */
const $ = id => document.getElementById(id);
const statusEl = $('status');
const setStatus = (s) => { statusEl.textContent = s; };

const ms = n => (n === undefined || n === null) ? '-' : Math.round(n * 100) / 100;
const kb = bytes => (bytes === null || bytes === undefined || bytes === 0) ? '-' : Math.round(bytes / 1024 * 100) / 100;

function safeText(s, len = 200) { if (!s) return ''; return (s + '').slice(0, len); }
function downloadBlob(filename, blob) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); }

/* ---------- DOM refs ---------- */
const modeEl = $('mode');
const urlRow = $('urlRow');
const urlInput = $('urlInput');
const analyzeBtn = $('analyzeBtn');
const clearBtn = $('clearBtn');
const exportJsonBtn = $('exportJson');
const exportCsvBtn = $('exportCsv');
const themeToggle = $('themeToggle');

const summaryCard = $('summaryCard');
const chartsCard = $('chartsCard');
const waterfallCard = $('waterfallCard');
const resourcesCard = $('resourcesCard');
const rawCard = $('rawCard');

const summaryUrl = $('summaryUrl');
const summaryReqs = $('summaryReqs');
const summaryBytes = $('summaryBytes');
const summaryTTFB = $('summaryTTFB');
const summaryLCP = $('summaryLCP');
const summaryCLS = $('summaryCLS');
const summaryFID = $('summaryFID');
const summaryLongTasks = $('summaryLongTasks');
const perfScoreEl = $('perfScore');
const suggestionsEl = $('suggestions');

const cumBytesCanvas = $('cumBytesChart');
const topSlowCanvas = $('topSlowChart');
const typePieCanvas = $('typePieChart');
const protocolCanvas = $('protocolChart');

const waterfallWrap = $('waterfallWrap');
const resourcesTableBody = $('resourcesTable').querySelector('tbody');
const rawOut = $('rawOut');
const searchResource = $('searchResource');
const copyUrlsBtn = $('copyUrls');

let charts = {}; // hold Chart.js instances

modeEl.addEventListener('change', () => {
  if (modeEl.value === 'external') urlRow.classList.remove('hidden');
  else urlRow.classList.add('hidden');
});

/* ---------- Perf Observers for current page ---------- */
let lcp = null, cls = 0, fid = null;
let lcpObserver, clsObserver, fidObserver, longTaskObserver;
let longTasks = [];

function setupObservers(collectLongTasks = true) {
  // reset
  lcp = null; cls = 0; fid = null; longTasks = [];

  if ('PerformanceObserver' in window) {
    try {
      lcpObserver = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          lcp = e.startTime || e.renderTime || lcp;
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) { /* ignore */ }

    try {
      clsObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) cls += entry.value;
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch (e) { /* ignore */ }

    try {
      fidObserver = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (e.name === 'first-input') {
            fid = (e.processingStart - e.startTime);
          }
        }
      });
      fidObserver.observe({ type: 'first-input', buffered: true });
    } catch (e) { /* ignore */ }

    if (collectLongTasks) {
      try {
        longTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            longTasks.push({ name: entry.name || 'longtask', start: entry.startTime, duration: entry.duration });
          }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: true });
      } catch (e) { /* ignore */ }
    }
  }
}

/* ---------- Analysis (current page) ---------- */
async function analyzeCurrent() {
  setStatus('Collecting performance entries (current page)...');
  setupObservers($('collectLongTasks').checked);

  // small wait to collect paint/LCP
  await new Promise(r => setTimeout(r, 200));

  const navEntries = performance.getEntriesByType('navigation') || [];
  const nav = navEntries.length ? navEntries[0].toJSON ? navEntries[0] : navEntries[0] : null;
  const paints = performance.getEntriesByType('paint') || [];
  const resources = performance.getEntriesByType('resource') || [];

  // long tasks are already in longTasks
  renderReport({
    mode: 'current',
    url: location.href,
    title: document.title || '',
    nav,
    paints,
    resources,
    lcp,
    cls,
    fid,
    longTasks,
  });
}

/* ---------- Analysis (external URL) ---------- */
async function analyzeExternal(url) {
  if (!url) { alert('Enter external URL'); return; }
  setStatus('Fetching external HTML via proxy (best-effort)...');
  const proxy = 'https://api.allorigins.win/raw?url=';
  const target = proxy + encodeURIComponent(url);

  try {
    const t0 = performance.now();
    const resp = await fetch(target, { mode: 'cors' });
    const t1 = performance.now();
    if (!resp.ok) throw new Error('Proxy fetch failed: ' + resp.status);
    const html = await resp.text();
    const t2 = performance.now();

    // parse HTML to find static resource URLs
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const base = new URL(url).origin;
    const tags = [];
    doc.querySelectorAll('img[src], script[src], link[rel="stylesheet"][href]').forEach(el => {
      const attr = el.tagName.toLowerCase() === 'link' ? el.getAttribute('href') : (el.getAttribute('src') || el.getAttribute('href'));
      if (attr && !attr.trim().startsWith('data:')) {
        try { tags.push(new URL(attr, base).href); } catch (e) { /* ignore */ }
      }
    });

    // fetch resources via proxy (limited)
    setStatus(`Fetching ${tags.length} resources via proxy (may be slow)...`);
    const resources = [];
    const limit = 6;
    for (let i = 0; i < tags.length; i += limit) {
      const chunk = tags.slice(i, i + limit);
      const promises = chunk.map(async u => {
        const t3 = performance.now();
        try {
          const r = await fetch(proxy + encodeURIComponent(u));
          const t4 = performance.now();
          if (!r.ok) throw new Error('failed');
          const blob = await r.blob();
          const size = blob.size;
          return { name: u, startTime: ms(t3 - t0), duration: ms(t4 - t3), transferSize: size, nextHopProtocol: r.headers.get('x-proxy-protocol') || 'unknown' };
        } catch (e) {
          return { name: u, startTime: ms(performance.now() - t0), duration: '-', transferSize: null, error: true };
        }
      });
      const res = await Promise.all(promises);
      resources.push(...res);
    }

    // create pseudo-nav
    const nav = { startTime: 0, responseStart: ms(t1 - t0), responseEnd: ms(t2 - t0), decodedBodySize: new TextEncoder().encode(html).length };

    renderReport({
      mode: 'external',
      url,
      title: doc.querySelector('title') ? doc.querySelector('title').innerText : '',
      nav,
      paints: [],
      resources,
      lcp: null, cls: null, fid: null, longTasks: []
    });
  } catch (err) {
    console.error(err);
    alert('External analysis failed: ' + (err.message || err));
    setStatus('External analysis failed');
  }
}

/* ---------- Rendering report & visuals ---------- */
function renderReport(report) {
  setStatus('Rendering report...');
  // show main sections
  summaryCard.classList.remove('hidden');
  chartsCard.classList.remove('hidden');
  waterfallCard.classList.remove('hidden');
  resourcesCard.classList.remove('hidden');
  rawCard.classList.remove('hidden');

  // Basic summary
  summaryUrl.textContent = safeText(report.url, 160);
  summaryReqs.textContent = (report.resources && report.resources.length) ? report.resources.length : 0;
  // compute total bytes
  let totalBytes = 0;
  (report.resources || []).forEach(r => {
    const size = r.transferSize || r.encodedBodySize || r.decodedBodySize || r.size || r.transfer || 0;
    totalBytes += (size || 0);
  });
  summaryBytes.textContent = (totalBytes ? kb(totalBytes) + ' KB' : '-');
  summaryTTFB.textContent = report.nav ? ms(report.nav.responseStart || report.nav.responseStart) : '-';
  summaryLCP.textContent = report.lcp ? ms(report.lcp) : '-';
  summaryCLS.textContent = (report.cls !== null && report.cls !== undefined) ? report.cls.toFixed ? report.cls.toFixed(3) : report.cls : '-';
  summaryFID.textContent = report.fid ? ms(report.fid) : '-';
  summaryLongTasks.textContent = (report.longTasks && report.longTasks.length) ? report.longTasks.length : 0;

  // Performance score (simple heuristic)
  const score = computeScore({ nav: report.nav, lcp: report.lcp, cls: report.cls, fid: report.fid, totalBytes, reqs: (report.resources || []).length, longTasks: (report.longTasks || []).length });
  perfScoreEl.textContent = Math.round(score);
  perfScoreEl.style.background = score > 80 ? 'linear-gradient(90deg,#34d399,#60a5fa)' : (score > 50 ? 'linear-gradient(90deg,#f59e0b,#f97316)' : 'linear-gradient(90deg,#ef4444,#f43f5e)');

  // Suggestions (heuristics)
  const suggestions = [];
  if ((report.resources || []).length > 60) suggestions.push(`High number of requests (${(report.resources || []).length}). Consider bundling and reducing 3rd-party scripts.`);
  if (totalBytes > 1024 * 300) suggestions.push(`Large total transfer (${kb(totalBytes)} KB). Optimize images, enable gzip/brotli, and use caching.`);
  if (report.lcp && report.lcp > 2500) suggestions.push(`LCP is ${ms(report.lcp)} ms — optimize hero content and server latency to reach < 2.5s.`);
  if (report.cls && report.cls > 0.1) suggestions.push(`CLS is ${report.cls.toFixed(3)} — reserve image sizes and avoid layout shifts.`);
  if ((report.longTasks || []).length > 0) suggestions.push(`${report.longTasks.length} long task(s) detected — break up heavy JS work, use web workers.`);
  if (suggestions.length === 0) suggestions.push('No major heuristics flagged. Still consider compression, caching and lazy-loading.');

  suggestionsEl.innerHTML = '<ul>' + suggestions.map(s => `<li>${s}</li>`).join('') + '</ul>';

  // Charts: cumulative bytes timeline, top slow, type pie, protocol chart
  buildCharts(report);

  // Waterfall: render bars
  buildWaterfall(report);

  // Resources table
  buildResourcesTable(report);

  // raw JSON
  rawOut.textContent = JSON.stringify(report, null, 2);

  // store lastReport for export
  window.lastReport = report;

  setStatus('Done');
}

/* ---------- Score calculation ---------- */
function computeScore({ nav, lcp, cls, fid, totalBytes, reqs, longTasks }) {
  // start 100 and subtract weighted penalties
  let s = 100;
  if (lcp) s -= Math.max(0, (lcp - 2500) / 50); // heavy penalty after 2.5s
  if (cls) s -= Math.min(30, cls * 100);
  if (fid) s -= Math.min(20, fid / 50);
  if (reqs) s -= Math.min(25, (reqs - 20) / 2);
  if (totalBytes) s -= Math.min(30, totalBytes / (1024 * 50)); // each 50KB reduces score
  if (longTasks) s -= Math.min(30, longTasks * 5);
  s = Math.max(10, Math.round(s));
  return s;
}

/* ---------- Charts using Chart.js ---------- */
function buildCharts(report) {
  // prepare resource rows (normalize)
  const res = (report.resources || []).map((r, idx) => {
    // handle PerformanceResourceTiming entries or proxy results
    if (r && r.name) r.url = r.name;
    const url = r.name || r.url || r.name || r.resource || r.url || '';
    const duration = Number(r.duration || r.responseEnd - r.startTime || r.duration || 0) || 0;
    const start = Number(r.startTime || 0) || 0;
    const transfer = Number(r.transferSize || r.encodedBodySize || r.decodedBodySize || r.size || r.transfer || 0) || 0;
    const type = r.initiatorType || (url.match(/\.(js|css|png|jpg|jpeg|svg|webp|gif)/i) ? (url.match(/\.js/i) ? 'script' : (url.match(/\.css/i) ? 'css' : 'image')) : (r.type || 'other'));
    const protocol = r.nextHopProtocol || r.nextHopProtocol || (r.protocol || 'unknown');
    return { idx, url, duration, start, transfer, type, protocol, r };
  });

  // cumulative bytes over time (bucketed)
  const sortedByStart = [...res].sort((a, b) => a.start - b.start);
  const buckets = [];
  let acc = 0;
  let lastT = 0;
  sortedByStart.forEach(x => {
    const t = Math.round(x.start);
    if (t - lastT > 200) {
      buckets.push({ t: lastT, v: acc });
      lastT = t;
    }
    acc += x.transfer;
    buckets.push({ t, v: acc });
    lastT = t;
  });
  // ensure at least one point
  if (buckets.length === 0) buckets.push({ t: 0, v: 0 });

  // Cumulative Bytes Chart
  const cumLabels = buckets.map(b => b.t);
  const cumData = buckets.map(b => Math.round(b.v / 1024 * 100) / 100); // KB
  if (charts.cum) charts.cum.destroy();
  charts.cum = new Chart(cumBytesCanvas, {
    type: 'line',
    data: { labels: cumLabels, datasets: [{ label: 'Cumulative KB', data: cumData, fill: true }]},
    options: { plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'Start time (ms)' } }, y: { title: { display: true, text: 'KB' } } } }
  });

  // Top slow resources
  const topSlow = [...res].sort((a, b) => b.duration - a.duration).slice(0, 8);
  if (charts.topSlow) charts.topSlow.destroy();
  charts.topSlow = new Chart(topSlowCanvas, {
    type: 'bar',
    data: { labels: topSlow.map(r => safeText(r.url, 40)), datasets: [{ label: 'Duration ms', data: topSlow.map(r => ms(r.duration)) }]},
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'ms' } } } }
  });

  // Type distribution
  const typeCounts = {};
  res.forEach(r => typeCounts[r.type] = (typeCounts[r.type] || 0) + 1);
  const tLabels = Object.keys(typeCounts);
  const tData = tLabels.map(k => typeCounts[k]);
  if (charts.typePie) charts.typePie.destroy();
  charts.typePie = new Chart(typePieCanvas, {
    type: 'pie',
    data: { labels: tLabels, datasets: [{ data: tData }]},
    options: { plugins: { legend: { position: 'right' } } }
  });

  // Protocols
  const protoCounts = {};
  res.forEach(r => protoCounts[r.protocol || 'unknown'] = (protoCounts[r.protocol || 'unknown'] || 0) + 1);
  const pLabels = Object.keys(protoCounts);
  const pData = pLabels.map(k => protoCounts[k]);
  if (charts.proto) charts.proto.destroy();
  charts.proto = new Chart(protocolCanvas, {
    type: 'doughnut',
    data: { labels: pLabels, datasets: [{ data: pData }]},
    options: { plugins: { legend: { position: 'right' } } }
  });
}

/* ---------- Waterfall rendering (simple CSS bars) ---------- */
function buildWaterfall(report) {
  waterfallWrap.innerHTML = '';
  const res = (report.resources || []).map((r, idx) => {
    if (r && r.name) r.url = r.name;
    const url = r.name || r.url || '';
    const start = Number(r.startTime || 0) || 0;
    const dur = Number(r.duration || r.responseEnd - r.startTime || 0) || 0;
    const transfer = Number(r.transferSize || r.encodedBodySize || r.decodedBodySize || r.size || 0) || 0;
    return { idx, url, start, dur, transfer, raw: r };
  }).sort((a, b) => a.start - b.start);

  if (res.length === 0) {
    waterfallWrap.innerHTML = '<div class="mono">No resources to show</div>';
    return;
  }

  const maxEnd = Math.max(...res.map(r => r.start + r.dur), 1);
  const containerWidth = 900; // virtual scale
  res.forEach((r, i) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'wf-item';
    const left = document.createElement('div');
    left.style.width = '42%';
    left.innerHTML = `<div class="mono">${safeText(r.url, 80)}</div><div style="color:var(--muted);font-size:12px">${kb(r.transfer)} KB</div>`;
    const right = document.createElement('div');
    right.style.width = '58%';
    const barWrap = document.createElement('div');
    barWrap.style.position = 'relative';
    barWrap.style.height = '28px';
    barWrap.style.background = 'rgba(255,255,255,0.01)';
    barWrap.style.borderRadius = '6px';
    barWrap.style.overflow = 'hidden';
    const bar = document.createElement('div');
    const leftPct = (r.start / maxEnd) * 100;
    const widthPct = (r.dur / maxEnd) * 100;
    bar.className = 'wf-bar';
    bar.style.position = 'absolute';
    bar.style.left = leftPct + '%';
    bar.style.width = Math.max(0.2, widthPct) + '%';
    bar.title = `start: ${ms(r.start)} ms\nduration: ${ms(r.dur)} ms`;
    barWrap.appendChild(bar);
    right.appendChild(barWrap);
    wrapper.appendChild(left);
    wrapper.appendChild(right);
    waterfallWrap.appendChild(wrapper);
  });
}

/* ---------- Resources table ---------- */
function buildResourcesTable(report) {
  resourcesTableBody.innerHTML = '';
  const res = (report.resources || []).map((r, idx) => {
    if (r && r.name) r.url = r.name;
    const url = r.name || r.url || '';
    const dur = Number(r.duration || r.responseEnd - r.startTime || 0) || 0;
    const start = Number(r.startTime || 0) || 0;
    const transfer = Number(r.transferSize || r.encodedBodySize || r.decodedBodySize || r.size || 0) || 0;
    const protocol = r.nextHopProtocol || r.protocol || r.rtt || 'unknown';
    // DNS/TCP/SSL/Req/Res breakdown if available (PerformanceResourceTiming)
    let detail = '-';
    if (r.domainLookupStart !== undefined) {
      const dns = (r.domainLookupEnd - r.domainLookupStart) || 0;
      const tcp = (r.connectEnd - r.connectStart) || 0;
      const ssl = (r.secureConnectionStart > 0) ? (r.connectEnd - r.secureConnectionStart) : 0;
      const req = (r.responseStart - r.requestStart) || 0;
      const resTime = (r.responseEnd - r.responseStart) || 0;
      detail = `${ms(dns)}/${ms(tcp)}/${ms(ssl)}/${ms(req)}/${ms(resTime)}`;
    }
    return { url, type: r.initiatorType || '-', protocol, start, dur, transfer, detail };
  }).sort((a, b) => b.dur - a.dur);

  res.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i+1}</td>
      <td title="${safeText(r.url, 400)}" class="mono">${safeText(r.url, 80)}</td>
      <td>${r.type}</td>
      <td>${r.protocol}</td>
      <td>${ms(r.start)}</td>
      <td>${ms(r.dur)}</td>
      <td>${r.transfer ? kb(r.transfer) : '-'}</td>
      <td>${r.detail}</td>`;
    resourcesTableBody.appendChild(tr);
  });
}

/* ---------- Export functions ---------- */
exportJsonBtn.addEventListener('click', () => {
  if (!window.lastReport) { alert('No report yet'); return; }
  const blob = new Blob([JSON.stringify(window.lastReport, null, 2)], { type: 'application/json' });
  downloadBlob('perf-report.json', blob);
});

exportCsvBtn.addEventListener('click', () => {
  if (!window.lastReport) { alert('No report yet'); return; }
  const rows = ['#,URL,Type,Protocol,Start_ms,Duration_ms,Size_bytes,Detail'];
  (window.lastReport.resources || []).forEach((r, i) => {
    const url = (r.name || r.url || '').replace(/,/g, ' ');
    const type = r.initiatorType || '-';
    const proto = r.nextHopProtocol || r.protocol || '-';
    const start = ms(r.startTime || 0);
    const dur = ms(r.duration || 0);
    const size = r.transferSize || r.encodedBodySize || r.decodedBodySize || r.size || 0;
    const detail = '-';
    rows.push(`${i+1},${url},${type},${proto},${start},${dur},${size},${detail}`);
  });
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  downloadBlob('resources.csv', blob);
});

/* ---------- UI helpers ---------- */
clearBtn.addEventListener('click', () => {
  summaryCard.classList.add('hidden');
  chartsCard.classList.add('hidden');
  waterfallCard.classList.add('hidden');
  resourcesCard.classList.add('hidden');
  rawCard.classList.add('hidden');
  resourcesTableBody.innerHTML = '';
  waterfallWrap.innerHTML = '';
  rawOut.textContent = '{}';
  setStatus('Ready');
  window.lastReport = null;
});

analyzeBtn.addEventListener('click', async () => {
  // reset UI
  setStatus('Starting analysis...');
  summaryCard.classList.add('hidden');
  chartsCard.classList.add('hidden');
  waterfallCard.classList.add('hidden');
  resourcesCard.classList.add('hidden');
  rawCard.classList.add('hidden');
  resourcesTableBody.innerHTML = '';
  waterfallWrap.innerHTML = '';
  rawOut.textContent = '{}';
  suggestionsEl.innerHTML = '';

  const mode = modeEl.value;
  if (mode === 'current') {
    try { await analyzeCurrent(); } catch (e) { console.error(e); alert('Error: ' + e.message); setStatus('Error'); }
  } else {
    const url = urlInput.value.trim();
    try { new URL(url); } catch (e) { alert('Invalid URL'); setStatus('Ready'); return; }
    await analyzeExternal(url);
  }
});

/* search resource */
searchResource && searchResource.addEventListener('input', (e) => {
  const q = (e.target.value || '').toLowerCase();
  Array.from(resourcesTableBody.querySelectorAll('tr')).forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

/* copy urls */
copyUrlsBtn && copyUrlsBtn.addEventListener('click', () => {
  const urls = Array.from(resourcesTableBody.querySelectorAll('tr')).map(tr => tr.querySelector('td.mono')?.textContent || '').filter(Boolean);
  if (urls.length === 0) { alert('No URLs'); return; }
  navigator.clipboard.writeText(urls.join('\n')).then(() => alert('Copied ' + urls.length + ' URLs'));
});

/* theme toggle */
themeToggle.addEventListener('click', () => {
  document.documentElement.classList.toggle('theme-light');
});

/* ---------- init ---------- */
setStatus('Ready — choose mode and click "Run Analysis"');
// Optionally auto-run analyzeCurrent when opened from the same host — commented to avoid surprise
// setupObservers(); analyzeCurrent();

