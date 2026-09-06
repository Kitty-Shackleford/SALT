const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureApprovedGuildOperator } = require('../middleware/serverAccess');

/**
 * GET /api/discord/guilds/:guildId/channels
 * Get list of channels in a Discord guild
 */
router.get('/guilds/:guildId/channels', ensureAuthenticated, ensureApprovedGuildOperator, async (req, res) => {
  const guildId = req.guildAccess.discordGuildId;

  try {
    const botToken = process.env.DISCORD_BOT_TOKEN;

    if (!botToken) {
      return res.json({ success: false, error: 'Discord bot token not configured in environment variables' });
    }

    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: {
        'Authorization': `Bot ${botToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch channels from Discord: ${response.status} ${response.statusText}`);
    }

    const channels = await response.json();

    res.json({
      success: true,
      channels: channels.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        position: c.position
      }))
    });

  } catch (error) {
    console.error('Error fetching Discord channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

module.exports = router;
