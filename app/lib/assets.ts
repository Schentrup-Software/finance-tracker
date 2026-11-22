import type { Asset, AssetType, Color, Debt } from "~/backend/types";
import { round2 } from "./money";

export const ASSET_LABELS: Record<AssetType, string> = {
  real_estate: "Real estate",
  vehicle: "Vehicle",
  collectible: "Collectible",
  checking: "Checking",
  savings: "Savings",
  brokerage: "Brokerage",
  "401k": "401(k)",
  ira: "IRA",
  roth_ira: "Roth IRA",
  hsa: "HSA",
  "529": "529 plan",
  crypto: "Crypto",
  cash: "Cash",
  other: "Other",
};

export const ASSET_EMOJI: Record<AssetType, string> = {
  real_estate: "🏡",
  vehicle: "🚙",
  collectible: "🏺",
  checking: "🏦",
  savings: "🐷",
  brokerage: "📈",
  "401k": "🌳",
  ira: "🌱",
  roth_ira: "🌿",
  hsa: "🩹",
  "529": "🎒",
  crypto: "🪙",
  cash: "💵",
  other: "📦",
};

export interface AssetGroup {
  key: string;
  label: string;
  color: Color;
  types: AssetType[];
}

export const ASSET_GROUPS: AssetGroup[] = [
  { key: "home", label: "Real estate", color: "sky", types: ["real_estate"] },
  { key: "retirement", label: "Retirement", color: "mint", types: ["401k", "ira", "roth_ira", "hsa"] },
  { key: "cash", label: "Cash & savings", color: "butter", types: ["checking", "savings", "cash"] },
  { key: "investing", label: "Investments", color: "lilac", types: ["brokerage", "529", "crypto"] },
  { key: "stuff", label: "Vehicles & collectibles", color: "peach", types: ["vehicle", "collectible", "other"] },
];

export function groupFor(type: Asset["type"]): AssetGroup {
  return ASSET_GROUPS.find((g) => g.types.includes(type as AssetType)) ?? ASSET_GROUPS[ASSET_GROUPS.length - 1];
}

/** What the asset is worth after the debts tied to it. */
export function equity(asset: Pick<Asset, "value" | "debts">, debtsById: Map<string, Pick<Debt, "balance">>): number {
  const owed = (asset.debts ?? []).reduce((s, id) => s + (debtsById.get(id)?.balance ?? 0), 0);
  return round2(asset.value - owed);
}

export function netWorth(assets: Pick<Asset, "value">[], debts: Pick<Debt, "balance">[]) {
  const totalAssets = round2(assets.reduce((s, a) => s + (a.value || 0), 0));
  const totalDebts = round2(debts.reduce((s, d) => s + (d.balance || 0), 0));
  return { totalAssets, totalDebts, netWorth: round2(totalAssets - totalDebts) };
}
