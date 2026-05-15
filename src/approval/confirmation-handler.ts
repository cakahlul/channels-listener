import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
} from "discord.js";
import { logger } from "../utils/logger";

export interface ConfirmationRequest {
  /** Discord user ID to DM. */
  userId: string;
  /** Message shown to the user. */
  prompt: string;
  /** Optional title for the embed (defaults to "Confirm action"). */
  title?: string;
  /** How long to wait for a click before auto-denying. */
  timeoutMs?: number;
}

export interface ConfirmationResult {
  approved: boolean;
  decidedBy: string;
}

export class ConfirmationHandler {
  private client: Client;
  private defaultTimeoutMs: number;
  private pending = new Map<string, (result: ConfirmationResult) => void>();
  private counter = 0;

  constructor(opts: { client: Client; timeoutMs?: number }) {
    this.client = opts.client;
    this.defaultTimeoutMs = opts.timeoutMs ?? 300_000;

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("confirm:")) return;
      await this.handleButton(interaction as ButtonInteraction);
    });
  }

  async requestConfirmation(req: ConfirmationRequest): Promise<ConfirmationResult> {
    const requestId = `cfm_${Date.now()}_${++this.counter}`;
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;

    const user = await this.client.users.fetch(req.userId);
    const dm = await user.createDM();

    const embed = new EmbedBuilder()
      .setTitle(req.title ?? "🔔 Confirm action")
      .setDescription(req.prompt)
      .setColor(0x0ea5e9)
      .setFooter({ text: `Auto-declines in ${Math.round(timeoutMs / 1000)}s` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm:${requestId}:yes`)
        .setLabel("Yes")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`confirm:${requestId}:no`)
        .setLabel("No")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger),
    );

    const message = await dm.send({ embeds: [embed], components: [row] });

    logger.info(`[confirm] Sent ${requestId} to user ${req.userId}`);

    return new Promise<ConfirmationResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const timeoutEmbed = EmbedBuilder.from(embed)
          .setColor(0x94a3b8)
          .setTitle(`⏰ Confirmation timed out`);
        message.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
        resolve({ approved: false, decidedBy: "timeout" });
      }, timeoutMs);

      this.pending.set(requestId, (result) => {
        clearTimeout(timer);
        const updated = EmbedBuilder.from(embed)
          .setColor(result.approved ? 0x22c55e : 0xef4444)
          .setTitle(`${result.approved ? "✅ Confirmed" : "❌ Declined"}`)
          .addFields({ name: "Decided by", value: result.decidedBy, inline: true });
        message.edit({ embeds: [updated], components: [] }).catch(() => {});
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
        content: "⚠️ This confirmation has already been handled or expired.",
        ephemeral: true,
      });
      return;
    }

    this.pending.delete(requestId);
    const approved = action === "yes";
    const decidedBy = interaction.user.username;

    await interaction.reply({
      content: approved ? `✅ Confirmed by **${decidedBy}**.` : `❌ Declined by **${decidedBy}**.`,
      ephemeral: false,
    });

    resolver({ approved, decidedBy });
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
