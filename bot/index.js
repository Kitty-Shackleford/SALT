const { Client, GatewayIntentBits, Collection, Partials, PermissionFlagsBits } = require('discord.js');
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
const { handleDestinationAutocomplete } = require('./utils/destinationAutocomplete');
const { isSignUpButton, onSignUpInteraction } = require('./utils/interactionButtons');
const { buildSignUpHandlers } = require('./services/teleportEventButtonService');
const { isTicketOpenButton, handleTicketOpen, handleTicketClose, CLOSE_BUTTON_ID } = require('./services/ticketButtonService');
const { isPickerButton, handlePickerClick } = require('./services/pickerButtonService');
const { isSuggestionButton, handleSuggestionClick } = require('./services/suggestionButtonService');
validateEnv('bot');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  // Reaction-role + welcome/goodbye handlers may encounter deleted channels or
  // uncached members before they resolve.
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction]
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
  // Expose the client to event handlers (e.g. guildMemberAdd posts a welcome
  // message; the GuildMemberAdd event only receives the member).
  event.client = client;
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
      const handled = await handleDestinationAutocomplete(interaction, pool);
      if (!handled) {
        await handleServerAutocomplete(interaction, pool);
      }
    } catch (error) {
      console.error('Autocomplete failed:', error && error.message || error);
      if (!interaction.responded) await interaction.respond([]).catch(() => {});
    }
    return;
  }
  // Sign-up event buttons (Join / Leave) — must run before the chat-command
  // early return, matching the ticket button handling.
  if (isSignUpButton(interaction)) {
    try {
      await onSignUpInteraction(interaction, buildSignUpHandlers());
    } catch (error) {
      console.error('Sign-up button failed:', error && error.message || error);
      if (!interaction.responded) {
        await interaction.deferReply({ flags: 64 }).catch(() => {});
      }
    }
    return;
  }
  // Ticket "Open" button — must run before the chat-command early return.
  if (isTicketOpenButton(interaction)) {
    try {
      await handleTicketOpen(interaction);
    } catch (error) {
      console.error('Ticket button failed:', error && error.message || error);
      if (!interaction.responded) {
        await interaction.deferReply({ flags: 64 }).catch(() => {});
      }
    }
    return;
  }
  // Ticket "Close" button.
  if (interaction.isButton?.() && interaction.customId === CLOSE_BUTTON_ID) {
    try {
      await handleTicketClose(interaction);
    } catch (error) {
      console.error('Ticket close failed:', error && error.message || error);
      if (!interaction.responded) {
        await interaction.deferReply({ flags: 64 }).catch(() => {});
      }
    }
    return;
  }
  // Reaction-role picker buttons (rr_btn:<emoji>:<roleId>).
  if (isPickerButton(interaction)) {
    try {
      await handlePickerClick(interaction);
    } catch (error) {
      console.error('Picker button failed:', error && error.message || error);
      if (!interaction.responded) {
        await interaction.deferReply({ flags: 64 }).catch(() => {});
      }
    }
    return;
  }
  // Suggestion Accept/Deny buttons (sugg_accept / sugg_deny).
  if (isSuggestionButton(interaction)) {
    try {
      await handleSuggestionClick(interaction);
    } catch (error) {
      console.error('Suggestion button failed:', error && error.message || error);
      if (!interaction.responded) {
        await interaction.deferReply({ flags: 64 }).catch(() => {});
      }
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
    const hasClassifiedSubcommands = ['report', 'wipe-info', 'birthday', 'suggestions'].includes(interaction.commandName);
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
