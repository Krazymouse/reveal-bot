// Discord Reveal Bot (Private Thread Version, with /submit Command)
// ---------------------------------------------------
// Features:
// - /startmatch: Creates a temporary private thread for 2 players.
// - Players can either type their secret choice directly (bot stores & deletes) OR use /submit.
// - /submit: Lets players submit their pick as a slash command (no Message Content intent needed).
// - /reveal: Posts both stored choices simultaneously.
// - Thread auto-deletes after 10 minutes.
// ---------------------------------------------------

import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType, EmbedBuilder, Partials, PermissionFlagsBits } from 'discord.js';

// In-memory store (for simplicity)
const matchData = new Map(); // threadId -> { playerA: string|null, playerB: string|null, ids: [idA, idB] }

const commands = [
  new SlashCommandBuilder()
    .setName('startmatch')
    .setDescription('Start a new match and create a private reveal thread')
    .addUserOption(o => o.setName('opponent').setDescription('Your opponent').setRequired(true)),

  new SlashCommandBuilder()
    .setName('reveal')
    .setDescription('Reveal both players’ stored choices in this thread'),

  new SlashCommandBuilder()
    .setName('submit')
    .setDescription('Submit your hidden choice to this match thread')
    .addStringOption(o => o.setName('choice').setDescription('Your secret choice').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  const { CLIENT_ID, MULTI_GUILD_IDS, GUILD_ID } = process.env;
  if (!CLIENT_ID) throw new Error('Missing CLIENT_ID in env');

  const ids = (MULTI_GUILD_IDS ?? GUILD_ID ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (ids.length > 0) {
    for (const gid of ids) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: commands });
      console.log('Registered GUILD commands for', gid);
    }
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered GLOBAL commands');
  }
}


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'startmatch') {
      if (!interaction.inGuild()) {
        return interaction.reply({ content: 'Use this in a server.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const opponent = interaction.options.getUser('opponent', true);
      const starter = interaction.user;
      const parentChannel = interaction.channel;

      if (parentChannel.type !== ChannelType.GuildText && parentChannel.type !== ChannelType.GuildAnnouncement) {
        return interaction.editReply('Please run /startmatch in a regular text channel (not in a thread/forum).');
      }

      // Create a private thread for the match
      let thread;
      try {
        thread = await parentChannel.threads.create({
          name: `match-${starter.username}-vs-${opponent.username}`,
          autoArchiveDuration: 60,
          type: ChannelType.PrivateThread,
          reason: 'Match reveal thread'
        });
      } catch (err) {
        console.error('Thread create failed:', err);
        return interaction.editReply('I could not create a private thread. I may be missing the **Create Private Threads** permission.');
      }

      // Add both players to the private thread
      try { await thread.members.add(starter.id); } catch {}
      try { await thread.members.add(opponent.id); } catch {}

      matchData.set(thread.id, { playerA: null, playerB: null, ids: [starter.id, opponent.id] });

      await interaction.editReply(`Match thread created: <#${thread.id}> (will delete in ~10 minutes)`);
      await thread.send(`Welcome <@${starter.id}> and <@${opponent.id}>! You can type your choice here (I will hide it), or use /submit.`);

      // Programmatic delete after ~10 minutes
      setTimeout(async () => {
        try {
          await thread.delete();
        } catch {}
        matchData.delete(thread.id);
      }, 10 * 60 * 1000);
    }

    if (interaction.commandName === 'submit') {
      const threadId = interaction.channelId;
      const data = matchData.get(threadId);
      if (!data) {
        return interaction.reply({ content: 'This thread is not a valid match. Use /submit inside the match thread.', ephemeral: true });
      }
      if (!data.ids.includes(interaction.user.id)) {
        return interaction.reply({ content: 'Only the two match players can submit here.', ephemeral: true });
      }

      const choice = interaction.options.getString('choice', true);
      if (interaction.user.id === data.ids[0]) data.playerA = choice;
      else data.playerB = choice;
      matchData.set(threadId, data);

      return interaction.reply({ content: 'Your choice has been recorded (hidden).', ephemeral: true });
    }

    if (interaction.commandName === 'reveal') {
      const threadId = interaction.channelId;
      const data = matchData.get(threadId);
      if (!data) {
        return interaction.reply({ content: 'This thread is not a valid match. Make sure you run /reveal inside the match thread.', ephemeral: true });
      }
      if (!data.playerA || !data.playerB) {
        return interaction.reply({ content: 'Not all players have submitted their choice yet.', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle('Match Reveal')
        .addFields(
          { name: 'Player A', value: data.playerA },
          { name: 'Player B', value: data.playerB }
        )
        .setTimestamp(new Date());

      await interaction.channel.send({ embeds: [embed] });
      await interaction.reply({ content: 'Choices revealed!', ephemeral: true });
      matchData.delete(threadId);
    }
  } catch (err) {
    console.error('interaction error:', err);
    if (interaction.isRepliable()) {
      try {
        if (interaction.deferred) {
          await interaction.editReply('Unexpected error handling this command.');
        } else {
          await interaction.reply({ content: 'Unexpected error handling this command.', ephemeral: true });
        }
      } catch {}
    }
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const threadId = msg.channelId;
  const data = matchData.get(threadId);
  if (!data) return;

  // Only process messages inside the correct match thread
  if (data.ids.includes(msg.author.id)) {
    if (msg.author.id === data.ids[0]) {
      data.playerA = msg.content;
    } else if (msg.author.id === data.ids[1]) {
      data.playerB = msg.content;
    }
    matchData.set(threadId, data);

    try {
      await msg.delete();
      await msg.channel.send({ content: `${msg.author.username} has submitted their choice (hidden).` });
    } catch (err) {
      console.error('Failed to delete message:', err);
      await msg.channel.send({ content: `${msg.author.username} has submitted their choice, but I could not delete their message. Please make sure I have the **Manage Messages** permission.` });
    }
  }
});

registerCommands()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch(err => { console.error('Startup error:', err); process.exit(1); });
