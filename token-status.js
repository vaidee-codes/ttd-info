const panel = document.querySelector('[data-ssd-live]');

if (panel) {
  const heading = panel.querySelector('[data-ssd-heading]');
  const summary = panel.querySelector('[data-ssd-summary]');
  const details = panel.querySelector('[data-ssd-details]');
  const slot = panel.querySelector('[data-ssd-slot]');
  const date = panel.querySelector('[data-ssd-date]');
  const balance = panel.querySelector('[data-ssd-balance]');
  const checked = panel.querySelector('[data-ssd-checked]');
  const refresh = panel.querySelector('[data-ssd-refresh]');

  const formatNumber = new Intl.NumberFormat('en-IN');
  const formatDate = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
  });
  const formatCheckedAt = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'
  });

  function validStatus(data) {
    return data?.status === 'ok'
      && data.source === 'official-ttd'
      && typeof data.slot === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(data.darshanDate)
      && Number.isSafeInteger(data.balance)
      && data.balance >= 0
      && !Number.isNaN(new Date(data.checkedAt).valueOf());
  }

  function showUnavailable() {
    panel.dataset.state = 'unavailable';
    heading.textContent = 'Official status temporarily unavailable';
    summary.textContent = 'TTD did not return a usable SSD status. Open the official page and confirm with staff before travelling.';
    details.hidden = true;
    checked.textContent = 'No balance is shown when the official source cannot be verified.';
  }

  async function loadStatus() {
    panel.setAttribute('aria-busy', 'true');
    refresh.disabled = true;
    heading.textContent = 'Checking official SSD status…';
    summary.textContent = 'Reading the current slot and balance published by TTD.';
    checked.textContent = '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/ttd-ssd', {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Status request failed');
      const data = await response.json();
      if (!validStatus(data)) throw new Error('Status response was invalid');

      panel.dataset.state = data.balance > 0 ? 'available' : 'empty';
      heading.textContent = data.balance > 0
        ? `${formatNumber.format(data.balance)} balance tickets shown`
        : 'Official balance shown: 0';
      summary.textContent = data.balance > 0
        ? 'This is the current SSD balance published on the official TTD homepage.'
        : 'TTD currently shows no balance tickets for this SSD date. This may change if TTD publishes another slot.';
      slot.textContent = data.slot;
      date.textContent = formatDate.format(new Date(`${data.darshanDate}T00:00:00+05:30`));
      balance.textContent = formatNumber.format(data.balance);
      details.hidden = false;
      checked.textContent = `Checked ${formatCheckedAt.format(new Date(data.checkedAt))} IST · Availability can change before you reach a counter.`;
    } catch {
      showUnavailable();
    } finally {
      clearTimeout(timeout);
      panel.removeAttribute('aria-busy');
      refresh.disabled = false;
    }
  }

  refresh.hidden = false;
  refresh.addEventListener('click', loadStatus);
  loadStatus();
}
