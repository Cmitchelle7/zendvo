import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { getAuthPayload } from "@/lib/auth-session";
import { createProblemDetails } from "@/lib/api-utils";
import {
  TrustlineService,
  type TrustlineAsset,
} from "@/lib/stellar/trustline_service";
import {
  TelemetryService,
  extractTraceId,
} from "@/lib/services/telemetry_service";

/**
 * Per-vault trustline asset overrides.
 *
 * Format: `{ "<vault contract id>": { "code": "USDC", "issuer": "G..." } }`
 *
 * Vaults that are not listed fall back to the default savings asset below.
 */
const SAVINGS_VAULT_TRUSTLINE_ASSETS = "SAVINGS_VAULT_TRUSTLINE_ASSETS";

/** Default asset code used when no per-vault override is configured. */
const DEFAULT_TRUSTLINE_ASSET_CODE = "USDC";

/**
 * Resolves the classic asset a savings trustline has to be opened against.
 *
 * The savings vaults hold the platform USDC token, so the underlying classic
 * asset is used by default. Vaults that expose their own share token can be
 * mapped through `SAVINGS_VAULT_TRUSTLINE_ASSETS`.
 */
export function resolveSavingsTrustlineAsset(
  vaultContractId?: string,
): TrustlineAsset {
  const overrides = parseVaultAssetOverrides(
    process.env[SAVINGS_VAULT_TRUSTLINE_ASSETS],
  );

  const override = vaultContractId ? overrides[vaultContractId] : undefined;
  if (override) {
    return override;
  }

  const code = (process.env.SAVINGS_TRUSTLINE_ASSET_CODE || DEFAULT_TRUSTLINE_ASSET_CODE).trim();
  const issuer = (
    process.env.SAVINGS_TRUSTLINE_ASSET_ISSUER || process.env.STELLAR_USDC_ISSUER || ""
  ).trim();

  if (!issuer) {
    throw new Error(
      "The savings trustline asset is not configured: set STELLAR_USDC_ISSUER",
    );
  }

  return { code, issuer };
}

function parseVaultAssetOverrides(
  raw: string | undefined,
): Record<string, TrustlineAsset> {
  if (!raw || !raw.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${SAVINGS_VAULT_TRUSTLINE_ASSETS} is not valid JSON`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${SAVINGS_VAULT_TRUSTLINE_ASSETS} must be an object keyed by vault contract id`,
    );
  }

  const overrides: Record<string, TrustlineAsset> = {};
  for (const [contractId, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const { code, issuer } = value as { code?: unknown; issuer?: unknown };
    if (typeof code !== "string" || typeof issuer !== "string") {
      continue;
    }
    overrides[contractId] = { code: code.trim(), issuer: issuer.trim() };
  }

  return overrides;
}

export async function POST(request: NextRequest) {
  const traceId = extractTraceId(request);
  const elapsedTimer = TelemetryService.startTimer();
  let currentUserId: string | undefined;
  let requestedAccountId: string | undefined;

  try {
    const payload = await getAuthPayload(request);
    if (!payload) {
      TelemetryService.logXdrGenerationFailure({
        traceId,
        transactionType: "trustline",
        currency: DEFAULT_TRUSTLINE_ASSET_CODE,
        durationMs: elapsedTimer(),
        errorCode: 401,
        error: "Authentication required",
      });
      return createProblemDetails(
        "about:blank",
        "Unauthorized",
        401,
        "Authentication required",
      );
    }

    currentUserId = payload.userId;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const { accountId, vaultContractId } =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { accountId?: unknown; vaultContractId?: unknown })
        : {};

    const account = typeof accountId === "string" ? accountId.trim() : "";
    const vault =
      typeof vaultContractId === "string" ? vaultContractId.trim() : "";
    requestedAccountId = account;

    if (accountId !== undefined && typeof accountId !== "string") {
      TelemetryService.logXdrGenerationFailure({
        traceId,
        userId: currentUserId,
        transactionType: "trustline",
        currency: DEFAULT_TRUSTLINE_ASSET_CODE,
        durationMs: elapsedTimer(),
        errorCode: 400,
        error: "accountId must be a string",
      });
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "accountId must be a string",
      );
    }

    if (vaultContractId !== undefined && typeof vaultContractId !== "string") {
      TelemetryService.logXdrGenerationFailure({
        traceId,
        userId: currentUserId,
        transactionType: "trustline",
        currency: DEFAULT_TRUSTLINE_ASSET_CODE,
        stellarAddress: account,
        durationMs: elapsedTimer(),
        errorCode: 400,
        error: "vaultContractId must be a string",
      });
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "vaultContractId must be a string",
      );
    }

    if (!account) {
      TelemetryService.logXdrGenerationFailure({
        traceId,
        userId: currentUserId,
        transactionType: "trustline",
        currency: DEFAULT_TRUSTLINE_ASSET_CODE,
        durationMs: elapsedTimer(),
        errorCode: 400,
        error: "accountId is required",
      });
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "accountId is required and must be a Stellar account address",
      );
    }

    if (!StrKey.isValidEd25519PublicKey(account)) {
      TelemetryService.logXdrGenerationFailure({
        traceId,
        userId: currentUserId,
        transactionType: "trustline",
        currency: DEFAULT_TRUSTLINE_ASSET_CODE,
        stellarAddress: account,
        durationMs: elapsedTimer(),
        errorCode: 400,
        error: "Invalid Stellar public key",
      });
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "accountId must be a valid Stellar public key (G...)",
      );
    }

    if (vault && !StrKey.isValidContract(vault)) {
      TelemetryService.logXdrGenerationFailure({
        traceId,
        userId: currentUserId,
        transactionType: "trustline",
        currency: DEFAULT_TRUSTLINE_ASSET_CODE,
        stellarAddress: account,
        durationMs: elapsedTimer(),
        errorCode: 400,
        error: "Invalid vault contract id",
      });
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "vaultContractId must be a valid Stellar contract address (C...)",
      );
    }

    const asset = resolveSavingsTrustlineAsset(vault || undefined);

    TelemetryService.logXdrGenerationStart({
      traceId,
      userId: currentUserId,
      transactionType: "trustline",
      currency: asset.code,
      stellarAddress: account,
    });

    const xdr = await TrustlineService.buildSponsoredTrustlineXdr(
      account,
      asset,
      { refreshSponsorAccount: true },
    );

    TelemetryService.logXdrGenerationSuccess({
      traceId,
      userId: currentUserId,
      transactionType: "trustline",
      currency: asset.code,
      stellarAddress: account,
      durationMs: elapsedTimer(),
    });

    return NextResponse.json(
      {
        success: true,
        xdr,
        asset,
        vaultContractId: vault || null,
      },
      { status: 200 },
    );
  } catch (error: any) {
    console.error("[SAVINGS_TRUSTLINE_ERROR]", error);

    TelemetryService.logXdrGenerationFailure({
      traceId,
      userId: currentUserId,
      transactionType: "trustline",
      currency: DEFAULT_TRUSTLINE_ASSET_CODE,
      stellarAddress: requestedAccountId,
      durationMs: elapsedTimer(),
      errorCode: 500,
      error,
    });

    const message = typeof error?.message === "string" ? error.message : "";
    const isConfigurationError =
      message.includes("is not configured") ||
      message.includes("is not valid JSON") ||
      message.includes("must be an object keyed by vault contract id");

    if (isConfigurationError) {
      return createProblemDetails(
        "about:blank",
        "Internal Server Error",
        500,
        "The savings trustline asset is not configured correctly",
      );
    }

    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Failed to build sponsored savings trustline transaction",
    );
  }
}
