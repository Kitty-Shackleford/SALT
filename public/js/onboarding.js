// Guided onboarding driven only by authenticated server-side setup state.
(function(){
  'use strict';
  function safeText(node, text){ if(node) node.textContent = text; }
  function safeHref(node, href){ if(node) node.setAttribute('href', href); }

  var labels = {
    discordConnected: 'Discord bot connected',
    guildVerified: 'Guild approved',
    nitradoConnected: 'Nitrado account connected',
    serverRegistered: 'DayZ server registered',
    discordConfigured: 'Discord channels configured',
    moderatorsConfigured: 'Server moderators assigned'
  };

  function addText(parent, tag, text, className){
    var node = document.createElement(tag);
    node.textContent = text;
    if(className) node.className = className;
    parent.appendChild(node);
    return node;
  }

  function renderSetup(payload){
    var root = document.getElementById('setupSteps');
    if(!root) return;
    root.textContent = '';
    var entries = payload && Array.isArray(payload.setup) ? payload.setup : [];
    if(entries.length === 0){
      addText(root, 'p', 'No setup guild is linked to this account yet. Invite the bot, then run /register-token in that Discord guild.', 'muted');
      return;
    }
    entries.forEach(function(entry){
      var card = document.createElement('section');
      card.className = 'guild';
      addText(card, 'h2', entry.guild.name + ' — ' + entry.guild.status);
      var list = document.createElement('ol');
      list.className = 'steps';
      Object.keys(labels).forEach(function(key, index){
        var complete = Boolean(entry.checks && entry.checks[key]);
        addText(list, 'li', (complete ? '✓ ' : '○ ') + 'Step ' + (index + 1) + ' of 6: ' + labels[key], complete ? 'done' : 'todo');
      });
      card.appendChild(list);
      addText(card, 'p', entry.ready ? 'Setup checks passed. Open the dashboard to manage this guild.' : 'Complete the next unchecked step. Use /register-token to connect Nitrado and register servers.', entry.ready ? 'done' : 'muted');
      root.appendChild(card);
    });
  }

  function renderAuthenticationRequired(){
    var root = document.getElementById('setupSteps');
    if(!root) return;
    root.textContent = '';
    addText(root, 'p', 'Sign in with Discord to view setup progress for guilds you own or administer.', 'muted');
    var link = addText(root, 'a', 'Sign in with Discord');
    safeHref(link, '/auth/discord');
  }

  fetch('/api/config').then(function(r){
    if(!r.ok) throw new Error('cfg');
    return r.json();
  }).then(function(cfg){
    if(cfg && cfg.discordClientId){
      var u = 'https://discord.com/oauth2/authorize?client_id=' + encodeURIComponent(cfg.discordClientId) + '&scope=bot%20applications.commands&permissions=277025131008';
      var a = document.getElementById('inviteLink');
      safeHref(a, u);
      safeText(a, 'Invite Bot');
    }
  }).catch(function(){ /* keep the disabled invite link */ });

  fetch('/api/access/setup').then(function(response){
    if(response.status === 401){
      renderAuthenticationRequired();
      return null;
    }
    if(response.status === 429) throw new Error('rate_limit');
    if(!response.ok) throw new Error('setup_unavailable');
    return response.json();
  }).then(function(payload){
    if(payload) renderSetup(payload);
  }).catch(function(error){
    var root = document.getElementById('setupSteps');
    if(!root) return;
    root.textContent = error && error.message === 'rate_limit'
      ? 'Too many setup requests were made. Please wait a few minutes and refresh the page.'
      : 'Setup status is temporarily unavailable. Refresh the page or try again later.';
  });
})();
