import { indiaDate, matches, eventStatus } from './information-filters.mjs';
for (const scope of document.querySelectorAll('[data-filter-scope]')) {
  const controls = scope.querySelector('[data-controls]');
  const search = scope.querySelector('[data-search]');
  const month = scope.querySelector('[data-month]');
  const temple = scope.querySelector('[data-temple]');
  const items = [...scope.querySelectorAll('[data-search-item]')];
  if(month) month.value = indiaDate().slice(0,7);
  function update() {
    let count = 0;
    for(const item of items) {
      item.hidden = !matches({text:item.dataset.searchText,date:item.dataset.date,endDate:item.dataset.endDate,temple:item.dataset.temple}, {query:search?.value,month:month?.value,temple:temple?.value});
      if(!item.hidden) count++;
      const status = item.querySelector('[data-event-status]');
      if(status) status.textContent = eventStatus(item.dataset.date,item.dataset.endDate,indiaDate());
    }
    for(const group of scope.querySelectorAll('[data-date-group], [data-letter-group]')) group.hidden = ![...group.querySelectorAll('[data-search-item]')].some(item=>!item.hidden);
    scope.querySelector('[data-empty]').hidden = count !== 0;
    scope.querySelector('[data-result-count]').textContent = `${count} ${scope.hasAttribute('data-events') ? 'published entries' : 'results'}`;
  }
  function reset() { if(search) search.value=''; if(month) month.value=''; if(temple) temple.value=''; update(); }
  controls.hidden = false;
  controls.addEventListener('input',update);
  controls.addEventListener('change',update);
  scope.querySelector('[data-reset]').addEventListener('click',reset);
  // Alphabet and inbound glossary anchors remain reachable even after filtering.
  function revealHash() {
    let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if(target && scope.contains(target) && target.closest('[data-search-item], [data-letter-group]')) {
      reset(); requestAnimationFrame(()=>target.scrollIntoView());
    }
  }
  scope.querySelector('.alphabet')?.addEventListener('click',reset);
  window.addEventListener('hashchange',revealHash);
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) update(); });
  update(); revealHash();
}
