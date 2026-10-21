import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { gifts, wallets } from "@/lib/db/schema";
import { eq, and, sql, not, inArray, gt } from "drizzle-orm";
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

    // 1. Count of received gifts with status 'completed'
    const receivedResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(gifts)
      .where(and(eq(gifts.recipientId, userId), eq(gifts.status, "completed")));

    const giftsReceived = Number(receivedResult[0]?.count ?? 0);

    // 2. Count of sent gifts with status 'completed'
    const sentResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(gifts)
      .where(and(eq(gifts.senderId, userId), eq(gifts.status, "completed")));

    const giftsSent = Number(sentResult[0]?.count ?? 0);

    // 3. Count of unopened gifts where user is recipient, status not completed/failed, and unlockDatetime > now()
    const now = new Date();
    const unopenedResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(gifts)
      .where(
        and(
          eq(gifts.recipientId, userId),
          not(inArray(gifts.status, ["completed", "failed"])),
          gt(gifts.unlockDatetime, now)
        )
      );

    const unopenedGifts = Number(unopenedResult[0]?.count ?? 0);

    // 4. Current user wallet balances grouped by currency (USDC, NGN)
    const userWallets = await db
      .select({
        currency: wallets.currency,
        balance: wallets.balance,
      })
      .from(wallets)
      .where(eq(wallets.userId, userId));

    const walletMap: Record<string, number> = {
      USDC: 0,
      NGN: 0,
    };

    for (const w of userWallets) {
      const curr = w.currency.toUpperCase();
      walletMap[curr] = Number(w.balance) || 0;
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          giftsReceived,
          giftsSent,
          unopenedGifts,
          wallets: walletMap,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[DASHBOARD_STATS_ERROR]", error);
    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Failed to fetch dashboard stats",
    );
  }
}
