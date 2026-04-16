import { loadConfig } from "./config";
import { Orchestrator } from "./core/orchestrator";
import { DiscordChannel } from "./channels/discord";
import { setLogLevel, logger } from "./utils/logger";
import type { Channel } from "./types/channel";

const config = loadConfig();
setLogLevel(config.logLevel);

const orchestrator = new Orchestrator(config);

const channels: Channel[] = [
  new DiscordChannel(config),
  // Future: new TelegramChannel(config),
  // Future: new GoogleChatChannel(config),
];

for (const ch of channels) {
  await ch.start((msg, reply) => orchestrator.handle(msg, reply));
  logger.info(`${ch.name} channel started`);
}

logger.info(`channels-listener running with ${channels.length} channel(s)`);

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down...");
  for (const ch of channels) await ch.stop();
  orchestrator.destroy();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
