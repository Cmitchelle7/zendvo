import { NextRequest, NextResponse } from "next/server";
import { asc, eq, type SQL } from "drizzle-orm";
import { StrKey } from "@stellar/stellar-sdk";

import { db } from "@/lib/db";
import { users, wallets } from "@/lib/db/schema";
import { getAuthPayload } from "@/lib/auth-session";
import { createProblemDetails } from "@/lib/api-utils";
import {
  sanitizeInput,
  sanitizePhoneNumber,
  validateE164PhoneNumber,
  validateEmail,
} from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limiter";

// 20 lookups per minute per authenticated user — enough for legitimate use,
// tight enough to prevent user enumeration.
const RESOLVE_RATE_LIMIT = 20;
const RESOLVE_RATE_WINDOW_MS = 60_000;

type LookupType = "phoneNumber" | "email" | "username" | "stellarAddress";

const LOOKUP_PARAMS: LookupType[] = [
  "phoneNumber",
  "email",
  "username",
  "stellarAddress",
];

/** Mask an email: "john.doe@example.com" → "jo***@example.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

/**
 * Mask a phone number safely: "+2348123456789" → "+234*****6789"
 *
 * We show at most the first 4 chars (country-code prefix) and the last 4 digits.
 * The two visible windows are clamped so they never overlap — for short but
 * valid E.164 numbers the prefix is shortened and/or the suffix is omitted to
 * guarantee at least 3 hidden characters in the middle.
 */
export function maskPhone(phone: string): string {
  const len = phone.length;
  if (len <= 6) return "***";

  const wantPrefix = phone.startsWith("+") ? 4 : 3;
  const wantSuffix = 4;
  const minHidden = 3;

  const maxVisible = len - minHidden;

  const actualPrefix = Math.min(wantPrefix, maxVisible);
  const actualSuffix = Math.min(
    wantSuffix,
    Math.max(0, maxVisible - actualPrefix),
  );

  const prefix = phone.slice(0, actualPrefix);
  const suffix = actualSuffix > 0 ? phone.slice(len - actualSuffix) : "";
  const hiddenCount = len - actualPrefix - actualSuffix;
  const hidden = "*".repeat(hiddenCount);

  return `${prefix}${hidden}${suffix}`;
}

export async function GET(request: NextRequest) {
  try {
    // --- Authentication ---
    const payload = await getAuthPayload(request);
    if (!payload) {
      return createProblemDetails(
        "about:blank",
        "Unauthorized",
        401,
        "Authentication is required to resolve a recipient.",
      );
    }

    // --- Rate limiting (keyed per authenticated user) ---
    const rateLimitStatus = consumeRateLimit(
      `resolve:${payload.userId}`,
      RESOLVE_RATE_LIMIT,
      RESOLVE_RATE_WINDOW_MS,
    );
    if (rateLimitStatus.limited) {
      return createProblemDetails(
        "about:blank",
        "Too Many Requests",
        429,
        "Too many lookup attempts. Please wait before trying again.",
      );
    }

    // --- Input extraction ---
    const { searchParams } = new URL(request.url);
    const provided = LOOKUP_PARAMS.map((param) => ({
      param,
      value: searchParams.get(param),
    })).filter(({ value }) => value !== null && value.trim() !== "");

    if (provided.length === 0) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "Provide one of 'phoneNumber', 'email', 'username', or 'stellarAddress'.",
      );
    }

    if (provided.length > 1) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "Provide only one of 'phoneNumber', 'email', 'username', or 'stellarAddress'.",
      );
    }

    const lookupType = provided[0].param;
    const rawValue = provided[0].value as string;

    // --- Validate & normalise the input ---
    let whereCondition: SQL<unknown>;

    switch (lookupType) {
      case "phoneNumber": {
        const trimmed = sanitizeInput(rawValue);
        if (!validateE164PhoneNumber(trimmed)) {
          return createProblemDetails(
            "about:blank",
            "Bad Request",
            400,
            "Invalid phone number format. Use E.164 format (e.g. +2348123456789).",
          );
        }
        whereCondition = eq(users.phoneNumber, sanitizePhoneNumber(trimmed));
        break;
      }
      case "email": {
        const trimmed = sanitizeInput(rawValue);
        if (!validateEmail(trimmed)) {
          return createProblemDetails(
            "about:blank",
            "Bad Request",
            400,
            "Invalid email address format.",
          );
        }
        whereCondition = eq(users.email, trimmed.toLowerCase());
        break;
      }
      case "username": {
        const trimmed = sanitizeInput(rawValue);
        if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(trimmed)) {
          return createProblemDetails(
            "about:blank",
            "Bad Request",
            400,
            "Invalid username format.",
          );
        }
        whereCondition = eq(users.username, trimmed);
        break;
      }
      case "stellarAddress": {
        const trimmed = sanitizeInput(rawValue);
        if (!StrKey.isValidEd25519PublicKey(trimmed)) {
          return createProblemDetails(
            "about:blank",
            "Bad Request",
            400,
            "Invalid Stellar address format.",
          );
        }
        whereCondition = eq(users.stellarAddress, trimmed);
        break;
      }
    }

    // --- Database lookup ---
    const recipientRows = await db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        avatarUrl: users.avatarUrl,
        stellarAddress: users.stellarAddress,
        email: users.email,
        phoneNumber: users.phoneNumber,
      })
      .from(users)
      .where(whereCondition)
      .limit(1);

    const recipient = recipientRows[0];

    if (!recipient) {
      const notFoundDetails: Record<LookupType, string> = {
        phoneNumber: "No account found with the provided phone number.",
        email: "No account found with the provided email address.",
        username: "No account found with the provided username.",
        stellarAddress: "No account found with the provided Stellar address.",
      };
      return createProblemDetails(
        "about:blank",
        "Not Found",
        404,
        notFoundDetails[lookupType],
      );
    }

    // --- Fetch the recipient's primary wallet currency ---
    // Order by createdAt ASC so we always pick the earliest (primary) wallet
    // deterministically — a user may hold multiple currency wallets.
    const walletRows = await db
      .select({ currency: wallets.currency })
      .from(wallets)
      .where(eq(wallets.userId, recipient.id))
      .orderBy(asc(wallets.createdAt))
      .limit(1);

    const currency = walletRows[0]?.currency ?? null;

    // --- Build sanitised public profile (no raw PII) ---
    const maskedEmail = recipient.email ? maskEmail(recipient.email) : null;
    const maskedPhone = recipient.phoneNumber
      ? maskPhone(recipient.phoneNumber)
      : null;

    return NextResponse.json(
      {
        success: true,
        data: {
          id: recipient.id,
          name: recipient.name,
          username: recipient.username,
          avatarUrl: recipient.avatarUrl,
          stellarAddress: recipient.stellarAddress,
          maskedEmail,
          maskedPhone,
          currency,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[RESOLVE_RECIPIENT_ERROR]", error);
    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Internal server error.",
    );
  }
}
