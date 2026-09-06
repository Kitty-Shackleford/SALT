(async function () {
  let memberships = [];
  let selectionVersion = 0;
  const select = document.getElementById('economyMembershipSelect');

  async function loadMembership(account) {
    const version = ++selectionVersion;
    TransactionList.beginContextChange();
    const identityId = account.identity_id;
    const serverId = account.server_id;
    let currencySymbol = '$';

    try {
      const res = await fetch(`/api/economy/player/${identityId}?serverId=${encodeURIComponent(serverId)}`);
      const data = await res.json();
      if (data.success) currencySymbol = data.currency?.symbol || '$';
    } catch (e) { /* use default */ }

    if (version !== selectionVersion) return;
    await TransactionList.load(identityId, { currencySymbol, serverId });
  }

  try {
    const res = await fetch('/api/accounts/linked');
    const data = await res.json();
    if (data.success) memberships = data.accounts || [];
  } catch (e) { /* handled below */ }

  document.getElementById('loading-state').classList.add('hidden');

  if (!memberships.length) {
    document.getElementById('no-account').classList.remove('hidden');
    return;
  }

  memberships.forEach((account, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    const player = account.gamertag || `Identity #${account.identity_id}`;
    const platform = account.platform || 'unknown platform';
    option.textContent = `${account.server_name || `Server ${account.server_id}`} — ${player} (${platform})`;
    select.appendChild(option);
  });
  TransactionList.setupControls();
  select.addEventListener('change', () => loadMembership(memberships[Number(select.value)]));

  document.getElementById('main-content').classList.remove('hidden');
  await loadMembership(memberships[0]);
})();
