import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
  type TextChannel,
} from "discord.js";
import type { SessionRegistry } from "./session-registry";
import { logger } from "../utils/logger";

export interface ApprovalRequest {
  /** Unique ID for this approval request */
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  hookEventName: string;
}

export interface ApprovalResult {
  decision: "allow" | "deny";
  decidedBy: string;
}

/** Formats tool input into a readable string for the embed. */
export function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": {
      const cmd = input.command as string | undefined;
      const cwd = input.cwd as string | undefined;
      const reason = input.reason as string | undefined;
      const network = input.networkApprovalContext;
      let out = reason ? `**Reason:** ${reason.slice(0, 300)}\n` : "";
      if (cwd) out += `**Working directory:** \`${cwd}\`\n`;
      if (network) out += `**Network:** \`${JSON.stringify(network).slice(0, 500)}\`\n`;
      if (cmd) out += `\`\`\`sh\n${cmd.slice(0, 900)}\n\`\`\``;
      return out || "_(no command)_";
    }
    case "Edit": {
      const file = input.file_path as string | undefined;
      const old = input.old_string as string | undefined;
      const replacement = input.new_string as string | undefined;
      const reason = input.reason as string | undefined;
      const grantRoot = input.grantRoot as string | undefined;
      const changes = input.changes;
      let out = reason ? `**Reason:** ${reason.slice(0, 300)}\n` : "";
      if (grantRoot) out += `**Grant root:** \`${grantRoot}\`\n`;
      if (file) out += `**File:** \`${file}\`\n`;
      if (old) out += `**Replace:**\n\`\`\`\n${old.slice(0, 400)}\n\`\`\`\n`;
      if (replacement) out += `**With:**\n\`\`\`\n${replacement.slice(0, 400)}\n\`\`\``;
      if (changes) out += `**Changes:**\n\`\`\`json\n${JSON.stringify(changes, null, 2).slice(0, 1200)}\n\`\`\``;
      return out || "_(no details)_";
    }
    case "Write": {
      const file = input.file_path as string | undefined;
      const content = input.content as string | undefined;
      let out = file ? `**File:** \`${file}\`\n` : "";
      if (content) out += `**Content preview:**\n\`\`\`\n${content.slice(0, 500)}\n\`\`\``;
      return out || "_(no details)_";
    }
    case "Read": {
      const file = input.file_path as string | undefined;
      return file ? `**File:** \`${file}\`` : "_(no file)_";
    }
    default: {
      const json = JSON.stringify(input, null, 2);
      if (json.length > 900) return `\`\`\`json\n${json.slice(0, 900)}…\n\`\`\``;
      return `\`\`\`json\n${json}\n\`\`\``;
    }
  }
}

/** Pick an emoji and color based on tool name. */
function toolMeta(toolName: string): { emoji: string; color: number } {
  const map: Record<string, { emoji: string; color: number }> = {
    Bash:       { emoji: "🖥️", color: 0xf59e0b },  // amber
    Edit:       { emoji: "✏️", color: 0x3b82f6 },   // blue
    Write:      { emoji: "📝", color: 0x8b5cf6 },   // purple
    Read:       { emoji: "📖", color: 0x6366f1 },   // indigo
    Glob:       { emoji: "🔍", color: 0x14b8a6 },   // teal
    Grep:       { emoji: "🔎", color: 0x14b8a6 },   // teal
    WebFetch:   { emoji: "🌐", color: 0x0ea5e9 },   // sky
    WebSearch:  { emoji: "🔍", color: 0x0ea5e9 },   // sky
    Agent:      { emoji: "🤖", color: 0x10b981 },   // emerald
  };
  return map[toolName] ?? { emoji: "⚡", color: 0x64748b }; // slate default
}

export class ApprovalHandler {
  private client: Client;
  private registry: SessionRegistry;
  private fallbackChannelId: string | undefined;
  /** Pending approvals: requestId → resolver */
  private pending = new Map<string, (result: ApprovalResult) => void>();
  private timeoutMs: number;

  constructor(opts: {
    client: Client;
    registry: SessionRegistry;
    fallbackChannelId?: string;
    timeoutMs?: number;
  }) {
    this.client = opts.client;
    this.registry = opts.registry;
    this.fallbackChannelId = opts.fallbackChannelId;
    this.timeoutMs = opts.timeoutMs ?? 300_000;

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("approval:")) return;
      await this.handleButton(interaction as ButtonInteraction);
    });
  }

  /** Resolve which Discord channel to send the approval to. */
  private async resolveChannel(sessionId: string) {
    // First try the registry (active session thread/DM)
    const channelId = this.registry.resolve(sessionId) ?? this.fallbackChannelId;

    if (!channelId) {
      throw new Error(
        `No Discord channel found for session ${sessionId} and no fallback configured`
      );
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Discord channel ${channelId} not found or not sendable`);
    }

    return channel as TextChannel;
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    const channel = await this.resolveChannel(req.sessionId);

    const { emoji, color } = toolMeta(req.toolName);
    const details = formatToolInput(req.toolName, req.toolInput);

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} Permission Request: ${req.toolName}`)
      .setDescription(details)
      .setColor(color)
      .setFooter({ text: `Session: ${req.sessionId.slice(0, 8)}… • ${req.hookEventName}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approval:${req.id}:allow`)
        .setLabel("Approve")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`approval:${req.id}:deny`)
        .setLabel("Deny")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger),
    );

    const message = await channel.send({
      content: "🔔 **The agent needs your approval!**",
      embeds: [embed],
      components: [row],
    });

    logger.info(`[approval] Sent request ${req.id} for ${req.toolName} in channel ${channel.id}`);

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        const timeoutEmbed = EmbedBuilder.from(embed)
          .setColor(0x94a3b8)
          .setTitle(`⏰ Permission Request Timed Out: ${req.toolName}`);
        message.edit({
          content: "⏰ **Approval timed out** — automatically denied.",
          embeds: [timeoutEmbed],
          components: [],
        }).catch(() => {});
        resolve({ decision: "deny", decidedBy: "timeout" });
      }, this.timeoutMs);

      this.pending.set(req.id, (result) => {
        clearTimeout(timer);
        const decided = result.decision === "allow";
        const updatedEmbed = EmbedBuilder.from(embed)
          .setColor(decided ? 0x22c55e : 0xef4444)
          .setTitle(
            `${decided ? "✅" : "❌"} ${decided ? "Approved" : "Denied"}: ${req.toolName}`
          )
          .addFields({
            name: "Decision by",
            value: result.decidedBy,
            inline: true,
          });

        message.edit({
          content: decided
            ? "✅ **Approved** — the agent is proceeding."
            : "❌ **Denied** — the agent was told no.",
          embeds: [updatedEmbed],
          components: [],
        }).catch(() => {});

        resolve(result);
      });
    });
  }

  private async handleButton(interaction: ButtonInteraction) {
    const parts = interaction.customId.split(":");
    if (parts.length !== 3) return;

    const requestId = parts[1]!;
    const action = parts[2]!;
    const resolver = this.pending.get(requestId);

    if (!resolver) {
      await interaction.reply({
        content: "⚠️ This approval request has already been handled or expired.",
        ephemeral: true,
      });
      return;
    }

    this.pending.delete(requestId);

    const decision = action === "allow" ? "allow" : "deny";
    const userName = interaction.user.username;

    await interaction.reply({
      content: decision === "allow"
        ? `✅ **${userName}** approved the action! The agent is proceeding.`
        : `❌ **${userName}** denied the action. The agent was stopped.`,
      ephemeral: false,
    });

    resolver({ decision, decidedBy: userName });
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
