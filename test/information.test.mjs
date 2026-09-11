import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { outputs, validateContent } from '../scripts/build-information.mjs';
import { matches, indiaDate, eventStatus } from '../information-filters.mjs';
import { events, sources, sevas, dailyTimings } from '../content/information.mjs';
const root = new URL('../',import.meta.url);
test('reviewed records are valid and generated pages are up to date',()=>{
 validateContent();
 for(const [file,expected] of outputs) assert.equal(readFileSync(new URL(file,root),'utf8'),expected,`${file}: regenerate information pages`);
});
test('local page links and fragment destinations exist',()=>{
 for(const [file,html] of outputs){
  if(!file.endsWith('.html')) continue;
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,`${file}: duplicate IDs`);
  for(const match of html.matchAll(/\bhref="([^"?]+)"/g)){
   const href=match[1]; if(!href.startsWith('/')&&!href.startsWith('#')) continue;
   const [path,hash]=href.split('#');
   const target=path ? path==='/'?'index.html':path==='/pass'?'pass/index.html':path.slice(1)+(path.includes('.')?'':'.html') : file;
   assert.ok(existsSync(new URL(target,root)),`${file}: ${href} has no local target`);
   if(hash) assert.ok(readFileSync(new URL(target,root),'utf8').includes(`id="${hash}"`),`${file}: broken ${href}`);
  }
 }
});
test('guide anchors remain and static content is available without scripts',()=>{
 const guides=outputs.get('guides.html');
 for(const id of ['first-visit','darshan','booking','stay','travel','essentials','food','questions']) assert.ok(guides.includes(`<article id="${id}">`));
 for(const file of ['guides.html','events.html','glossary.html']){
  assert.match(outputs.get(file),/<(?:article|a)[^>]*data-search-item/);
  assert.match(outputs.get(file),/data-controls hidden/);
 }
 assert.match(outputs.get('tokens.html'),/Live updates unavailable/);
 assert.doesNotMatch(outputs.get('tokens.html'),/fetch\(|setInterval\(|tokens remaining/i);
 assert.match(outputs.get('tokens.html'),/tirumala\.org\/|tirumalainfo\.com/);
 assert.match(outputs.get('tokens.html'),/Open TTD live status/);
 assert.match(outputs.get('tokens.html'),/Open community SSD \/ DD status/);
});
test('seva records carry reviewed clock windows and the weekday timetable',()=>{
 assert.equal(dailyTimings.length,6);
 assert.match(outputs.get('sevas.html'),/Official daily reference timetable/);
 assert.match(outputs.get('sevas.html'),/03:00–03:30/);
 assert.match(outputs.get('sevas.html'),/Reporting 05:00 hrs · Seva 06:00 hrs/);
 assert.match(outputs.get('sevas.html'),/13:00 hrs · three days · ₹300/);
 assert.ok(sevas.every(s=>s.timeLabel));
});
test('information pages use the shared branded mark and support keeps shared styles',()=>{
 for(const file of ['index.html','guides.html','support.html']){
 const html=readFileSync(new URL(file,root),'utf8');
  assert.match(html,/brand-mark[^>]*>⚡</);
  assert.match(html,/> TTD Info<\/a>/);
 }
 const support=readFileSync(new URL('support.html',root),'utf8');
 assert.match(support,/href="site\.css"|href="\/site\.css"/);
 assert.match(support,/href="planning\.css"|href="\/planning\.css"/);
});
test('new styles and scripts cannot be loaded by revenue pages',()=>{
 for(const file of ['demos.html','pass/index.html','pass/status.html','pass/success.html']){
  const html=readFileSync(new URL(file,root),'utf8');
  assert.doesNotMatch(html,/information(?:-filters)?\.(?:css|js|mjs)/);
 }
 for(const [file,html] of outputs) if(file.endsWith('.html')) assert.doesNotMatch(html,/href="\/?(?:site|planning)\.css"/);
});
test('search is case insensitive, supports multiple words, Telugu, and empty results',()=>{
 assert.ok(matches({text:'SSD / DD token information'}, {query:'  sSd TOKEN  '}));
 assert.ok(matches({text:'Suprabhatam సుప్రభాతం'},{query:'సుప్రభాతం'}));
 assert.equal(matches({text:'Accommodation'},{query:'no-such-guide'}),false);
 assert.ok(matches({text:'Anything'},{query:'  '}));
});
test('event filtering handles temple, month ranges, missing dates and no matches',()=>{
 const item={text:'Festival',temple:'tirumala',date:'2026-09-30',endDate:'2026-10-02'};
 assert.ok(matches(item,{month:'2026-10',temple:'tirumala'}));
 assert.equal(matches(item,{month:'2026-11'}),false);
 assert.equal(matches(item,{month:'2026-10',temple:'tiruchanoor'}),false);
 assert.equal(matches({text:'Undated'},{month:'2026-10'}),false);
 for(const e of events) assert.ok(sources[e.source].kind.startsWith('Official'));
});
test('event dates use India midnight, including multi-day and past events',()=>{
 assert.equal(indiaDate(new Date('2026-09-09T18:29:59Z')),'2026-09-09');
 assert.equal(indiaDate(new Date('2026-09-09T18:30:00Z')),'2026-09-10');
 assert.equal(eventStatus('2026-09-09',null,'2026-09-10'),'Past event');
 assert.match(eventStatus('2026-09-09','2026-09-11','2026-09-10'),/Scheduled today/);
 assert.match(eventStatus('2026-09-11',null,'2026-09-10'),/Upcoming/);
 assert.equal(eventStatus(null,null,'2026-09-10'),'Date awaiting confirmation');
});
