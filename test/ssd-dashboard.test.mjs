import test from 'node:test';
import assert from 'node:assert/strict';
import { statusFreshness } from '../ssd-status-model.mjs';
import { validateObservation } from '../content/ssd.mjs';
import { ssdSection } from '../scripts/ssd-section.mjs';
test('freshness rejects old and future snapshots and prior India dates',()=>{
 const now=Date.parse('2026-09-11T18:31:00Z');
 const data={checkedAt:'2026-09-11T18:30:00Z',darshanDate:'2026-09-12'};
 assert.equal(statusFreshness(data,now),'fresh');
 assert.equal(statusFreshness({...data,darshanDate:'2026-09-11'},now),'stale');
 assert.equal(statusFreshness({...data,checkedAt:'2026-09-11T18:00:00Z'},now),'stale');
 assert.equal(statusFreshness({...data,checkedAt:'2026-09-12T18:00:00Z'},now),'invalid');
 assert.equal(statusFreshness({...data,checkedAt:null},now),'invalid');
});
test('outside observations require SSD scope and explicit dates and provenance',()=>{
 assert.throws(()=>validateObservation({type:'SSD',summary:'Open'}));
 const r={id:'test',type:'SSD',sourceReference:'review:test',counter:'Srinivasam',darshanDate:'2026-09-12',issuanceDate:'2026-09-11',observedAt:'2026-09-11T10:00:00+05:30',reportedAt:'2026-09-11T10:05:00+05:30',reviewedAt:'2026-09-11T11:00:00+05:30',summary:'An explicitly dated observation'};
 assert.equal(validateObservation(r),r);
 assert.throws(()=>validateObservation({...r,type:'DD'}));
 assert.throws(()=>validateObservation({...r,reportedAt:'2026-09-11T09:00:00+05:30'}));
});
test('dashboard is readable without scripts and shows unknown observations honestly',()=>{
 const html=ssdSection();
 assert.match(html,/No verified SSD ground reports/);
 assert.match(html,/Current SSD estimate: Not reported/);
 assert.match(html,/No historical balance archive/);
 assert.doesNotMatch(html,/https:\/\/(?![^/]*tirumala)/);
});
