require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const db = require('./db');

const { TOKEN, PREMIUM_SKU_ID, PREMIUM_URL, OWNER_IDS = '', SUPPORT_GUILD_ID, PREMIUM_ROLE_ID = '' } = process.env;
if (!TOKEN) {
  console.error('กรุณาตั้งค่า TOKEN ในไฟล์ .env');
  process.exit(1);
}

const COOLDOWN_MS = 5000;

// ---------- แพ็กเกจ ----------
const FREE_MAX_CREATORS = 5; // แพ็กเกจฟรี
const PREMIUM_MAX_CREATORS = 25; // Premium
const owners = new Set(OWNER_IDS.split(',').map((x) => x.trim()).filter(Boolean));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const cooldowns = new Map();

// ---------- Slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('ตั้งค่าบอท')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('voice-temp')
        .setDescription('สร้างห้อง Join to Create (ลากไปวางหมวดไหน ก็ใช้งานในหมวดนั้น)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('ใช้ห้องเสียงที่มีอยู่แล้วเป็นห้อง Join to Create แทนการสร้างใหม่')
            .addChannelTypes(ChannelType.GuildVoice),
        )
        .addChannelOption((o) =>
          o
            .setName('category')
            .setDescription('สร้างห้อง Join to Create ในหมวดหมู่นี้เลย (ไม่ใส่ = สร้างแล้วลากไปวางเอง)')
            .addChannelTypes(ChannelType.GuildCategory),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('ดูห้อง Join to Create ทั้งหมดของเซิร์ฟเวอร์'))
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('เลิกใช้ห้อง Join to Create')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('ห้อง Join to Create ที่จะเอาออก')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addBooleanOption((o) => o.setName('delete_channel').setDescription('ลบห้องนี้ทิ้งด้วยหรือไม่')),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('premium')
    .setDescription('แพ็กเกจ Premium')
    .addSubcommand((s) => s.setName('status').setDescription('ดูแพ็กเกจและจำนวนห้อง Join ของเซิร์ฟเวอร์นี้'))
    .addSubcommand((s) =>
      s
        .setName('grant')
        .setDescription('(เจ้าของบอท) มอบ Premium ให้เซิร์ฟเวอร์')
        .addStringOption((o) => o.setName('guild_id').setDescription('ไอดีเซิร์ฟเวอร์').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('revoke')
        .setDescription('(เจ้าของบอท) ยกเลิก Premium ของเซิร์ฟเวอร์')
        .addStringOption((o) => o.setName('guild_id').setDescription('ไอดีเซิร์ฟเวอร์').setRequired(true)),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('vc')
    .setDescription('จัดการห้องเสียงชั่วคราวของคุณ')
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('เปลี่ยนชื่อห้อง')
        .addStringOption((o) =>
          o.setName('name').setDescription('ชื่อใหม่').setRequired(true).setMaxLength(90),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('limit')
        .setDescription('จำกัดจำนวนคน (0 = ไม่จำกัด)')
        .addIntegerOption((o) =>
          o.setName('count').setDescription('จำนวนคน').setRequired(true).setMinValue(0).setMaxValue(99),
        ),
    )
    .addSubcommand((s) => s.setName('lock').setDescription('ล็อกห้อง ไม่ให้คนอื่นเข้า'))
    .addSubcommand((s) => s.setName('unlock').setDescription('ปลดล็อกห้อง'))
    .addSubcommand((s) =>
      s
        .setName('transfer')
        .setDescription('โอนความเป็นเจ้าของห้อง')
        .addUserOption((o) => o.setName('user').setDescription('คนที่จะรับช่วงต่อ').setRequired(true)),
    )
    .toJSON(),
];

async function registerCommands(guild) {
  await guild.commands.set(commands).catch((e) => console.error(`register fail ${guild.id}:`, e.message));
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  try {
    if (interaction.commandName === 'setup') return await handleSetup(interaction);
    if (interaction.commandName === 'premium') return await handlePremium(interaction);
    if (interaction.commandName === 'vc') return await handleVc(interaction);
  } catch (err) {
    console.error(err);
    const msg = '❌ เกิดข้อผิดพลาด ตรวจสอบสิทธิ์ของบอทอีกครั้ง';
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

// ---------- Premium ----------
// เป็น Premium ได้จากอย่างใดอย่างหนึ่ง:
//  1) ถูกมอบสิทธิ์ใน DB (/premium grant)
//  2) มี entitlement ของ SKU ใน Discord (PREMIUM_SKU_ID)
//  3) เจ้าของเซิร์ฟเวอร์ หรือคนที่สั่งคำสั่ง มี Role Premium ในเซิร์ฟเวอร์ซัพพอร์ตของบอท
const premiumRoleIds = new Set(PREMIUM_ROLE_ID.split(',').map((x) => x.trim()).filter(Boolean));
const upgradeHint = premiumRoleIds.size ? ' (หรือรับ Role Premium ในเซิร์ฟเวอร์ซัพพอร์ตของบอท)' : '';
const roleCache = new Map(); // userId -> { value, at }
const ROLE_CACHE_MS = 60_000;

async function hasPremiumRole(userId) {
  if (!SUPPORT_GUILD_ID || premiumRoleIds.size === 0) return false;

  const cached = roleCache.get(userId);
  if (cached && Date.now() - cached.at < ROLE_CACHE_MS) return cached.value;

  let value = false;
  try {
    const support = client.guilds.cache.get(SUPPORT_GUILD_ID) ?? (await client.guilds.fetch(SUPPORT_GUILD_ID));
    // force: true = ดึงสดจาก API เสมอ เพราะบอทไม่ได้ใช้ GuildMembers intent จึงไม่ได้รับอัปเดต Role อัตโนมัติ
    const member = await support.members.fetch({ user: userId, force: true }).catch(() => null);
    value = !!member && member.roles.cache.some((r) => premiumRoleIds.has(r.id));
  } catch (err) {
    console.error('ตรวจ Role Premium ไม่สำเร็จ:', err.message);
  }
  roleCache.set(userId, { value, at: Date.now() });
  return value;
}

const PREMIUM_REASONS = {
  manual: 'มอบสิทธิ์โดยเจ้าของบอท',
  subscription: 'สมัครผ่าน Discord',
  'owner-role': 'เจ้าของเซิร์ฟเวอร์มี Role Premium',
  role: 'คุณมี Role Premium',
};

// คืนเหตุผลที่เป็น Premium หรือ null ถ้าเป็นแพ็กเกจฟรี
async function getPremium(interaction) {
  if (db.isPremium(interaction.guildId)) return 'manual';
  if (PREMIUM_SKU_ID && interaction.entitlements.some((e) => e.skuId === PREMIUM_SKU_ID && e.isActive())) {
    return 'subscription';
  }
  if (await hasPremiumRole(interaction.guild.ownerId)) return 'owner-role';
  if (await hasPremiumRole(interaction.user.id)) return 'role';
  return null;
}

// ปุ่มอัปเกรด: ปุ่ม Premium ของ Discord ถ้าตั้ง PREMIUM_SKU_ID ไม่งั้นปุ่มลิงก์ถ้าตั้ง PREMIUM_URL
function upgradeRow() {
  const row = new ActionRowBuilder();
  if (PREMIUM_SKU_ID) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(PREMIUM_SKU_ID));
  else if (PREMIUM_URL) {
    row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('อัปเกรด Premium').setURL(PREMIUM_URL));
  } else return [];
  return [row];
}

async function handlePremium(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    await interaction.deferReply(ephemeral);
    const used = db.listCreators(interaction.guildId).length;
    const reason = await getPremium(interaction);
    return interaction.editReply({
      content: reason
        ? `⭐ เซิร์ฟเวอร์นี้ใช้ **Premium** (${PREMIUM_REASONS[reason]}) — ห้อง Join ${used}/${PREMIUM_MAX_CREATORS}`
        : `แพ็กเกจ **ฟรี** — ห้อง Join ${used}/${FREE_MAX_CREATORS}\nอัปเกรด Premium${upgradeHint} เพื่อตั้งได้สูงสุด ${PREMIUM_MAX_CREATORS} ห้อง`,
      components: reason ? [] : upgradeRow(),
    });
  }

  // grant / revoke: เฉพาะเจ้าของบอทที่ระบุไว้ใน OWNER_IDS
  if (!owners.has(interaction.user.id)) {
    return interaction.reply({ content: '❌ คำสั่งนี้สำหรับเจ้าของบอทเท่านั้น', ...ephemeral });
  }
  const guildId = interaction.options.getString('guild_id', true).trim();
  if (!/^\d{15,25}$/.test(guildId)) {
    return interaction.reply({ content: '❌ ไอดีเซิร์ฟเวอร์ไม่ถูกต้อง', ...ephemeral });
  }
  if (sub === 'grant') db.grantPremium(guildId);
  else db.revokePremium(guildId);
  return interaction.reply({
    content: `✅ ${sub === 'grant' ? 'มอบ' : 'ยกเลิก'} Premium ของเซิร์ฟเวอร์ \`${guildId}\` แล้ว`,
    ...ephemeral,
  });
}

// ---------- /setup ----------
const ephemeral = { flags: MessageFlags.Ephemeral };
const categoryName = (guild, channelId) => guild.channels.cache.get(channelId)?.parent?.name ?? 'ไม่มีหมวดหมู่';

async function handleSetup(interaction) {
  switch (interaction.options.getSubcommand()) {
    case 'list':
      return setupList(interaction);
    case 'remove':
      return setupRemove(interaction);
    default:
      return setupAdd(interaction);
  }
}

async function setupList(interaction) {
  const { guild } = interaction;
  const ids = db.listCreators(guild.id);
  if (!ids.length) {
    return interaction.reply({ content: 'ยังไม่มีการตั้งค่า ใช้ `/setup voice-temp` เพื่อเริ่มต้น', ...ephemeral });
  }
  const lines = ids.map((id) =>
    guild.channels.cache.has(id)
      ? `• <#${id}> — หมวดหมู่: ${categoryName(guild, id)}`
      : `• (ห้องถูกลบไปแล้ว) \`${id}\``,
  );
  return interaction.reply({ content: `**ห้อง Join to Create (${ids.length})**\n${lines.join('\n')}`, ...ephemeral });
}

async function setupRemove(interaction) {
  const { guild } = interaction;
  const channel = interaction.options.getChannel('channel', true);
  if (channel.guildId !== guild.id || !db.isCreator(channel.id)) {
    return interaction.reply({ content: '❌ ห้องนี้ไม่ได้ถูกตั้งเป็นห้อง Join to Create', ...ephemeral });
  }
  db.removeCreator(channel.id);
  let note = '';
  if (interaction.options.getBoolean('delete_channel')) {
    await guild.channels.delete(channel.id).catch(() => (note = ' (ลบห้องไม่สำเร็จ ตรวจสอบสิทธิ์ของบอท)'));
  }
  return interaction.reply({
    content: `✅ เลิกใช้ <#${channel.id}> แล้ว${note}\nห้องชั่วคราวที่เปิดอยู่จะยังอยู่จนกว่าจะว่าง`,
    ...ephemeral,
  });
}

async function setupAdd(interaction) {
  const { guild } = interaction;
  await interaction.deferReply(ephemeral);

  // เช็กสิทธิ์ของบอทก่อน
  const me = guild.members.me;
  const needed = [
    ['ManageChannels', 'Manage Channels'],
    ['MoveMembers', 'Move Members'],
    ['Connect', 'Connect'],
    ['ViewChannel', 'View Channel'],
  ];
  const missing = needed.filter(([k]) => !me.permissions.has(PermissionFlagsBits[k])).map(([, n]) => n);
  if (missing.length) {
    return interaction.editReply(`❌ บอทยังขาดสิทธิ์: **${missing.join(', ')}**`);
  }

  const existing = db.listCreators(guild.id);
  const premium = !!(await getPremium(interaction));
  const limit = premium ? PREMIUM_MAX_CREATORS : FREE_MAX_CREATORS;
  if (existing.length >= limit) {
    return interaction.editReply({
      content: premium
        ? `❌ ตั้งได้สูงสุด ${limit} ห้องต่อเซิร์ฟเวอร์ ใช้ \`/setup remove\` เพื่อเอาห้องเก่าออกก่อน`
        : `🔒 แพ็กเกจฟรีตั้งได้สูงสุด **${FREE_MAX_CREATORS} ห้อง** ต่อเซิร์ฟเวอร์\n` +
          `อัปเกรด **Premium**${upgradeHint} เพื่อตั้งได้สูงสุด ${PREMIUM_MAX_CREATORS} ห้อง (หรือใช้ \`/setup remove\` เอาห้องเก่าออก)`,
      components: premium ? [] : upgradeRow(),
    });
  }

  let channel = interaction.options.getChannel('channel');
  const categoryOpt = interaction.options.getChannel('category');

  if (channel) {
    if (db.isCreator(channel.id)) return interaction.editReply('❌ ห้องนี้ถูกตั้งเป็นห้อง Join to Create อยู่แล้ว');
  } else {
    if (categoryOpt && existing.some((id) => guild.channels.cache.get(id)?.parentId === categoryOpt.id)) {
      return interaction.editReply('❌ หมวดหมู่นี้มีห้อง Join to Create อยู่แล้ว');
    }
    channel = await guild.channels.create({
      name: '➕ Join to Create',
      type: ChannelType.GuildVoice,
      ...(categoryOpt && { parent: categoryOpt.id }),
    });
  }

  db.addCreator(guild.id, channel.id);

  return interaction.editReply(
    `✅ เพิ่ม <#${channel.id}> แล้ว (ตอนนี้อยู่ที่: ${categoryName(guild, channel.id)})\n` +
      '👉 **ลากห้องนี้ไปวางในหมวดหมู่ที่ต้องการ** ห้องส่วนตัวจะถูกสร้างในหมวดที่ห้องนี้อยู่ ณ ตอนที่มีคนเข้า ย้ายเมื่อไหร่ก็ได้\n' +
      `อยากได้หลายหมวดหมู่ ให้พิมพ์ \`/setup voice-temp\` อีกครั้งแล้วลากห้องใหม่ไปวาง • ตอนนี้ใช้ไป ${existing.length + 1}/${limit} ห้อง`,
  );
}

// ---------- /vc ----------
async function handleVc(interaction) {
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  const channel = interaction.member?.voice?.channel;
  if (!channel || !db.isTemp(channel.id)) {
    return reply('❌ คุณต้องอยู่ในห้องเสียงชั่วคราวก่อนถึงจะใช้คำสั่งนี้ได้');
  }
  if (db.getOwner(channel.id) !== interaction.user.id) {
    return reply('❌ เฉพาะเจ้าของห้องเท่านั้นที่ใช้คำสั่งนี้ได้');
  }

  switch (interaction.options.getSubcommand()) {
    case 'rename':
      await channel.setName(interaction.options.getString('name'));
      return reply('✅ เปลี่ยนชื่อห้องแล้ว');
    case 'limit': {
      const count = interaction.options.getInteger('count');
      await channel.setUserLimit(count);
      return reply(`✅ ตั้งจำนวนคนสูงสุดเป็น ${count === 0 ? 'ไม่จำกัด' : count}`);
    }
    case 'lock':
      await channel.permissionOverwrites.edit(channel.guild.id, { Connect: false });
      return reply('🔒 ล็อกห้องแล้ว');
    case 'unlock':
      await channel.permissionOverwrites.edit(channel.guild.id, { Connect: null });
      return reply('🔓 ปลดล็อกห้องแล้ว');
    case 'transfer': {
      const target = interaction.options.getMember('user');
      if (!target || target.voice.channelId !== channel.id || target.user.bot) {
        return reply('❌ ผู้ใช้ที่เลือกต้องอยู่ในห้องนี้ (และต้องไม่ใช่บอท)');
      }
      await setOwner(channel, target.id, interaction.user.id);
      return reply(`👑 โอนห้องให้ ${target} แล้ว`);
    }
  }
}

// ---------- Temp channel logic ----------
const OWNER_PERMS = {
  ManageChannels: true,
  Connect: true,
  MoveMembers: true,
  MuteMembers: true,
  DeafenMembers: true,
};

async function setOwner(channel, newOwnerId, oldOwnerId) {
  await channel.permissionOverwrites.edit(newOwnerId, OWNER_PERMS);
  if (oldOwnerId && oldOwnerId !== newOwnerId) {
    await channel.permissionOverwrites.delete(oldOwnerId).catch(() => {});
  }
  db.setTemp(channel.id, newOwnerId);
}

async function createTempChannel(state) {
  const { guild, member, channel: creator } = state;

  const last = cooldowns.get(member.id) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    return member.voice.disconnect('Cooldown').catch(() => {});
  }
  cooldowns.set(member.id, Date.now());

  const channel = await guild.channels.create({
    name: `🔊 ห้องของ ${member.displayName}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: creator.parentId,
    bitrate: guild.maximumBitrate, // สูงสุดตามเลเวลบูสต์ของเซิร์ฟเวอร์
    permissionOverwrites: [
      ...creator.permissionOverwrites.cache.values(),
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.DeafenMembers,
        ],
      },
    ],
    reason: `Temp voice channel for ${member.user.tag}`,
  });

  db.setTemp(channel.id, member.id);

  // ผู้ใช้อาจออกจากห้องไปก่อนระหว่างสร้าง
  if (member.voice.channelId !== creator.id) {
    return deleteTempChannel(channel);
  }
  await member.voice.setChannel(channel).catch(() => deleteTempChannel(channel));
}

async function deleteTempChannel(channel) {
  db.removeTemp(channel.id);
  await channel.delete('Temp voice channel empty').catch(() => {});
}

const humansIn = (ch) => ch.members.filter((m) => !m.user.bot);

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    // 1) เข้าห้อง "Join to Create" ของเซิร์ฟเวอร์นั้นๆ
    if (db.isCreator(newState.channelId) && newState.member && !newState.member.user.bot) {
      await createTempChannel(newState);
    }

    // 2) ออก/ย้ายจากห้องชั่วคราว
    const oldCh = oldState.channel;
    if (oldCh && db.isTemp(oldCh.id)) {
      const humans = humansIn(oldCh);
      if (humans.size === 0) {
        await deleteTempChannel(oldCh);
      } else if (db.getOwner(oldCh.id) === oldState.id) {
        await setOwner(oldCh, humans.first().id, oldState.id);
      }
    }
  } catch (err) {
    console.error('voiceStateUpdate error:', err);
  }
});

client.on('channelDelete', (channel) => {
  db.removeTemp(channel.id);
  db.removeCreator(channel.id);
});

// ลบข้อมูลของเซิร์ฟเวอร์ที่บอทโดนเตะออก / เพิ่มคำสั่งให้เซิร์ฟเวอร์ใหม่
client.on('guildDelete', (guild) => {
  db.removeGuild(guild.id);
  for (const id of guild.channels.cache.keys()) db.removeTemp(id);
});
client.on('guildCreate', (guild) => registerCommands(guild));

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // เคลียร์ห้องที่ค้างจากตอนบอทปิดอยู่
  for (const id of db.allTempIds()) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch) db.removeTemp(id);
    else if (humansIn(ch).size === 0) await deleteTempChannel(ch);
  }

  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}

client.login(TOKEN);
