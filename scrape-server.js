/**
 * Job Search Ledger — local scrape helper
 * -----------------------------------------
 * Runs a tiny local server that fetches a job posting URL on your behalf
 * (server-side, so no CORS restriction applies) and pulls out whatever
 * structured data it can find: role, company, location, salary, notes.
 *
 * Run it with:   node scrape-server.js
 * Leave it running in a terminal window while you use the board.
 * Stop it any time with Ctrl+C.
 *
 * No dependencies beyond Node itself (18+, for global fetch).
 */

const http = require('http');

const PORT = 8787;

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMeta(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

// Recursively search a parsed JSON-LD object/array for a JobPosting node.
function findJobPosting(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('JobPosting')) return node;
    if (node['@graph']) return findJobPosting(node['@graph']);
    return null;
  }
  return null;
}

function locationFromJobPosting(jp) {
  if (jp.jobLocationType === 'TELECOMMUTE') return 'Remote';
  const loc = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
  const addr = loc && loc.address;
  if (!addr) return '';
  const city = addr.addressLocality || '';
  const region = addr.addressRegion || '';
  return [city, region].filter(Boolean).join(', ');
}

function salaryFromJobPosting(jp) {
  const sal = jp.baseSalary;
  if (!sal) return '';
  const val = sal.value || sal;
  const currency = sal.currency || '$';
  const symbol = currency === 'USD' ? '$' : currency;
  if (val.minValue && val.maxValue) {
    return `${symbol}${Number(val.minValue).toLocaleString()} - ${symbol}${Number(val.maxValue).toLocaleString()}`;
  }
  if (val.value) return `${symbol}${Number(val.value).toLocaleString()}`;
  return '';
}

// Formats one amount from a matched salary string ("$230,000", "230K",
// "95.50") into "$230,000" style — expanding a K-suffix to thousands.
function formatOneSalaryAmount(piece) {
  const m = piece.match(/\$?\s?([\d,]+(?:\.\d+)?)\s*([kK]?)/);
  if (!m) return '';
  let num = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(num)) return '';
  if (m[2]) num *= 1000;
  return '$' + num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Normalizes a raw salary match ("230K-350K Annually", "$95.50 - $110/hr")
// into the same "$X - $Y" shape salaryFromJobPosting produces, keeping any
// trailing cadence word (Annually, per hour, ...) rather than dropping it.
function normalizeSalaryText(raw) {
  const cadenceMatch = raw.match(/(annually|per\s*annum|per\s*year|a\s*year|\/\s*yr|per\s*hour|\/\s*hr|an\s*hour)\s*$/i);
  const cadence = cadenceMatch ? ' ' + cadenceMatch[0].trim().replace(/^\w/, c => c.toUpperCase()) : '';
  const numsPart = cadenceMatch ? raw.slice(0, cadenceMatch.index) : raw;
  const pieces = numsPart.split(/-|–|—|\bto\b/i).map(s => s.trim()).filter(Boolean);
  const formatted = pieces.map(formatOneSalaryAmount).filter(Boolean);
  if (formatted.length === 2) return `${formatted[0]} - ${formatted[1]}${cadence}`;
  if (formatted.length === 1) return `${formatted[0]}${cadence}`;
  return raw.trim();
}

// Last-resort salary extraction straight from the page's visible text.
// Several boards (Built In among them) never put baseSalary in JSON-LD or
// even in a meta tag — the range only ever appears as plain rendered text
// like "230K-350K Annually", with no $ and no structured markup at all —
// so this scans the stripped body text itself rather than metadata.
// Ordered most-specific-first so a well-formed "$X - $Y" range is
// preferred over accidentally matching a single bare number elsewhere on
// the page.
const SALARY_TEXT_PATTERNS = [
  // "$95,000 - $120,000" / "$95K - $120K" / with "/yr", "per year", etc.
  /\$\s?\d[\d,]*(?:\.\d+)?\s*[kK]?\s*(?:-|–|—|to)\s*\$?\s?\d[\d,]*(?:\.\d+)?\s*[kK]?(?:\s*(?:\/\s*(?:yr|hr)|per\s*(?:year|hour|annum)|annually|a\s*year|an\s*hour))?/i,
  // Bare "230K-350K Annually" — no $ sign anywhere, K-suffixed range.
  /\b\d[\d,]*(?:\.\d+)?\s*[kK]\s*(?:-|–|—|to)\s*\d[\d,]*(?:\.\d+)?\s*[kK]\b(?:\s*(?:annually|per\s*year|a\s*year|\/\s*yr))?/i,
  // Single value, e.g. "$120,000 per year" (must carry a cadence word so a
  // stray dollar amount elsewhere on the page — a benefits figure, say —
  // isn't mistaken for a salary).
  /\$\s?\d[\d,]*(?:\.\d+)?\s*[kK]?\s*(?:\/\s*(?:yr|hr)|per\s*(?:year|hour|annum)|annually|an?\s*(?:year|hour))/i
];
function salaryFromBodyText(text) {
  for (const re of SALARY_TEXT_PATTERNS) {
    const m = text.match(re);
    if (m) return normalizeSalaryText(m[0]);
  }
  return '';
}

// Many boards standardize their meta description as a single templated
// sentence — Built In's is "<Company> is hiring for a <Title> in
// <Location>. Find more details..." — which names the actual hiring
// company explicitly and unambiguously. That beats trying to split it out
// of the <title> tag, which usually also carries the job board's own
// branding (see splitTitleRoleCompany below) and has no reliable
// separator between "which dash is the title's own punctuation" and
// "which dash introduces the company".
function detailsFromHiringDescription(desc) {
  if (!desc) return null;
  const m = desc.match(/^([A-Z][A-Za-z0-9&.,'’\-\s]{1,60}?)\s+is hiring (?:for )?(?:an?\s+)?.*?\s+in\s+([A-Za-z][A-Za-z0-9.,'’\-\s]{1,60}?)\.\s/i);
  if (!m) return null;
  return { company: m[1].trim(), location: m[2].trim() };
}

// Splits a page-title string like "Senior Engineer (R123) - Shield AI |
// Built In" into { role, company }. Job-board <title>/og:title tags
// overwhelmingly follow "<Role> - <Company> | <Site>" or "<Role> at
// <Company> | <Site>" (LinkedIn, Indeed, Built In, and most ATS-hosted
// postings all do some variant of this) — without this split, the
// fallback tier was dumping the whole string into "role" verbatim, so the
// company rode along inside the job title instead of its own field.
function splitTitleRoleCompany(raw) {
  if (!raw) return { role: raw || '', company: '' };
  // Peel off a trailing "| Site Name" first — greedy on the left side of
  // the LAST "|" so a title that itself contains a pipe isn't cut short.
  const pipeMatch = raw.match(/^(.*)\|\s*[^|]+\s*$/);
  const left = (pipeMatch ? pipeMatch[1] : raw).trim();

  // Split on the LAST " - "/" – "/" — " (greedy .+ eats earlier dashes
  // that are part of the role itself, e.g. "Engineer - Backend - Acme"
  // correctly becomes role="Engineer - Backend", company="Acme" rather
  // than splitting on the first dash).
  let m = left.match(/^(.+)\s[-–—]\s([^-–—]+)$/);
  if (!m) m = left.match(/^(.+)\s+\bat\b\s+([^-–—]+)$/i);
  if (m) return { role: m[1].trim(), company: m[2].trim() };
  return { role: left, company: '' };
}

// If the company name ended up known (from the description heuristic
// above) but the role string — pulled separately from the title — still
// has it tacked on the end ("Senior Engineer - Shield AI"), trims it off
// so the two fields don't duplicate the company name between them.
function stripTrailingCompanyFromRole(role, company) {
  if (!role || !company) return role;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\s*[-–—]\\s*${escaped}\\s*$|\\s+at\\s+${escaped}\\s*$`, 'i');
  return role.replace(re, '').trim();
}

async function scrape(targetUrl) {
  const resp = await fetch(targetUrl, {
    headers: {
      // Identify as a normal browser — some sites reject requests with no UA at all.
      'User-Agent': 'Mozilla/5.0 (compatible; JobSearchLedger/1.0)'
    },
    redirect: 'follow'
  });

  if (!resp.ok) {
    throw new Error(`Site responded with status ${resp.status}`);
  }

  const html = await resp.text();
  const result = { role: '', company: '', location: '', salary: '', notes: '', url: targetUrl };
  let source = 'fallback';

  // Tier 1: structured JSON-LD data (reliable when present).
  let foundStructured = false;
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of ldBlocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const jp = findJobPosting(parsed);
      if (jp) {
        result.role = jp.title || '';
        result.company = (jp.hiringOrganization && jp.hiringOrganization.name) || '';
        result.location = locationFromJobPosting(jp);
        result.salary = salaryFromJobPosting(jp);
        if (jp.description) result.notes = stripTags(jp.description).slice(0, 400);
        source = 'structured';
        foundStructured = true;
        break;
      }
    } catch (e) {
      // Malformed JSON-LD on the page — skip and keep looking.
    }
  }

  // Tier 2: fallback heuristics from meta tags / title (best-effort) —
  // only runs when no JSON-LD JobPosting was found at all. Many boards
  // (Built In among them) don't emit JobPosting JSON-LD, so this is the
  // common path, not a rare edge case.
  if (!foundStructured) {
    const rawTitle = firstMeta(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
      /<title[^>]*>([\s\S]*?)<\/title>/i
    ]);
    const description = firstMeta(html, [
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i
    ]);

    // Prefer the "<Company> is hiring for a <Title> in <Location>" meta
    // description, when the board uses it — it names the company
    // unambiguously, unlike the <title> tag which also carries the job
    // board's own branding and gives no reliable signal for where the
    // title ends and the company begins.
    const hiringDetails = detailsFromHiringDescription(description);
    const { role: titleRole, company: titleCompany } = splitTitleRoleCompany(rawTitle);

    result.company = (hiringDetails && hiringDetails.company) || titleCompany || firstMeta(html, [
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i
    ]);
    result.role = stripTrailingCompanyFromRole(titleRole || rawTitle, result.company);
    result.location = (hiringDetails && hiringDetails.location) || '';
    if (description) result.notes = description.slice(0, 400);
  }

  // Last resort, applies after either tier: if nothing above produced a
  // salary, scan the page's own visible text for one. Several boards
  // (Built In included) render the range as plain text — no JSON-LD, no
  // meta tag — so this is often the only place it exists at all.
  if (!result.salary) {
    result.salary = salaryFromBodyText(stripTags(html));
  }

  return { ...result, source };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (reqUrl.pathname !== '/scrape') {
    json(res, 404, { error: 'Not found. Use /scrape?url=...' });
    return;
  }

  const target = reqUrl.searchParams.get('url');
  if (!target) {
    json(res, 400, { error: 'Missing url parameter.' });
    return;
  }

  try {
    new URL(target); // validate it's a real URL
  } catch (e) {
    json(res, 400, { error: 'That does not look like a valid URL.' });
    return;
  }

  try {
    const data = await scrape(target);
    json(res, 200, data);
  } catch (err) {
    json(res, 502, { error: `Could not fetch that page: ${err.message}` });
  }
});

server.listen(PORT, () => {
  console.log(`Scrape helper running at http://localhost:${PORT}`);
  console.log('Leave this running, then use "Fetch from URL" in the job tracker.');
  console.log('Press Ctrl+C to stop.');
});
