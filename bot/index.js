const { Client, GatewayIntentBits, Collection, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
// Load .env from parent directory to share configuration with main application
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { validateEnv } = require('../utils/envValidator');
const pool = require('./db');
const {
  authorizeGuildCommand,
  commandAuthorizationKey,
} = require('./utils/commandAuthorization');
const { handleServerAutocomplete } = require('./utils/serverAutocomplete');
validateEnv('bot');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  client.commands.set(command.data.name, command);
}

// Load events
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file);
  const event = require(filePath);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

// Handle slash commands
client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    try {
      await handleServerAutocomplete(interaction, pool);
    } catch (error) {
      console.error('Server autocomplete failed:', error && error.message || error);
      if (!interaction.responded) await interaction.respond([]).catch(() => {});
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    let requestedServerId = null;
    try {
      requestedServerId = interaction.options.getString('server');
    } catch {
      // This command has no server selector.
    }
    const hasClassifiedSubcommands = ['report', 'wipe-info'].includes(interaction.commandName);
    const authorizationCommand = commandAuthorizationKey(
      interaction.commandName,
      hasClassifiedSubcommands ? interaction.options.getSubcommand() : null,
      interaction.commandName === 'wipe-info'
        ? interaction.options.getSubcommandGroup(false)
        : null
    );
    const authorization = await authorizeGuildCommand(
      pool,
      interaction.guildId,
      authorizationCommand,
      {
        discordUserId: interaction.user.id,
        requestedServerId,
        isDiscordAdministrator: Boolean(
          interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
        ),
      }
    );
    if (!authorization.allowed) {
      await interaction.reply({
        content: 'You are not authorized to use this command for the selected active server.',
        ephemeral: true,
      });
      return;
    }
    interaction.authorizedServerId = authorization.serverId;
    await command.execute(interaction);
  } catch (error) {
    // Reduce log noise for known non-fatal Discord interaction race conditions.
    const msg = (error && error.message) || '';
    if (msg.includes('Unknown interaction') || msg.includes('Interaction has already been acknowledged') || msg.includes('This interaction failed')) {
      console.warn('Non-fatal interaction error:', msg);
      return;
    }

    console.error('❌ Error executing command:', error && error.stack || error);
    const reply = { content: 'There was an error executing this command!', ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (replyErr) {
      // If replying fails (often due to the same race), log and continue
      console.warn('Failed to notify user about command error:', replyErr && replyErr.message || replyErr);
    }
  }
});

async function startBot() {
  const { initializeDatabase } = require('../db/schema');
  await initializeDatabase();
  await client.login(process.env.DISCORD_BOT_TOKEN);
}

startBot().catch(error => {
  console.error('❌ Failed to start Discord bot:', error);
  process.exit(1);
});
