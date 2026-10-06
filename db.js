const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // ในตัว Node.js 22.13+ ไม่ต้องติดตั้งเพิ่ม

const DB_PATH = process.env.DB_PATH || './data/bot.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('PRAGMA journal_mode = WAL;');

sqlite.exec(`
  -- ห้อง "Join to Create" (เซิร์ฟเวอร์ละได้หลายห้อง เช่น หนึ่งห้องต่อหมวดหมู่)
  CREATE TABLE IF NOT EXISTS creator_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_creator_guild ON creator_channels (guild_id);

  -- เซิร์ฟเวอร์ที่ได้ Premium ด้วยการมอบสิทธิ์เอง (/premium grant)
  CREATE TABLE IF NOT EXISTS premium_guilds (
    guild_id   TEXT PRIMARY KEY,
    granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- ห้องชั่วคราวที่บอทสร้าง + เจ้าของห้อง
  CREATE TABLE IF NOT EXISTS temp_channels (
    channel_id TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL
  );
`);

// ย้ายข้อมูลจากตารางเวอร์ชันก่อน (guild_settings: เซิร์ฟเวอร์ละ 1 ห้อง)
if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guild_settings'").get()) {
  sqlite.exec(`
    INSERT OR IGNORE INTO creator_channels (channel_id, guild_id)
      SELECT creator_channel_id, guild_id FROM guild_settings;
    DROP TABLE guild_settings;
  `);
}

const q = {
  isCreator: sqlite.prepare('SELECT 1 AS ok FROM creator_channels WHERE channel_id = ?'),
  listCreators: sqlite.prepare('SELECT channel_id FROM creator_channels WHERE guild_id = ?'),
  addCreator: sqlite.prepare(
    `INSERT INTO creator_channels (channel_id, guild_id) VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id`,
  ),
  removeCreator: sqlite.prepare('DELETE FROM creator_channels WHERE channel_id = ?'),
  removeGuild: sqlite.prepare('DELETE FROM creator_channels WHERE guild_id = ?'),
  isPremium: sqlite.prepare('SELECT 1 AS ok FROM premium_guilds WHERE guild_id = ?'),
  grantPremium: sqlite.prepare('INSERT OR IGNORE INTO premium_guilds (guild_id) VALUES (?)'),
  revokePremium: sqlite.prepare('DELETE FROM premium_guilds WHERE guild_id = ?'),
  getOwner: sqlite.prepare('SELECT owner_id FROM temp_channels WHERE channel_id = ?'),
  upsertTemp: sqlite.prepare(
    `INSERT INTO temp_channels (channel_id, owner_id) VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET owner_id = excluded.owner_id`,
  ),
  removeTemp: sqlite.prepare('DELETE FROM temp_channels WHERE channel_id = ?'),
  allTemp: sqlite.prepare('SELECT channel_id FROM temp_channels'),
};

// ---------- ย้ายข้อมูลจาก data.json เวอร์ชันเก่า (ถ้ามี) ----------
const OLD_JSON = './data.json';
if (fs.existsSync(OLD_JSON)) {
  try {
    const old = JSON.parse(fs.readFileSync(OLD_JSON, 'utf8'));
    sqlite.exec('BEGIN');
    try {
      for (const [guildId, channelId] of Object.entries(old.creators ?? {})) q.addCreator.run(channelId, guildId);
      for (const [channelId, ownerId] of Object.entries(old.temp ?? {})) q.upsertTemp.run(channelId, ownerId);
      sqlite.exec('COMMIT');
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
    fs.renameSync(OLD_JSON, `${OLD_JSON}.migrated`);
    console.log('📦 ย้ายข้อมูลจาก data.json เข้า SQLite แล้ว');
  } catch (err) {
    console.error('migrate data.json ไม่สำเร็จ:', err.message);
  }
}

module.exports = {
  isCreator: (channelId) => !!channelId && q.isCreator.get(channelId) !== undefined,
  listCreators: (guildId) => q.listCreators.all(guildId).map((r) => r.channel_id),
  addCreator: (guildId, channelId) => q.addCreator.run(channelId, guildId),
  removeCreator: (channelId) => q.removeCreator.run(channelId),
  removeGuild: (guildId) => q.removeGuild.run(guildId),

  // Premium จะไม่ถูกลบตอนบอทออกจากเซิร์ฟเวอร์ (กลับมาแล้วยังใช้ได้)
  isPremium: (guildId) => q.isPremium.get(guildId) !== undefined,
  grantPremium: (guildId) => q.grantPremium.run(guildId),
  revokePremium: (guildId) => q.revokePremium.run(guildId),

  isTemp: (channelId) => q.getOwner.get(channelId) !== undefined,
  getOwner: (channelId) => q.getOwner.get(channelId)?.owner_id ?? null,
  setTemp: (channelId, ownerId) => q.upsertTemp.run(channelId, ownerId), // สร้างใหม่หรือเปลี่ยนเจ้าของ
  removeTemp: (channelId) => q.removeTemp.run(channelId),
  allTempIds: () => q.allTemp.all().map((r) => r.channel_id),

  close: () => sqlite.close(),
};
