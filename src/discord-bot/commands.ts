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
  new SlashCommandBuilder()
    .setName("watching")
    .setDescription("Items you've marked 👀 for follow-up alerts")
    .addSubcommand((sub) => sub.setName("list").setDescription("List every item currently being watched"))
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Stop watching a specific item")
        .addStringOption((opt) =>
          opt.setName("collection").setDescription("Collection name, OpenSea slug, or 0x contract address").setRequired(true).setAutocomplete(true),
        )
        .addStringOption((opt) => opt.setName("token_id").setDescription("Token ID to stop watching").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("whale")
    .setDescription("Track wallets and get alerts on their activity in allowlisted collections")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Start tracking a wallet address")
        .addStringOption((opt) => opt.setName("address").setDescription("0x wallet address to track").setRequired(true))
        .addStringOption((opt) => opt.setName("label").setDescription("Friendly name for this wallet (optional)")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Stop tracking a wallet address")
        .addStringOption((opt) => opt.setName("address").setDescription("0x wallet address to stop tracking").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List every tracked wallet")),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("View and edit tunables live (authorized user only)")
    .addSubcommand((sub) => sub.setName("show").setDescription("Show every global tunable and where its value comes from"))
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set a global tunable (persisted to watchlist.json)")
        .addStringOption((opt) =>
          opt
            .setName("key")
            .setDescription("Which tunable to set")
            .setRequired(true)
            .addChoices(
              { name: "show_usd (true/false)", value: "show_usd" },
              { name: "floor_move_threshold_percent", value: "floor_move_threshold_percent" },
              { name: "new_listing_max_price (ETH)", value: "new_listing_max_price" },
              { name: "offer_above_collection_percent", value: "offer_above_collection_percent" },
              { name: "trend_alert_times (HH:MM,HH:MM)", value: "trend_alert_times" },
              { name: "daily_recap_time (HH:MM)", value: "daily_recap_time" },
            ),
        )
        .addStringOption((opt) => opt.setName("value").setDescription("New value").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Drop a global override and fall back to the .env value")
        .addStringOption((opt) =>
          opt
            .setName("key")
            .setDescription("Which tunable to reset")
            .setRequired(true)
            .addChoices(
              { name: "show_usd", value: "show_usd" },
              { name: "floor_move_threshold_percent", value: "floor_move_threshold_percent" },
              { name: "new_listing_max_price", value: "new_listing_max_price" },
              { name: "offer_above_collection_percent", value: "offer_above_collection_percent" },
              { name: "trend_alert_times", value: "trend_alert_times" },
              { name: "daily_recap_time", value: "daily_recap_time" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("entry")
        .setDescription("Set a per-collection tunable (mute, quiet hours, thresholds, rule values)")
        .addStringOption((opt) =>
          opt.setName("collection").setDescription("Collection name, OpenSea slug, or 0x contract address").setRequired(true).setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("key")
            .setDescription("Which per-collection tunable to set")
            .setRequired(true)
            .addChoices(
              { name: "muted (true/false)", value: "muted" },
              { name: "enabled (true/false)", value: "enabled" },
              { name: "target_buy_price (ETH)", value: "target_buy_price" },
              { name: "max_floor (ETH)", value: "max_floor" },
              { name: "min_percent_from_floor", value: "min_percent_from_floor" },
              { name: "max_percent_from_floor", value: "max_percent_from_floor" },
              { name: "dedupe_window_minutes", value: "dedupe_window_minutes" },
              { name: "rate_limit_per_hour", value: "rate_limit_per_hour" },
              { name: "quiet_hours_start (HH:MM)", value: "quiet_hours_start" },
              { name: "quiet_hours_end (HH:MM)", value: "quiet_hours_end" },
              { name: "quiet_hours_timezone (IANA)", value: "quiet_hours_timezone" },
              { name: "priority_tier (blue-chip/watch)", value: "priority_tier" },
            ),
        )
        .addStringOption((opt) => opt.setName("value").setDescription("New value").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("portfolio")
    .setDescription("READ-ONLY holdings, floor value, and offers for the configured public address"),
  new SlashCommandBuilder().setName("status").setDescription("Bot status: mode, data source, watchlist size, next trend digest"),
  new SlashCommandBuilder().setName("help").setDescription("List available commands"),
].map((builder) => builder.toJSON());
