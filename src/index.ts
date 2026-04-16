import { loadConfig } from "./config";
import { Orchestrator } from "./core/orchestrator";
import { DiscordChannel } from "./channels/discord";
import { SessionRegistry } from "./approval/session-registry";
import { ApprovalHandler } from "./approval/handler";
import { startApprovalServer } from "./approval/server";
import { setLogLevel, logger } from "./utils/logger";
import type { Channel } from "./types/channel";

const config = loadConfig();
setLogLevel(config.logLevel);

const registry = new SessionRegistry();
const orchestrator = new Orchestrator(config, registry);

const discord = new DiscordChannel(config);
const channels: Channel[] = [
  discord,
  // Future: new TelegramChannel(config),
  // Future: new GoogleChatChannel(config),
];

for (const ch of channels) {
  await ch.start((msg, reply) => orchestrator.handle(msg, reply));
  logger.info(`${ch.name} channel started`);
}

// Start the approval system (uses the already-connected Discord client)
const approvalHandler = new ApprovalHandler({
  client: discord.getClient(),
  registry,
  fallbackChannelId: config.approvalFallbackChannelId,
  timeoutMs: config.approvalTimeoutMs,
});
const approvalServer = startApprovalServer(approvalHandler, config.approvalServerPort);

logger.info(`channels-listener running with ${channels.length} channel(s)`);

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down...");
  approvalServer.stop();
  for (const ch of channels) await ch.stop();
  orchestrator.destroy();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
