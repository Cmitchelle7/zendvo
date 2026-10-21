import { NextRequest, NextResponse } from "next/server";
import { eq, and, gt, notInArray, count } from "drizzle-orm";
import { db } from "@/lib/db";
import { gifts, wallets, giftStatusEnum } from "@/lib/db/schema";
import { getAuthPayload } from "@/lib/auth-session";
import { createProblemDetails } from "@/lib/api-utils";

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

    const userId = payload.userId;
    const now = new Date();

    const [
      giftsReceivedResult,
      giftsSentResult,
      unopenedGiftsResult,
      walletsResult,
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(gifts)
        .where(
          and(
            eq(gifts.recipientId, userId),
            eq(gifts.status, "completed"),
          ),
        ),
      db
        .select({ count: count() })
        .from(gifts)
        .where(
          and(
            eq(gifts.senderId, userId),
            eq(gifts.status, "completed"),
          ),
        ),
      db
        .select({ count: count() })
        .from(gifts)
        .where(
          and(
            eq(gifts.recipientId, userId),
            notInArray(gifts.status, ["completed", "failed"]),
            gt(gifts.unlockDatetime, now),
          ),
        ),
      db
        .select({
          currency: wallets.currency,
          balance: wallets.balance,
        })
        .from(wallets)
        .where(eq(wallets.userId, userId)),
    ]);

    const giftsReceived = giftsReceivedResult[0]?.count ?? 0;
    const giftsSent = giftsSentResult[0]?.count ?? 0;
    const unopenedGifts = unopenedGiftsResult[0]?.count ?? 0;

    const walletBalances = walletsResult.map((w) => ({
      currency: w.currency,
      balance: w.balance,
    }));

    return NextResponse.json({
      success: true,
      data: {
        giftsReceived,
        giftsSent,
        unopenedGifts,
        wallets: walletBalances,
      },
    });
  } catch (error) {
    console.error("[DASHBOARD_STATS_ERROR]", error);
    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Failed to retrieve dashboard statistics",
    );
  }
}