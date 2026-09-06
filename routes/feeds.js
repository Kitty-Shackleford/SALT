const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const { formatMessage, formatEmbed } = require('../utils/feedMessageFormatter');
const { postToDiscord, validateDiscordDestination } = require('../utils/discordPoster');
const { requireServerCapability } = require('../middleware/serverAccess');
const { CAPABILITIES } = require('../services/authorizationService');

router.param('serverId', requireServerCapability(CAPABILITIES.SERVER_MANAGE));

function canonicalScope(req) {
  const authorization = req.authorization;
  if (!authorization || String(authorization.guild.discordGuildId) !== String(req.params.guildId)) {
    return null;
  }
  return {
    guildId: String(authorization.guild.discordGuildId),
    serverId: authorization.server.id,
  };
}

/**
 * GET /api/feeds/:guildId
 * Get all feed configurations for a guild
 */
router.get('/:guildId/:serverId', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const scope = canonicalScope(req);
  if (!scope) return res.status(404).json({ error: 'Resource not found' });

  try {
    const feeds = await db.query(
      'SELECT * FROM discord_feeds WHERE guild_id = ? AND server_id = ? ORDER BY feed_type',
      [scope.guildId, scope.serverId]
    );

    // Map snake_case DB columns to camelCase for the frontend
    const feedsWithSettings = feeds.map(feed => ({
      id: feed.id,
      feedType: feed.feed_type,
      enabled: Boolean(feed.enabled),
      channelId: feed.channel_id || '',
      webhookUrl: feed.webhook_url || '',
      settings: feed.settings ? JSON.parse(feed.settings) : {},
    }));

    res.json({ success: true, feeds: feedsWithSettings });

  } catch (error) {
    console.error('Error fetching feeds:', error);
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

/**
 * POST /api/feeds/:guildId
 * Create or update a feed configuration
 */
router.post('/:guildId/:serverId', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const scope = canonicalScope(req);
  if (!scope) return res.status(404).json({ error: 'Resource not found' });
  const { feedType, enabled, channelId, webhookUrl, settings } = req.body;

  if (!feedType) {
    return res.status(400).json({ error: 'feedType is required' });
  }

  try {
    if (!(await validateDiscordDestination(scope.guildId, channelId, webhookUrl))) {
      return res.status(400).json({ error: 'Feed destination must belong to this Discord guild' });
    }

    const settingsJson = JSON.stringify(settings || {});

    await db.run(
      `INSERT INTO discord_feeds (guild_id, server_id, feed_type, enabled, channel_id, webhook_url, settings, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(server_id, feed_type) DO UPDATE SET
         guild_id = excluded.guild_id,
         enabled = excluded.enabled,
         channel_id = excluded.channel_id,
         webhook_url = excluded.webhook_url,
         settings = excluded.settings,
         updated_at = CURRENT_TIMESTAMP`,
      [scope.guildId, scope.serverId, feedType, enabled ? 1 : 0, channelId, webhookUrl, settingsJson]
    );

    res.json({ success: true, message: 'Feed configuration saved' });

  } catch (error) {
    console.error('Error saving feed:', error);
    res.status(500).json({ error: 'Failed to save feed configuration' });
  }
});

/**
 * GET /api/feeds/:guildId/templates
 * Get all templates for a guild's feeds
 */
router.get('/:guildId/:serverId/templates', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const scope = canonicalScope(req);
  if (!scope) return res.status(404).json({ error: 'Resource not found' });

  try {
    const rows = await db.query(
      'SELECT * FROM feed_templates WHERE guild_id = ? AND server_id = ? ORDER BY feed_type, event_type',
      [scope.guildId, scope.serverId]
    );

    // Map snake_case DB columns to camelCase for the frontend
    const templates = rows.map(t => ({
      id: t.id,
      feedType: t.feed_type,
      eventType: t.event_type,
      template: t.template,
      embedEnabled: Boolean(t.embed_enabled),
      embedColor: t.embed_color || '#FF0000',
    }));

    res.json({ success: true, templates });

  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

/**
 * POST /api/feeds/:guildId/templates
 * Create or update a feed template
 */
router.post('/:guildId/:serverId/templates', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const scope = canonicalScope(req);
  if (!scope) return res.status(404).json({ error: 'Resource not found' });
  const { feedType, eventType, template, embedEnabled, embedColor } = req.body;

  if (!feedType || !eventType || !template) {
    return res.status(400).json({ error: 'feedType, eventType, and template are required' });
  }

  try {
    await db.run(
      `INSERT INTO feed_templates (guild_id, server_id, feed_type, event_type, template, embed_enabled, embed_color, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(server_id, feed_type, event_type) DO UPDATE SET
         guild_id = excluded.guild_id,
         template = excluded.template,
         embed_enabled = excluded.embed_enabled,
         embed_color = excluded.embed_color,
         updated_at = CURRENT_TIMESTAMP`,
      [scope.guildId, scope.serverId, feedType, eventType, template, embedEnabled ? 1 : 0, embedColor || '#FF0000']
    );

    res.json({ success: true, message: 'Template saved' });

  } catch (error) {
    console.error('Error saving template:', error);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

/**
 * POST /api/feeds/:guildId/test
 * Send a test message to verify feed configuration
 */
router.post('/:guildId/:serverId/test', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const scope = canonicalScope(req);
  if (!scope) return res.status(404).json({ error: 'Resource not found' });
  const { feedType } = req.body;

  try {
    const feed = await db.get(
      'SELECT * FROM discord_feeds WHERE guild_id = ? AND server_id = ? AND feed_type = ?',
      [scope.guildId, scope.serverId, feedType]
    );

    if (!feed) {
      return res.status(404).json({ error: 'Feed not configured' });
    }
    if (!(await validateDiscordDestination(scope.guildId, feed.channel_id, feed.webhook_url))) {
      return res.status(400).json({ error: 'Feed destination no longer belongs to this Discord guild' });
    }

    // Get template
    const template = await db.get(
      `SELECT template, embed_enabled, embed_color FROM feed_templates
       WHERE guild_id = ? AND server_id = ? AND feed_type = ? AND event_type = 'player_kill'`,
      [scope.guildId, scope.serverId, feedType]
    );

    // Create test data
    const testData = {
      killer: 'TestPlayer1',
      victim: 'TestPlayer2',
      weapon: 'M4A1',
      distance: 150
    };

    // Format message
    const templateText = template?.template || '☠️ **{killer}** killed **{victim}** with {weapon} ({distance}m)';
    const message = formatMessage(templateText, testData, 'Test Server');

    // Get settings
    const settings = feed.settings ? JSON.parse(feed.settings) : {};
    const useEmbed = settings.useEmbed || template?.embed_enabled || false;
    const embedColor = settings.embedColor || template?.embed_color || '#ff0000';

    // Create content
    const content = useEmbed
      ? formatEmbed(message + ' *(This is a test message)*', embedColor, 'player_kill')
      : message + ' *(This is a test message)*';

    // Post to Discord
    const success = await postToDiscord(feed.channel_id, feed.webhook_url, content, useEmbed);

    if (success) {
      res.json({ success: true, message: 'Test message sent!' });
    } else {
      res.status(500).json({ error: 'Failed to send test message' });
    }

  } catch (error) {
    console.error('Error sending test:', error);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});

module.exports = router;
