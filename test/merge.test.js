// Test harness for the job tracker's sync merge logic.
//
// This does NOT reimplement the merge algorithm — it extracts the actual
// function/constant source text from job-tracker.html and evaluates it
// directly, so these tests exercise the real shipped code. If someone
// edits mergeCardsAndUsersPure, dedupePostings, or postingDedupeKey in the
// HTML file without re-running this, the extraction below will either
// still find matching blocks (and test the new code) or fail loudly if
// the function signature changed enough to break the regex boundaries —
// either way it won't silently test stale logic.

const fs = require('fs');
const path = require('path');

const SRC_PATH = process.argv[2] || path.resolve(__dirname, '..', 'job-tracker-v1.18.1.html');
const html = fs.readFileSync(SRC_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if(!scriptMatch){
  console.error('Could not find <script> block in', SRC_PATH);
  process.exit(1);
}
const fullScript = scriptMatch[1];

function extractBlock(startMarker, label){
  const startIdx = fullScript.indexOf(startMarker);
  if(startIdx === -1) throw new Error(`Could not find ${label} (marker: ${JSON.stringify(startMarker)})`);
  // Walk forward from the opening brace, tracking nesting depth, to find
  // the matching closing brace — safe against nested {} inside the body.
  const braceStart = fullScript.indexOf('{', startIdx);
  let depth = 0, i = braceStart;
  for(; i < fullScript.length; i++){
    if(fullScript[i] === '{') depth++;
    else if(fullScript[i] === '}'){
      depth--;
      if(depth === 0) break;
    }
  }
  if(depth !== 0) throw new Error(`Unbalanced braces extracting ${label}`);
  return fullScript.slice(startIdx, i + 1);
}

function extractConstStatement(startMarker, label){
  const startIdx = fullScript.indexOf(startMarker);
  if(startIdx === -1) throw new Error(`Could not find ${label} (marker: ${JSON.stringify(startMarker)})`);
  const endIdx = fullScript.indexOf(';\n', startIdx);
  if(endIdx === -1) throw new Error(`Could not find end of ${label}`);
  return fullScript.slice(startIdx, endIdx + 1);
}

const src = [
  extractConstStatement('const URL_TRACKING_PARAMS', 'URL_TRACKING_PARAMS'),
  extractConstStatement('const TOMBSTONE_GC_MS', 'TOMBSTONE_GC_MS'),
  extractBlock('function postingDedupeKey', 'postingDedupeKey'),
  extractBlock('function dedupePostings', 'dedupePostings'),
  extractBlock('function mergeCardsAndUsersPure', 'mergeCardsAndUsersPure'),
  extractBlock('function mergeUserResumes', 'mergeUserResumes'),
].join('\n\n');

// Evaluate the extracted source in this module's scope, exposing the
// functions/constants as locals we can call directly below.
const vm = require('vm');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.mergeCardsAndUsersPure = mergeCardsAndUsersPure; this.dedupePostings = dedupePostings; this.postingDedupeKey = postingDedupeKey; this.TOMBSTONE_GC_MS = TOMBSTONE_GC_MS; this.mergeUserResumes = mergeUserResumes;', sandbox);
const { mergeCardsAndUsersPure, dedupePostings, postingDedupeKey, TOMBSTONE_GC_MS, mergeUserResumes } = sandbox;

// ---- tiny test runner ----
let pass = 0, fail = 0;
const failures = [];
function test(name, fn){
  try{
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  }catch(e){
    fail++;
    failures.push({name, error: e});
    console.log(`FAIL  - ${name}`);
    console.log(`        ${e.message}`);
  }
}
function assertEqual(actual, expected, msg){
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if(a !== b) throw new Error(`${msg || 'mismatch'}: expected ${b}, got ${a}`);
}
function assertTrue(cond, msg){
  if(!cond) throw new Error(msg || 'expected true');
}
function card(overrides){
  return { id: 'c1', role: 'Engineer', company: 'Acme', column: 'hopper', owner: 'derek', tags: [], updatedAt: 1000, ...overrides };
}

console.log(`Testing merge logic extracted from: ${SRC_PATH}\n`);

// ---------------------------------------------------------------------
test('non-conflicting cards from both sides are both kept', ()=>{
  const local = [card({id:'a', updatedAt:100})];
  const remote = [card({id:'b', updatedAt:100})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 200);
  assertEqual(result.cards.map(c=>c.id).sort(), ['a','b']);
});

test('same card: remote strictly newer wins', ()=>{
  const local = [card({id:'a', updatedAt:100, role:'Old Title'})];
  const remote = [card({id:'a', updatedAt:200, role:'New Title'})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards.length, 1);
  assertEqual(result.cards[0].role, 'New Title');
});

test('same card: local newer wins (remote does not overwrite)', ()=>{
  const local = [card({id:'a', updatedAt:200, role:'Local Title'})];
  const remote = [card({id:'a', updatedAt:100, role:'Remote Title'})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards[0].role, 'Local Title');
});

test('same card: exact tie keeps local (no flapping between devices)', ()=>{
  const local = [card({id:'a', updatedAt:150, role:'Local Title'})];
  const remote = [card({id:'a', updatedAt:150, role:'Remote Title'})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards[0].role, 'Local Title');
});

test('a newer deletion (tombstone) beats an older live edit', ()=>{
  const local = [card({id:'a', updatedAt:100, role:'Still editing'})];
  const remote = [card({id:'a', updatedAt:200, deleted:true})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards.length, 1);
  assertTrue(result.cards[0].deleted, 'expected the tombstone to win');
});

test('an older deletion does not beat a newer live edit (undelete-by-edit)', ()=>{
  const local = [card({id:'a', updatedAt:200, role:'Revived'})];
  const remote = [card({id:'a', updatedAt:100, deleted:true})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards[0].deleted, undefined);
  assertEqual(result.cards[0].role, 'Revived');
});

test('old tombstones get garbage-collected past TOMBSTONE_GC_MS', ()=>{
  const now = 100_000_000;
  const local = [card({id:'a', updatedAt: now - TOMBSTONE_GC_MS - 1, deleted:true})];
  const result = mergeCardsAndUsersPure(local, [], [], [], 0, now);
  assertEqual(result.cards.length, 0);
});

test('recent tombstones are NOT garbage-collected yet', ()=>{
  const now = 100_000_000;
  const local = [card({id:'a', updatedAt: now - TOMBSTONE_GC_MS + 1000, deleted:true})];
  const result = mergeCardsAndUsersPure(local, [], [], [], 0, now);
  assertEqual(result.cards.length, 1);
});

test('missing/undefined updatedAt is treated as 0, does not crash', ()=>{
  const local = [card({id:'a', updatedAt: undefined})];
  const remote = [card({id:'a', updatedAt: 500})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 1000);
  assertEqual(result.cards[0].updatedAt, 500);
});

test('users lists are unioned without duplicates', ()=>{
  const result = mergeCardsAndUsersPure([], ['derek','alice'], [], ['alice','bob'], 0, 1000);
  assertEqual(result.users.sort(), ['alice','bob','derek']);
});

test('recentlyChangedIds only includes cards updated after the cutoff', ()=>{
  const local = [card({id:'a', updatedAt:50})];
  const remote = [card({id:'b', updatedAt:150})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 100, 1000);
  assertEqual(Array.from(result.recentlyChangedIds), ['b']);
});

test('deleted cards are excluded from recentlyChangedIds even if recent', ()=>{
  const remote = [card({id:'a', updatedAt:150, deleted:true})];
  const result = mergeCardsAndUsersPure([], [], remote, [], 100, 1000);
  assertEqual(Array.from(result.recentlyChangedIds), []);
});

// ---------------------------------------------------------------------
// Postings dedup — this is the part most likely to be involved if two
// devices each pull the same job posting independently and both push it
// back with slightly different tags.

test('two shared Postings cards with the same URL get deduped, tags merged', ()=>{
  const local = [card({id:'a', owner:null, column:'postings', url:'https://x.com/job/1', tags:['from:indeed'], updatedAt:100})];
  const remote = [card({id:'b', owner:null, column:'postings', url:'https://x.com/job/1', tags:['from:alice'], updatedAt:200})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards.length, 1);
  assertEqual(result.cards[0].tags.sort(), ['from:alice','from:indeed']);
});

test('postings URLs differing only by tracking params still dedupe together', ()=>{
  const local = [card({id:'a', owner:null, column:'postings', url:'https://x.com/job/1?utm_source=indeed', updatedAt:100})];
  const remote = [card({id:'b', owner:null, column:'postings', url:'https://x.com/job/1?utm_source=google', updatedAt:200})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards.length, 1);
});

test('personal (owned) cards with the same URL are NOT deduped against each other', ()=>{
  const local = [card({id:'a', owner:'derek', column:'hopper', url:'https://x.com/job/1', updatedAt:100})];
  const remote = [card({id:'b', owner:'alice', column:'hopper', url:'https://x.com/job/1', updatedAt:200})];
  const result = mergeCardsAndUsersPure(local, [], remote, [], 0, 300);
  assertEqual(result.cards.length, 2);
});

// ---------------------------------------------------------------------
// The scenario closest to what actually got reported: multiple devices,
// each with their own unrelated edits, syncing against a shared remote.

test('multi-device: concurrent edits to DIFFERENT cards are both preserved', ()=>{
  // Device A's local state after its own edit to card 'a'.
  const localOnDeviceA = [
    card({id:'a', updatedAt:500, role:'Edited on device A'}),
    card({id:'b', updatedAt:100, role:'Untouched'}),
  ];
  // What's on the remote Sheet: device B already pushed its own edit to 'b'.
  const remoteFromSheet = [
    card({id:'a', updatedAt:100, role:'Stale'}),
    card({id:'b', updatedAt:600, role:'Edited on device B'}),
  ];
  const result = mergeCardsAndUsersPure(localOnDeviceA, [], remoteFromSheet, [], 0, 1000);
  const byId = Object.fromEntries(result.cards.map(c=>[c.id, c]));
  assertEqual(byId.a.role, 'Edited on device A');
  assertEqual(byId.b.role, 'Edited on device B');
});

test('merge never throws for well-formed input (rules out the "throws instead of resolving" hypothesis)', ()=>{
  // A deliberately awkward mix: ties, missing fields, tombstones, dupes.
  const local = [
    card({id:'a', updatedAt:100}),
    card({id:'b', updatedAt:undefined, deleted:true}),
    card({id:'c', owner:null, column:'postings', url:'https://x.com/j', updatedAt:50}),
  ];
  const remote = [
    card({id:'a', updatedAt:100, role:'Tie'}),
    card({id:'c', owner:null, column:'postings', url:'https://x.com/j?utm_source=x', updatedAt:60}),
    card({id:'d', updatedAt:9999999999}),
  ];
  let threw = false;
  try{
    mergeCardsAndUsersPure(local, ['derek'], remote, ['derek','alice'], 0, Date.now());
  }catch(e){
    threw = true;
  }
  assertTrue(!threw, 'merge threw on well-formed input');
});

// ---------------------------------------------------------------------
// Resume links — same last-write-wins philosophy as cards, but per user
// entry rather than per card, and merged separately from mergeCardsAndUsersPure
// (see mergeUserResumes's own comment for why).

test('resumes: a user with no local entry picks up the remote one', ()=>{
  const result = mergeUserResumes({}, {derek: {url:'https://x.com/r.pdf', updatedAt:100}});
  assertEqual(result.derek, {url:'https://x.com/r.pdf', updatedAt:100});
});

test('resumes: remote strictly newer wins', ()=>{
  const local = {derek: {url:'https://old.com', updatedAt:100}};
  const remote = {derek: {url:'https://new.com', updatedAt:200}};
  const result = mergeUserResumes(local, remote);
  assertEqual(result.derek.url, 'https://new.com');
});

test('resumes: local newer wins (remote does not overwrite)', ()=>{
  const local = {derek: {url:'https://local.com', updatedAt:200}};
  const remote = {derek: {url:'https://remote.com', updatedAt:100}};
  const result = mergeUserResumes(local, remote);
  assertEqual(result.derek.url, 'https://local.com');
});

test('resumes: exact tie keeps local (no flapping between devices)', ()=>{
  const local = {derek: {url:'https://local.com', updatedAt:150}};
  const remote = {derek: {url:'https://remote.com', updatedAt:150}};
  const result = mergeUserResumes(local, remote);
  assertEqual(result.derek.url, 'https://local.com');
});

test('resumes: a newer removal (blank-url tombstone) beats an older link', ()=>{
  const local = {derek: {url:'https://old.com', updatedAt:100}};
  const remote = {derek: {url:'', updatedAt:200}};
  const result = mergeUserResumes(local, remote);
  assertEqual(result.derek.url, '');
});

test('resumes: an older removal does not beat a newer re-added link', ()=>{
  const local = {derek: {url:'https://readded.com', updatedAt:200}};
  const remote = {derek: {url:'', updatedAt:100}};
  const result = mergeUserResumes(local, remote);
  assertEqual(result.derek.url, 'https://readded.com');
});

test('resumes: different users merge independently, both kept', ()=>{
  const local = {derek: {url:'https://derek.com', updatedAt:100}};
  const remote = {alice: {url:'https://alice.com', updatedAt:100}};
  const result = mergeUserResumes(local, remote);
  assertEqual(Object.keys(result).sort(), ['alice','derek']);
});

// ---------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if(fail > 0){
  console.log('\nFailure details:');
  failures.forEach(f=> console.log(`  - ${f.name}: ${f.error.message}`));
  process.exit(1);
}
