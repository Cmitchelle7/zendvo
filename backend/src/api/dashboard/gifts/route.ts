import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { gifts, users } from "@/lib/db/schema";
import { eq, and, or, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getAuthPayload } from "@/lib/auth-session";
import { createProblemDetails } from "@/lib/api-utils";

const VALID_TYPES = ["all", "sent", "received"] as const;
type GiftType = (typeof VALID_TYPES)[number];

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

    const params = request.nextUrl.searchParams;
    const type = (params.get("type") ?? "all") as GiftType;
    const status = params.get("status");
    const rawLimit = parseInt(params.get("limit") ?? "20", 10);
    const rawPage = parseInt(params.get("page") ?? "1", 10);

    if (!VALID_TYPES.includes(type)) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "type must be one of: all, sent, received",
      );
    }

    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100);
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1);
    const offset = (page - 1) * limit;

    const sender = alias(users, "sender");
    const recipient = alias(users, "recipient");

    const typeFilter =
      type === "sent"
        ? eq(gifts.senderId, userId)
        : type === "received"
          ? eq(gifts.recipientId, userId)
          : or(eq(gifts.senderId, userId), eq(gifts.recipientId, userId));

    const where = status ? and(typeFilter, eq(gifts.status, status)) : typeFilter;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(gifts)
      .where(where);
    const totalCount = Number(countRow?.count ?? 0);

    const rows = await db
      .select({
        gift: gifts,
        senderName: sender.name,
        senderEmail: sender.email,
        senderAvatar: sender.avatarUrl,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        recipientAvatar: recipient.avatarUrl,
      })
      .from(gifts)
      .leftJoin(sender, eq(gifts.senderId, sender.id))
      .leftJoin(recipient, eq(gifts.recipientId, recipient.id))
      .where(where)
      .orderBy(desc(gifts.createdAt))
      .limit(limit)
      .offset(offset);

    const items = rows.map((r) => {
      const isSender = r.gift.senderId === userId;
      const maskSender = (r.gift.hideSender || r.gift.isAnonymous) && !isSender;

      return {
        ...r.gift,
        direction: isSender ? "sent" : "received",
        sender: maskSender
          ? { id: null, name: null, email: null, avatar: null }
          : {
              id: r.gift.senderId,
              name: r.senderName,
              email: r.senderEmail,
              avatar: r.senderAvatar,
            },
        recipient: {
          id: r.gift.recipientId,
          name: r.recipientName,
          email: r.recipientEmail,
          avatar: r.recipientAvatar,
        },
      };
    });

    return NextResponse.json(
      { success: true, data: { items, pagination: { page, limit, totalCount } } },
      { status: 200 },
    );
  } catch (error) {
    console.error("[DASHBOARD_GIFTS_ERROR]", error);
    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Failed to fetch gifts",
    );
  }
}
