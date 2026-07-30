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

  // Tier 1: structured JSON-LD data (reliable when present).
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
        return { ...result, source: 'structured' };
      }
    } catch (e) {
      // Malformed JSON-LD on the page — skip and keep looking.
    }
  }

  // Tier 2: fallback heuristics from meta tags / title (best-effort).
  result.role = firstMeta(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ]);
  result.company = firstMeta(html, [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i
  ]);
  const description = firstMeta(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i
  ]);
  if (description) result.notes = description.slice(0, 400);

  return { ...result, source: 'fallback' };
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
