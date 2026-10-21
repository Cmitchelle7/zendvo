import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bankAccounts,
  refreshTokens,
  users,
  usedActionTokens,
} from "@/lib/db/schema";
import { getAuthPayload } from "@/lib/auth-session";
import { comparePassword } from "@/lib/auth";
import { verifyActionToken } from "@/lib/tokens";
import { createProblemDetails } from "@/lib/api-utils";
import {
  AuditEventType,
  logAuditEvent,
} from "@/server/services/auditService";

const getClientIp = (request: NextRequest): string =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip") ||
  "127.0.0.1";

export async function DELETE(request: NextRequest) {
  try {
    const authPayload = await getAuthPayload(request);

    if (!authPayload) {
      return createProblemDetails(
        "about:blank",
        "Unauthorized",
        401,
        "Authentication required",
      );
    }

    const body = await request.json().catch(() => null);

    if (
      !body ||
      typeof body.password !== "string" ||
      typeof body.actionToken !== "string"
    ) {
      return createProblemDetails(
        "about:blank",
        "Bad Request",
        400,
        "Password and actionToken are required",
      );
    }

    const { userId } = authPayload;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return createProblemDetails(
        "about:blank",
        "Not Found",
        404,
        "User not found",
      );
    }

    const passwordValid = await comparePassword(
      body.password,
      user.passwordHash,
    );

    if (!passwordValid) {
      return createProblemDetails(
        "about:blank",
        "Unauthorized",
        401,
        "Invalid password",
      );
    }

    const actionToken = await verifyActionToken(body.actionToken);

    if (
      !actionToken ||
      actionToken.userId !== userId ||
      actionToken.action !== "delete_account"
    ) {
      return createProblemDetails(
        "about:blank",
        "Forbidden",
        403,
        "Invalid or expired action token",
      );
    }

    await db.transaction(async (tx) => {
      if (actionToken.jti) {
        await tx
          .insert(usedActionTokens)
          .values({
            jti: actionToken.jti,
            expiresAt: new Date((actionToken.exp ?? 0) * 1000),
          })
          .onConflictDoNothing();
      }

      await tx
        .update(users)
        .set({
          status: "deleted",
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.userId, userId));

      await tx
        .delete(bankAccounts)
        .where(eq(bankAccounts.userId, userId));
    });

    logAuditEvent({
      timestamp: new Date(),
      eventType: AuditEventType.ACCOUNT_DELETION_COMPLETED,
      userId,
      metadata: {
        ip: getClientIp(request),
      },
      message: `Account deleted for user ${userId}`,
    });

    return NextResponse.json(
      {
        success: true,
        message: "Account deleted successfully",
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[ACCOUNT_DELETION_ERROR]", error);

    return createProblemDetails(
      "about:blank",
      "Internal Server Error",
      500,
      "Internal server error",
    );
  }
}