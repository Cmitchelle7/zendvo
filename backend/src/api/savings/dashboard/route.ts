import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { savingsHistory, users } from "@/lib/db/schema";
import { getAuthPayload } from "@/lib/auth-session";
import { createProblemDetails } from "@/lib/api-utils";
import {
  DefindexService,
  DefindexServiceError,
  formatUnits,
  type APYInfo,
  type HistoricalSharePriceSnapshot,
  type VaultBalance,
} from "@/lib/services/defindex_service";

const HISTORY_LIMIT = 5;

type DashboardTransaction = {
  id: string;
  type: "deposit" | "withdrawal" | "yield_claim";
  status: "pending" | "completed" | "failed";
  /** Null when the legacy record's unit cannot be proven safe to convert. */
  amountUsdc: string | null;
  rawAmount: string;
  amountUnit: "usdc" | "smallest_unit" | "unknown";
  currency: string;
  transactionHash: string | null;
  vaultContractId: string;
  createdAt: string;
};

function parseBooleanParameter(value: string | null): boolean {
  if (value === null || value === "false") return false;
  return value === "true";
}

function formatApy(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function emptyApyInfo(): APYInfo {
  return {
    rate: null,
    formatted: "N/A",
    isEstimated: false,
    methodology:
      "A single-vault APY is unavailable because the repository does not define a safe aggregate APY methodology.",
  };
}

async function getApy(vault: VaultBalance): Promise<APYInfo> {
  if (vault.apy.rate !== null && Number.isFinite(vault.apy.rate)) {
    return vault.apy;
  }

  try {
    const estimate = await DefindexService.estimateApy(vault.contractId);
    if (Number.isFinite(estimate.apy)) {
      return {
        rate: estimate.apy,
        formatted: formatApy(estimate.apy),
        isEstimated: true,
        methodology: "Vault APY estimated via the DeFindex protocol SDK.",
      };
    }
  } catch {
    // Preserve the explicit unavailable value from getVaultBalance.
  }

  return vault.apy;
}

function mapTransaction(
  transaction: typeof savingsHistory.$inferSelect,
): DashboardTransaction {
  const isDeposit = transaction.type === "deposit";
  const rawAmount = String(transaction.amount);

  return {
    id: transaction.id,
    type: transaction.type,
    status: transaction.status,
    amountUsdc: isDeposit ? rawAmount : null,
    rawAmount,
    amountUnit: isDeposit ? "usdc" : "unknown",
    currency: transaction.currency,
    transactionHash: transaction.transactionHash,
    vaultContractId: transaction.vaultContractId,
    createdAt: transaction.createdAt.toISOString(),
  };
}

/**
 * Returns the authenticated user's current DeFindex savings positions.
 *
 * `totalYieldEarned` is intentionally null: the current schema records
 * transactions in inconsistent units and does not store an authoritative
 * realized-yield ledger. Returning a calculated number would be misleading.
 * Likewise, `currentApy` is null for multiple vaults because the repository
 * has no documented aggregate-APY methodology.
 */
export async function GET(request: NextRequest) {
  try {
    const payload = await getAuthPayload(request);
    if (!payload) {
      return createProblemDetails(
        "about:blank",
        "Unauthorized",
        401,
        "Authentication required",
      );
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.userId),
      columns: {
        id: true,
        stellarAddress: true,
        vaultContractId: true,
        savingsStatus: true,
        savingsBalance: true,
      },
    });

    if (!user) {
      return createProblemDetails("about:blank", "Not Found", 404, "User not found");
    }
    if (!user.stellarAddress?.trim()) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "No Stellar address registered for this account",
      );
    }

    const url = request.nextUrl ?? new URL(request.url);
    const requestedVault = url.searchParams.get("vaultContractId")?.trim() || null;
    const refreshValue = url.searchParams.get("refresh");
    if (refreshValue !== null && refreshValue !== "true" && refreshValue !== "false") {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "refresh must be either true or false",
      );
    }
    if (requestedVault && !StrKey.isValidContract(requestedVault)) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "vaultContractId must be a valid Stellar contract address",
      );
    }

    const history = await db
      .select()
      .from(savingsHistory)
      .where(eq(savingsHistory.userId, user.id))
      .orderBy(desc(savingsHistory.createdAt));

    const linkedVaults = new Set(
      history.map((entry) => entry.vaultContractId).filter(Boolean),
    );
    if (user.vaultContractId) linkedVaults.add(user.vaultContractId);

    if (requestedVault && !linkedVaults.has(requestedVault)) {
      return createProblemDetails(
        "about:blank",
        "Forbidden",
        403,
        "Requested vault is not linked to this account",
      );
    }

    const vaultIds = requestedVault
      ? [requestedVault]
      : [...linkedVaults].filter((id) => StrKey.isValidContract(id));
    if (vaultIds.length === 0 && process.env.DEFINDEX_VAULT_CONTRACT_ID) {
      vaultIds.push(process.env.DEFINDEX_VAULT_CONTRACT_ID);
    }
    if (vaultIds.length === 0) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "No savings vault is linked to this account",
      );
    }

    const skipCache = parseBooleanParameter(refreshValue);
    const snapshots = new Map<string, HistoricalSharePriceSnapshot>();
    for (const entry of history) {
      if (
        entry.type === "deposit" &&
        entry.status === "completed" &&
        entry.sharePrice !== null &&
        entry.sharePrice > 0 &&
        !snapshots.has(entry.vaultContractId)
      ) {
        snapshots.set(entry.vaultContractId, {
          timestamp: entry.createdAt,
          sharePrice: BigInt(Math.round(entry.sharePrice * 10_000_000)),
        });
      }
    }

    const vaults = await Promise.all(
      vaultIds.map(async (vaultId) => {
        const balance = await DefindexService.getVaultBalance(
          user.stellarAddress!.trim(),
          vaultId,
          {
            skipCache,
            historicalSnapshot: snapshots.get(vaultId),
          },
        );
        return { balance, apy: await getApy(balance) };
      }),
    );

    const totalUnderlying = vaults.reduce(
      (sum, entry) => sum + BigInt(entry.balance.rawUnderlyingUsdc),
      0n,
    );
    const totalShares = vaults.reduce(
      (sum, entry) => sum + BigInt(entry.balance.rawUserBalance),
      0n,
    );
    const apy = vaults.length === 1 ? vaults[0].apy : emptyApyInfo();
    const selectedHistory = history
      .filter(
        (entry) =>
          vaultIds.includes(entry.vaultContractId) &&
          (entry.type === "deposit" || entry.type === "withdrawal"),
      )
      .slice(0, HISTORY_LIMIT)
      .map(mapTransaction);

    return NextResponse.json({
      success: true,
      totalBalanceUsdc: formatUnits(totalUnderlying),
      sharesBalance: formatUnits(totalShares),
      totalYieldEarned: null,
      currentApy: apy.rate === null ? null : apy.rate,
      recentTransactions: selectedHistory,
      data: {
        userAddress: user.stellarAddress.trim(),
        totalBalanceUsdc: formatUnits(totalUnderlying),
        sharesBalance: formatUnits(totalShares),
        totalYieldEarned: null,
        currentApy: apy.rate === null ? null : apy.rate,
        currentApyFormatted: apy.formatted,
        apyInfo: apy,
        vaults: vaults.map(({ balance, apy: vaultApy }) => ({
          contractId: balance.contractId,
          balanceUsdc: balance.underlyingUsdc,
          sharesBalance: balance.userBalance,
          sharePrice: balance.sharePrice,
          apy: vaultApy,
          fetchedAt: balance.fetchedAt,
        })),
        savingsStatus: user.savingsStatus,
        cachedSavingsBalance: user.savingsBalance,
        recentTransactions: selectedHistory,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[SAVINGS_DASHBOARD_ERROR]", error);
    if (error instanceof DefindexServiceError) {
      if (error.kind === "configuration") {
        return createProblemDetails(
          "about:blank",
          "Internal Server Error",
          500,
          "The DeFindex vault is not configured correctly",
        );
      }
      if (error.kind === "upstream") {
        return createProblemDetails(
          "about:blank",
          "Bad Gateway",
          502,
          "The DeFindex vault could not be reached or simulated at this time",
        );
      }
      return createProblemDetails("about:blank", "Bad Request", 400, error.message);
    }
    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Failed to retrieve savings dashboard data",
    );
  }
}
