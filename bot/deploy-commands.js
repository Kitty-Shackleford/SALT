const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { SERVER_OPTION_DESCRIPTION } = require('./utils/serverAutocomplete');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function enableServerAutocomplete(options = []) {
  for (const option of options) {
    if (option.name === 'server' && option.type === ApplicationCommandOptionType.String) {
      option.description = SERVER_OPTION_DESCRIPTION;
      option.autocomplete = true;
    }
    enableServerAutocomplete(option.options);
  }
}

function loadCommands() {
  const commands = [];
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    const commandJson = command.data.toJSON();
    enableServerAutocomplete(commandJson.options);
    commands.push(commandJson);
  }
  return commands;
}

function requireDiscordId(value, name) {
  if (!/^\d{16,22}$/.test(String(value || ''))) {
    throw new Error(`${name} must be a valid Discord ID`);
  }
  return String(value);
}

async function deployCommands(options = {}) {
  const commands = options.commands || loadCommands();
  const clientId = requireDiscordId(options.clientId || process.env.DISCORD_CLIENT_ID, 'DISCORD_CLIENT_ID');
  const guildId = options.guildId || process.env.DISCORD_GUILD_ID;
  const token = options.token || process.env.DISCORD_BOT_TOKEN;
  if (!options.rest && !token) throw new Error('DISCORD_BOT_TOKEN is required');
  const rest = options.rest || new REST().setToken(token);

  console.log(`🔄 Refreshing ${commands.length} slash commands...`);
  let route;
  if (guildId) {
    const validatedGuildId = requireDiscordId(guildId, 'DISCORD_GUILD_ID');
    route = Routes.applicationGuildCommands(clientId, validatedGuildId);
    console.log(`📌 Registering to guild ${validatedGuildId} (instant)`);
  } else {
    route = Routes.applicationCommands(clientId);
    console.log('🌐 Registering globally (may take up to 1 hour to appear)');
  }

  const data = await rest.put(route, { body: commands });
  console.log(`✅ Successfully registered ${data.length} slash commands!`);
  return data;
}

if (require.main === module) {
  deployCommands().catch(error => {
    console.error('❌ Error deploying commands:', error);
    process.exitCode = 1;
  });
}

module.exports = { deployCommands, loadCommands, requireDiscordId };
