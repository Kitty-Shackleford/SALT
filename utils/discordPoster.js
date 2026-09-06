/**
 * Post messages to Discord channels via webhook or bot
 * WITH RATE LIMIT HANDLING
 */

// Track last post time per channel to avoid rate limits
const channelLastPost = new Map();
const MIN_DELAY_MS = 350; // Minimum 350ms between messages to same channel
const DEFAULT_DISCORD_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 15000;

async function fetchDiscord(url, options = {}, timeoutMs = DEFAULT_DISCORD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Discord request timed out')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait if needed to avoid rate limits for a channel
 */
async function waitForRateLimit(channelId) {
  if (!channelId) return;

  const lastPost = channelLastPost.get(channelId);
  if (lastPost) {
    const timeSince = Date.now() - lastPost;
    if (timeSince < MIN_DELAY_MS) {
      const waitTime = MIN_DELAY_MS - timeSince;
      console.log(`⏳ Rate limit: waiting ${waitTime}ms before posting to channel ${channelId}`);
      await sleep(waitTime);
    }
  }

  channelLastPost.set(channelId, Date.now());
}

async function validateDiscordDestination(discordGuildId, channelId, webhookUrl) {
  const expectedGuildId = String(discordGuildId || '');
  if (!expectedGuildId || (!channelId && !webhookUrl)) return false;

  if (channelId) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) return false;
    const response = await fetchDiscord(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${botToken}` }
    });
    if (!response.ok) return false;
    const channel = await response.json();
    if (String(channel.guild_id || '') !== expectedGuildId) return false;
  }

  if (webhookUrl) {
    let parsed;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'discord.com' ||
        !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(parsed.pathname)) {
      return false;
    }
    const response = await fetchDiscord(parsed.toString());
    if (!response.ok) return false;
    const webhook = await response.json();
    if (String(webhook.guild_id || '') !== expectedGuildId) return false;
  }

  return true;
}

/**
 * Post message via webhook
 */
async function postViaWebhook(webhookUrl, content, isEmbed = false, timeoutMs = DEFAULT_DISCORD_TIMEOUT_MS) {
  try {
    const payload = isEmbed ? content : { content };

    const response = await fetchDiscord(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, timeoutMs);

    if (!response.ok) {
      const error = await response.text();

      // Check for rate limit
      if (response.status === 429) {
        try {
          const rateLimitData = JSON.parse(error);
          const retryAfter = Math.min(
            Math.max(Number(rateLimitData.retry_after) || 1, 0) * 1000,
            MAX_RETRY_AFTER_MS
          );
          console.warn(`⚠️ Webhook rate limited, retrying after ${retryAfter}ms`);
          await sleep(retryAfter);

          // Retry once
          const retryResponse = await fetchDiscord(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }, timeoutMs);

          if (retryResponse.ok) {
            console.log('✅ Posted to Discord via webhook (after retry)');
            return true;
          }
        } catch (e) {
          // Fall through to error
        }
      }

      throw new Error(`Webhook failed: ${error}`);
    }

    console.log('✅ Posted to Discord via webhook');
    return true;

  } catch (error) {
    console.error('❌ Webhook post failed:', error.message);
    return false;
  }
}

/**
 * Post message via Discord bot
 */
async function postViaBot(channelId, content, isEmbed = false) {
  try {
    const botToken = process.env.DISCORD_BOT_TOKEN;

    if (!botToken) {
      console.error('❌ Discord bot token not configured');
      return false;
    }

    // Wait for rate limit before posting
    await waitForRateLimit(channelId);

    const payload = isEmbed ? content : { content };

    const response = await fetchDiscord(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();

      // Check for rate limit
      if (response.status === 429) {
        const retryAfter = Math.min(
          Math.max(Number(error.retry_after) || 1, 0) * 1000,
          MAX_RETRY_AFTER_MS
        );
        console.warn(`⚠️ Bot rate limited, retrying after ${retryAfter}ms`);
        await sleep(retryAfter);

        // Update rate limit tracker (sleep already completed)
        channelLastPost.set(channelId, Date.now());

        // Retry once
        const retryResponse = await fetchDiscord(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${botToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (retryResponse.ok) {
          console.log('✅ Posted to Discord via bot (after retry)');
          return true;
        } else {
          const retryError = await retryResponse.json();
          throw new Error(`Bot post failed after retry: ${JSON.stringify(retryError)}`);
        }
      }

      throw new Error(`Bot post failed: ${JSON.stringify(error)}`);
    }

    console.log('✅ Posted to Discord via bot');
    return true;

  } catch (error) {
    console.error('❌ Bot post failed:', error.message);
    return false;
  }
}

/**
 * Post message to Discord (tries webhook first, falls back to bot)
 */
async function postToDiscord(channelId, webhookUrl, content, isEmbed = false) {
  // Try webhook first if provided
  if (webhookUrl) {
    const success = await postViaWebhook(webhookUrl, content, isEmbed);
    if (success) return true;
    console.log('⚠️ Webhook failed, trying bot...');
  }

  // Fall back to bot
  if (channelId) {
    return await postViaBot(channelId, content, isEmbed);
  }

  console.error('❌ No webhook or channel ID provided');
  return false;
}

module.exports = {
  postToDiscord,
  postViaWebhook,
  postViaBot,
  validateDiscordDestination,
  MIN_DELAY_MS
};
