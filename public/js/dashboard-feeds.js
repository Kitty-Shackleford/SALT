/* global document, fetchWithCsrf, window */

let currentGuildId = null;
let currentServerId = null;
let guildChannels = [];

// Load guilds on page load
fetch('/api/user')
  .then(res => res.json())
  .then(() => {
    loadGuilds();
  })
  .catch(() => {
    window.location.href = '/';
  });

// Logout
document.getElementById('logoutBtn').addEventListener('click', () => {
  window.location.href = '/logout';
});

// Load guilds
async function loadGuilds() {
  try {
    const response = await fetch('/api/user/guilds');
    const data = await response.json();

    if (data.success && data.guilds) {
      const select = document.getElementById('guildSelect');
      data.guilds.forEach(guild => {
          const option = document.createElement('option');
          option.value = guild.id;
          option.textContent = guild.name;
          select.appendChild(option);
        });
    }
  } catch (error) {
    console.error('Error loading guilds:', error);
    showError('Failed to load guilds');
  }
}

// Guild selection change
document.getElementById('guildSelect').addEventListener('change', async (e) => {
  currentGuildId = e.target.value;
  currentServerId = null;

  if (!currentGuildId) {
    document.getElementById('noGuildState').style.display = 'block';
    document.getElementById('feedsContainer').style.display = 'none';
    return;
  }

  document.getElementById('noGuildState').style.display = 'none';
  document.getElementById('loadingState').style.display = 'block';

  await loadGuildChannels(currentGuildId);
  await loadServers(currentGuildId);
});

async function loadServers(guildId) {
  const select = document.getElementById('serverSelect');
  select.disabled = true;
  select.innerHTML = '<option value="">-- Select a DayZ Server --</option>';
  try {
    const response = await fetch(`/api/guilds/${guildId}/servers`);
    const data = await response.json();
    for (const server of data.servers || []) {
      const option = document.createElement('option');
      option.value = server.id;
      option.textContent = server.displayName || server.server_name || `Server ${server.id}`;
      select.appendChild(option);
    }
    select.disabled = false;
    if ((data.servers || []).length === 1) {
      select.value = String(data.servers[0].id);
      select.dispatchEvent(new Event('change'));
    } else {
      document.getElementById('loadingState').style.display = 'none';
    }
  } catch (error) {
    showError('Failed to load servers');
    document.getElementById('loadingState').style.display = 'none';
  }
}

document.getElementById('serverSelect').addEventListener('change', async event => {
  currentServerId = event.target.value;
  if (!currentServerId) {
    document.getElementById('feedsContainer').style.display = 'none';
    return;
  }
  document.getElementById('loadingState').style.display = 'block';
  await loadFeedConfiguration(currentGuildId);
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('feedsContainer').style.display = 'block';
});

// Load guild channels from Discord
async function loadGuildChannels(guildId) {
  try {
    const response = await fetch(`/api/discord/guilds/${guildId}/channels`);
    const data = await response.json();

    if (data.success && data.channels) {
      guildChannels = data.channels.filter(c => c.type === 0); // Text channels only

      // Populate channel selectors for all feed types
      const selectors = [
        document.getElementById('killFeedChannel'),
        document.getElementById('factionFeedChannel'),
      ];

      selectors.forEach(select => {
        if (!select) return;
        select.innerHTML = '<option value="">-- Select Channel --</option>';
        guildChannels.forEach(channel => {
          const option = document.createElement('option');
          option.value = channel.id;
          option.textContent = `# ${channel.name}`;
          select.appendChild(option);
        });
      });
    }
  } catch (error) {
    console.error('Error loading channels:', error);
  }
}

// Load feed configuration
async function loadFeedConfiguration(guildId) {
  try {
    const [feedsRes, templatesRes] = await Promise.all([
      fetch(`/api/feeds/${guildId}/${currentServerId}`),
      fetch(`/api/feeds/${guildId}/${currentServerId}/templates`)
    ]);

    const feedsData = await feedsRes.json();
    const templatesData = await templatesRes.json();

    if (feedsData.success) {
      const killFeed    = feedsData.feeds.find(f => f.feedType === 'kill_feed');
      const factionFeed = feedsData.feeds.find(f => f.feedType === 'faction_feed');

      if (killFeed) {
        // Set toggle
        document.getElementById('killFeedEnabled').checked = killFeed.enabled;
        toggleKillFeedSettings(killFeed.enabled);

        // Set channel
        document.getElementById('killFeedChannel').value = killFeed.channelId || '';

        // Set webhook
        document.getElementById('killFeedWebhook').value = killFeed.webhookUrl || '';

        // Set settings
        const settings = killFeed.settings || {};
        document.getElementById('killFeedShowPlayers').checked = settings.showPlayers !== false;
        document.getElementById('killFeedShowZombies').checked = settings.showZombies || false;
        document.getElementById('killFeedShowAnimals').checked = settings.showAnimals || false;
        document.getElementById('killFeedShowSuicides').checked = settings.showSuicides || false;
        document.getElementById('killFeedMinDistance').value = settings.minDistance || 0;
        document.getElementById('killFeedUseEmbed').checked = settings.useEmbed || false;
        document.getElementById('killFeedEmbedColor').value = settings.embedColor || '#ff0000';
        toggleEmbedSettings(settings.useEmbed || false);
      }

      if (factionFeed) {
        document.getElementById('factionFeedEnabled').checked = factionFeed.enabled;
        document.getElementById('factionFeedSettings').style.display = factionFeed.enabled ? 'block' : 'none';
        document.getElementById('factionFeedChannel').value  = factionFeed.channelId  || '';
        document.getElementById('factionFeedWebhook').value  = factionFeed.webhookUrl || '';
        const fs = factionFeed.settings || {};
        document.getElementById('factionFeedUseEmbed').checked  = fs.useEmbed   || false;
        document.getElementById('factionFeedEmbedColor').value  = fs.embedColor || '#ffa500';
        document.getElementById('factionFeedEmbedSettings').style.display = fs.useEmbed ? 'block' : 'none';
      }
    }

    if (templatesData.success) {
      const templates = templatesData.templates;

      const playerTemplate = templates.find(t => t.feedType === 'kill_feed' && t.eventType === 'player_kill');
      if (playerTemplate) {
        document.getElementById('killFeedTemplatePlayer').value = playerTemplate.template;
      }

      const zombieTemplate = templates.find(t => t.feedType === 'kill_feed' && t.eventType === 'zombie_kill');
      if (zombieTemplate) {
        document.getElementById('killFeedTemplateZombie').value = zombieTemplate.template;
      }

      const animalTemplate = templates.find(t => t.feedType === 'kill_feed' && t.eventType === 'animal_kill');
      if (animalTemplate) {
        document.getElementById('killFeedTemplateAnimal').value = animalTemplate.template;
      }

      const factionKillTemplate = templates.find(t => t.feedType === 'faction_feed' && t.eventType === 'faction_kill');
      if (factionKillTemplate) {
        document.getElementById('factionFeedTemplate').value = factionKillTemplate.template;
      }
    }

  } catch (error) {
    console.error('Error loading feed configuration:', error);
    showError('Failed to load configuration');
  }
}

// Toggle kill feed settings visibility
document.getElementById('killFeedEnabled').addEventListener('change', (e) => {
  toggleKillFeedSettings(e.target.checked);
});

function toggleKillFeedSettings(enabled) {
  document.getElementById('killFeedSettings').style.display = enabled ? 'block' : 'none';
}

// Toggle embed settings
document.getElementById('killFeedUseEmbed').addEventListener('change', (e) => {
  toggleEmbedSettings(e.target.checked);
});

function toggleEmbedSettings(enabled) {
  document.getElementById('killFeedEmbedSettings').style.display = enabled ? 'block' : 'none';
}

// Save kill feed configuration
document.getElementById('saveKillFeed').addEventListener('click', async () => {
  if (!currentGuildId || !currentServerId) return;

  const btn = document.getElementById('saveKillFeed');
  btn.disabled = true;
  btn.textContent = '💾 Saving...';

  try {
    const enabled = document.getElementById('killFeedEnabled').checked;
    const channelId = document.getElementById('killFeedChannel').value;
    const webhookUrl = document.getElementById('killFeedWebhook').value;

    const settings = {
      showPlayers: document.getElementById('killFeedShowPlayers').checked,
      showZombies: document.getElementById('killFeedShowZombies').checked,
      showAnimals: document.getElementById('killFeedShowAnimals').checked,
      showSuicides: document.getElementById('killFeedShowSuicides').checked,
      minDistance: parseInt(document.getElementById('killFeedMinDistance').value) || 0,
      useEmbed: document.getElementById('killFeedUseEmbed').checked,
      embedColor: document.getElementById('killFeedEmbedColor').value
    };

    // Save feed configuration
    const feedRes = await fetchWithCsrf(`/api/feeds/${currentGuildId}/${currentServerId}`, {
      method: 'POST',
      body: JSON.stringify({
        feedType: 'kill_feed',
        enabled,
        channelId,
        webhookUrl,
        settings
      })
    });

    const feedData = await feedRes.json();
    if (!feedData.success) throw new Error(feedData.error);

    // Save templates
    const templates = [
      {
        feedType: 'kill_feed',
        eventType: 'player_kill',
        template: document.getElementById('killFeedTemplatePlayer').value,
        embedEnabled: settings.useEmbed,
        embedColor: settings.embedColor
      },
      {
        feedType: 'kill_feed',
        eventType: 'zombie_kill',
        template: document.getElementById('killFeedTemplateZombie').value,
        embedEnabled: settings.useEmbed,
        embedColor: settings.embedColor
      },
      {
        feedType: 'kill_feed',
        eventType: 'animal_kill',
        template: document.getElementById('killFeedTemplateAnimal').value,
        embedEnabled: settings.useEmbed,
        embedColor: settings.embedColor
      }
    ];

    for (const template of templates) {
      const templateRes = await fetchWithCsrf(`/api/feeds/${currentGuildId}/${currentServerId}/templates`, {
        method: 'POST',
        body: JSON.stringify(template)
      });

      const templateData = await templateRes.json();
      if (!templateData.success) throw new Error(templateData.error);
    }

    showSuccess('✅ Kill feed configuration saved!');

  } catch (error) {
    console.error('Error saving configuration:', error);
    showError('❌ Failed to save configuration: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save Configuration';
  }
});

// Test kill feed
document.getElementById('testKillFeed').addEventListener('click', async () => {
  if (!currentGuildId || !currentServerId) return;

  const btn = document.getElementById('testKillFeed');
  btn.disabled = true;
  btn.textContent = '🧪 Sending...';

  try {
    const response = await fetchWithCsrf(`/api/feeds/${currentGuildId}/${currentServerId}/test`, {
      method: 'POST',
      body: JSON.stringify({ feedType: 'kill_feed' })
    });

    const data = await response.json();

    if (data.success) {
      showSuccess('✅ Test message sent!');
    } else {
      throw new Error(data.error);
    }

  } catch (error) {
    console.error('Error sending test:', error);
    showError('❌ Failed to send test: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🧪 Send Test Message';
  }
});

// ─── Faction War Feed ─────────────────────────────────────────────────────────

// Toggle faction feed settings panel
document.getElementById('factionFeedEnabled').addEventListener('change', (e) => {
  document.getElementById('factionFeedSettings').style.display = e.target.checked ? 'block' : 'none';
});

// Toggle faction embed settings panel
document.getElementById('factionFeedUseEmbed').addEventListener('change', (e) => {
  document.getElementById('factionFeedEmbedSettings').style.display = e.target.checked ? 'block' : 'none';
});

// Save faction feed configuration
document.getElementById('saveFactionFeed').addEventListener('click', async () => {
  if (!currentGuildId || !currentServerId) return;

  const btn = document.getElementById('saveFactionFeed');
  btn.disabled = true;
  btn.textContent = '💾 Saving...';

  try {
    const enabled    = document.getElementById('factionFeedEnabled').checked;
    const channelId  = document.getElementById('factionFeedChannel').value;
    const webhookUrl = document.getElementById('factionFeedWebhook').value;
    const useEmbed   = document.getElementById('factionFeedUseEmbed').checked;
    const embedColor = document.getElementById('factionFeedEmbedColor').value;

    // Save feed config
    const feedRes  = await fetchWithCsrf(`/api/feeds/${currentGuildId}/${currentServerId}`, {
      method: 'POST',
      body: JSON.stringify({
        feedType: 'faction_feed',
        enabled,
        channelId,
        webhookUrl,
        settings: { useEmbed, embedColor }
      })
    });
    const feedData = await feedRes.json();
    if (!feedData.success) throw new Error(feedData.error);

    // Save faction_kill message template
    const templateRes  = await fetchWithCsrf(`/api/feeds/${currentGuildId}/${currentServerId}/templates`, {
      method: 'POST',
      body: JSON.stringify({
        feedType:     'faction_feed',
        eventType:    'faction_kill',
        template:     document.getElementById('factionFeedTemplate').value,
        embedEnabled: useEmbed,
        embedColor
      })
    });
    const templateData = await templateRes.json();
    if (!templateData.success) throw new Error(templateData.error);

    showSuccess('✅ Faction War Feed configuration saved!');

  } catch (error) {
    console.error('Error saving faction feed:', error);
    showError('❌ Failed to save: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save Configuration';
  }
});

// Test faction feed
document.getElementById('testFactionFeed').addEventListener('click', async () => {
  if (!currentGuildId || !currentServerId) return;

  const btn = document.getElementById('testFactionFeed');
  btn.disabled = true;
  btn.textContent = '🧪 Sending...';

  try {
    const response = await fetchWithCsrf(`/api/feeds/${currentGuildId}/${currentServerId}/test`, {
      method: 'POST',
      body: JSON.stringify({ feedType: 'faction_feed' })
    });

    const data = await response.json();

    if (data.success) {
      showSuccess('✅ Test message sent!');
    } else {
      throw new Error(data.error);
    }

  } catch (error) {
    console.error('Error sending faction feed test:', error);
    showError('❌ Failed to send test: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🧪 Send Test Message';
  }
});

// Helper: Insert variable into template
function insertVariable(textareaId, variable) {
  const textarea = document.getElementById(textareaId);
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  textarea.value = text.substring(0, start) + variable + text.substring(end);
  textarea.focus();
  textarea.setSelectionRange(start + variable.length, start + variable.length);
}

// Show success message
function showSuccess(message) {
  const el = document.getElementById('alertSuccess');
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
  }, 5000);
}

// Show error message
function showError(message) {
  const el = document.getElementById('alertError');
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
  }, 5000);
}

// Event delegation for variable-tag inserts
document.addEventListener('click', (e) => {
  const tag = e.target.closest('.variable-tag[data-textarea]');
  if (!tag) return;
  insertVariable(tag.dataset.textarea, tag.dataset.variable);
});

document.addEventListener('keydown', (e) => {
  const tag = e.target.closest('.variable-tag[data-textarea]');
  if (!tag) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    insertVariable(tag.dataset.textarea, tag.dataset.variable);
  }
});
