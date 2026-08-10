import { SlashCommandBuilder } from "discord.js";

/**
 * Slash command definitions, registered per-guild (see registerSlashCommands
 * in client.ts) rather than globally, so they appear instantly instead of
 * waiting for Discord's global-command propagation delay.
 *
 * Registering these requires the bot to have been authorized in the guild
 * with the `applications.commands` scope, in addition to the `bot` scope it
 * was originally invited with — see the README "Discord bot" section.
 */
export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("watchlist")
    .setDescription("Manage the allowlist-only watchlist")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a collection to the watchlist with sensible default filters")
        .addStringOption((opt) =>
          opt
            .setName("collection")
            .setDescription("Collection name, OpenSea slug, or 0x contract address")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a collection from the watchlist")
        .addStringOption((opt) =>
          opt
            .setName("collection")
            .setDescription("Collection name, OpenSea slug, or 0x contract address")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List every current watchlist entry"))
    .addSubcommand((sub) =>
      sub
        .setName("create-rule")
        .setDescription("Guided lead rule: collection + one condition (price, rarity, or a trait)")
        .addStringOption((opt) =>
          opt
            .setName("collection")
            .setDescription("Collection name, OpenSea slug, or 0x contract address")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("condition")
            .setDescription("What should trigger this lead")
            .setRequired(true)
            .addChoices(
              { name: "Price below X ETH", value: "price_below" },
              { name: "Top X% rarity", value: "rarity_top_percent" },
              { name: "Trait = value listed", value: "trait_listed" },
              { name: "Trait floor (trait = value, optional price cap)", value: "trait_floor" },
            ),
        )
        .addNumberOption((opt) =>
          opt.setName("price").setDescription("ETH price — required for price_below, optional cap for trait_floor").setMinValue(0),
        )
        .addNumberOption((opt) =>
          opt.setName("percentile").setDescription("Top X% rarity cutoff — required for rarity_top_percent").setMinValue(0).setMaxValue(100),
        )
        .addStringOption((opt) =>
          opt
            .setName("trait_category")
            .setDescription("Trait category — required for trait_listed/trait_floor (pick a collection first)")
            .setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("trait_value")
            .setDescription("Trait value — required for trait_listed/trait_floor (pick a category first)")
            .setAutocomplete(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("listings")
    .setDescription("Recent listings for a collection within a time window")
    .addStringOption((opt) =>
      opt
        .setName("collection")
        .setDescription("Collection name, OpenSea slug, or 0x contract address")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("hours").setDescription("Look-back window in hours (default 24)").setMinValue(1).setMaxValue(720),
    ),
  new SlashCommandBuilder()
    .setName("floor")
    .setDescription("Current floor price and stats for a collection")
    .addStringOption((opt) =>
      opt
        .setName("collection")
        .setDescription("Collection name, OpenSea slug, or 0x contract address")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("offers")
    .setDescription("Current top offers/bids for a collection")
    .addStringOption((opt) =>
      opt
        .setName("collection")
        .setDescription("Collection name, OpenSea slug, or 0x contract address")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder().setName("status").setDescription("Bot status: mode, data source, watchlist size, next trend digest"),
  new SlashCommandBuilder().setName("help").setDescription("List available commands"),
].map((builder) => builder.toJSON());
