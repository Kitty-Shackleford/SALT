(async function () {
  let serverId = null;
  let identityId = null;

  try {
    const res = await fetch('/api/accounts/linked');
    const data = await res.json();
    if (data.success && data.accounts && data.accounts.length > 0) {
      identityId = data.accounts[0].identity_id;
      serverId = data.accounts[0].server_id;
    }
  } catch (e) { /* handled below */ }

  document.getElementById('loading-state').classList.add('hidden');

  if (!serverId) {
    document.getElementById('no-guild').classList.remove('hidden');
    return;
  }

  document.getElementById('main-content').classList.remove('hidden');

  LeaderboardTable.setupControls();
  await LeaderboardTable.load(serverId, { highlightIdentityId: identityId, sortBy: 'total' });
})();
