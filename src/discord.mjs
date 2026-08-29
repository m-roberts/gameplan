import { createPublicKey, verify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyDiscordSignature({ publicKey, signature, timestamp, rawBody }) {
  if (!publicKey || !signature || !timestamp) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'hex')]),
      format: 'der',
      type: 'spki',
    });

    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]),
      key,
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

export function discordIdentity(interaction) {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id) return null;
  return {
    discordUserId: user.id,
    displayName: user.global_name ?? user.username ?? null,
    guildId: interaction.guild_id ?? null,
    guildPermissions: interaction.member?.permissions ?? null,
    guildRoleIds: interaction.member?.roles ?? [],
  };
}

export function interactionResponse(interaction, { browserUrl } = {}) {
  if (interaction.type === 1) return { type: 1 };

  if (interaction.type === 2 && interaction.data?.name === 'gameplan') {
    if (!browserUrl) throw new Error('browserUrl is required for a /gameplan response');
    return {
      type: 4,
      data: {
        flags: 64,
        content: 'Open GamePlan to link Steam and plan your next game night. This private link expires in 10 minutes.',
        components: [{
          type: 1,
          components: [{
            type: 2,
            style: 5,
            label: 'Open GamePlan',
            url: browserUrl,
          }],
        }],
      },
    };
  }

  return {
    type: 4,
    data: { flags: 64, content: 'Unsupported GamePlan interaction.' },
  };
}

export function ephemeral(content, components = []) { return { type: 4, data: { flags: 64, content, components } }; }
export function browserLinkResponse(content, browserUrl) { return ephemeral(content, [{ type: 1, components: [{ type: 2, style: 5, label: 'Open GamePlan', url: browserUrl }] }]); }
export function prepareDiscordMessage(data, browserUrl = null) {
  const components = [...(data.components ?? [])];
  const prepared = { ...data };
  const hasBrowserLink = components.some((row) => row.components?.some((component) => component.style === 5 && component.url));
  if (browserUrl && prepared.flags === 64 && !hasBrowserLink && components.length < 5) {
    components.push({ type: 1, components: [{ type: 2, style: 5, label: 'Open GamePlan', url: browserUrl }] });
  }
  if (components.length) prepared.components = components;
  if (typeof prepared.content === 'string' && prepared.content.length > 2000) {
    const notice = browserUrl ? '… [Truncated]. Open GamePlan in your browser for the full experience.' : '… [Truncated].';
    prepared.content = `${prepared.content.slice(0, 2000 - notice.length)}${notice}`;
  }
  return prepared;
}
export function deferredInteractionResponse() { return { type: 5, data: { flags: 64 } }; }
export function onboardingCard() { return { type: 4, data: { embeds: [{ title: 'Start your game night with GamePlan', description: 'Link Steam once, see games your group already owns, and plan without the Friday-night chat spiral.', fields: [{ name: 'Private by default', value: 'Your Steam link and browser session are only shown to you. GamePlan never receives your Steam password.' }] }], components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Get started', custom_id: 'onboard:start' }, { type: 2, style: 2, label: 'How it works', custom_id: 'onboard:help' }] }] } }; }
export function helpResponse() { return ephemeral('**GamePlan** helps your Discord group settle on a Steam game and get playing.\n\n**First time**\n1. A server admin runs **/gameplan server** and chooses the **Session Feed** — the channel where confirmed sessions are posted automatically.\n2. Run **/gameplan me**, open your private link, and choose **Link Steam**. GamePlan never sees your Steam password.\n3. Run **/gameplan sync**. Your Steam profile and game details must be public.\n\n**Plan a session**\nRun **/gameplan start** — it opens the plan chooser:\n• **Pick a game** — choose people, see compatible shared games, then set the time.\n• **Decide together** — set the time first, collect attendees, and let them rank game choices.\n• **Use my voice channel** — start from the people currently in your visible voice channel.\n\n**Everyday commands**\n• **/gameplan me** — your Steam and notification status, with a private web link for details.\n• **/gameplan group** — open the group ownership view.\n• **/gameplan games** — see the server’s configured and unconfigured game counts.\n• **/gameplan sessions** — your upcoming plans and RSVPs.\n• **/gameplan invite** — post a getting-started card for friends.\n\nA **game vote** is only used when the game is undecided. Its attendance locks when voting opens; choosing a winner creates the same published GamePlan session as picking a game directly.'); }
export function setupResponse(policy) {
  const rows = [
    { type: 1, components: [{ type: 8, custom_id: 'setup:default-channel', placeholder: 'Choose Session Feed channel', channel_types: [0], min_values: 1, max_values: 1 }] },
  ];
  const done = { type: 2, style: 3, custom_id: 'setup:done', label: 'Done' };
  rows.push({ type: 1, components: [done] });
  return ephemeral(`**GamePlan Session Feed setup**\nSession Feed: ${policy.defaultLfgChannelId ? `<#${policy.defaultLfgChannelId}>` : 'Not chosen yet'}\n\nEvery confirmed GamePlan session is published here automatically, with its own discussion thread. This is not a permission or host-role setting: choosing the feed completes server setup. **/gameplan invite** can be used in any channel where the bot can post.\n\nChanges take effect immediately. Select **Done** when you are finished.`, rows);
}
