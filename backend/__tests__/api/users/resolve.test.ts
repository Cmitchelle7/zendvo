import { NextRequest } from "next/server";
import { GET } from "@/api/users/resolve/route";
import { db } from "@/lib/db";
import { getAuthPayload } from "@/lib/auth-session";
import { consumeRateLimit } from "@/lib/rate-limiter";
import { users, wallets } from "@/lib/db/schema";

jest.mock("drizzle-orm", () => ({
  eq: jest.fn((col: unknown, val: unknown) => ({ __eq: { col, val } })),
  asc: jest.fn((col: unknown) => ({ __asc: col })),
}));

jest.mock("@/lib/db", () => ({
  db: { select: jest.fn() },
}));

jest.mock("@/lib/db/schema", () => ({
  users: {
    id: "users.id",
    name: "users.name",
    username: "users.username",
    avatarUrl: "users.avatarUrl",
    phoneNumber: "users.phoneNumber",
    email: "users.email",
    stellarAddress: "users.stellarAddress",
  },
  wallets: {
    userId: "wallets.userId",
    currency: "wallets.currency",
    createdAt: "wallets.createdAt",
  },
}));

jest.mock("@/lib/auth-session", () => ({
  getAuthPayload: jest.fn(),
}));

jest.mock("@/lib/rate-limiter", () => ({
  consumeRateLimit: jest.fn(),
}));

const STELLAR_ADDRESS =
  "GDWF77422SKLZTBQT77BQEQLCIQY6PFTFZX5OFJTLAFFWJ2PK5WBOZAN";

const makeRequest = (params?: Record<string, string>) => {
  const url = new URL("http://localhost/api/users/resolve");
  if (params) {
    Object.entries(params).forEach(([key, value]) =>
      url.searchParams.set(key, value),
    );
  }
  return new NextRequest(url, { method: "GET" });
};

function mockDbSelectChain(
  usersResult: unknown[],
  walletsResult: unknown[] = [],
) {
  let callCount = 0;

  const spies = {
    usersWhere: jest.fn(),
    walletsWhere: jest.fn(),
    walletsOrderBy: jest.fn(),
  };

  (db.select as jest.Mock).mockImplementation(() => {
    callCount++;
    const limitMock = jest
      .fn()
      .mockResolvedValue(callCount === 1 ? usersResult : walletsResult);

    if (callCount === 1) {
      spies.usersWhere.mockReturnValue({ limit: limitMock });
      return { from: jest.fn(() => ({ where: spies.usersWhere })) };
    }

    spies.walletsOrderBy.mockReturnValue({ limit: limitMock });
    spies.walletsWhere.mockReturnValue({ orderBy: spies.walletsOrderBy });
    return { from: jest.fn(() => ({ where: spies.walletsWhere })) };
  });

  return spies;
}

const recipient = {
  id: "r-uuid",
  name: "Jane Doe",
  username: "janedoe",
  avatarUrl: "https://cdn/a.jpg",
  stellarAddress: STELLAR_ADDRESS,
  email: "jane@example.com",
  phoneNumber: "+2348123456789",
};

describe("GET /api/users/resolve", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (consumeRateLimit as jest.Mock).mockReturnValue({
      key: "resolve:user",
      count: 1,
      limit: 20,
      windowMs: 60_000,
      remaining: 19,
      resetMs: 60_000,
      limited: false,
    });
    (getAuthPayload as jest.Mock).mockResolvedValue({
      userId: "sender-1",
      email: "sender@example.com",
      role: "user",
    });
  });

  it("returns 401 when no auth token is provided", async () => {
    (getAuthPayload as jest.Mock).mockResolvedValue(null);

    const res = await GET(makeRequest({ phoneNumber: "+2348123456789" }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.detail).toBeDefined();
  });

  it("returns 429 when the per-user rate limit is exceeded", async () => {
    (consumeRateLimit as jest.Mock).mockReturnValue({
      key: "resolve:sender-1",
      count: 21,
      limit: 20,
      windowMs: 60_000,
      remaining: 0,
      resetMs: 30_000,
      limited: true,
    });

    const res = await GET(makeRequest({ email: "jane@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.title).toBe("Too Many Requests");
    expect(consumeRateLimit).toHaveBeenCalledWith(
      "resolve:sender-1",
      20,
      60_000,
    );
  });

  it("returns 400 when no lookup parameter is provided", async () => {
    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.detail).toContain("phoneNumber");
  });

  it("returns 400 when more than one lookup parameter is provided", async () => {
    const res = await GET(
      makeRequest({
        phoneNumber: "+2348123456789",
        email: "jane@example.com",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.detail).toContain("only one");
  });

  it("returns 400 for an invalid phone number", async () => {
    const res = await GET(makeRequest({ phoneNumber: "not-a-phone" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.detail).toContain("Invalid phone number");
  });

  it("returns 400 for an invalid email", async () => {
    const res = await GET(makeRequest({ email: "not-an-email" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.detail).toContain("Invalid email");
  });

  it("returns 400 for an invalid username", async () => {
    const res = await GET(makeRequest({ username: "no spaces allowed" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.detail).toContain("Invalid username");
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const res = await GET(makeRequest({ stellarAddress: "GNOTVALID" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.detail).toContain("Invalid Stellar address");
  });

  it("returns 404 when no user matches", async () => {
    mockDbSelectChain([]);

    const res = await GET(makeRequest({ email: "nobody@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.detail).toContain("email");
  });

  it("resolves by phone, sanitises E.164 and masks PII", async () => {
    const spies = mockDbSelectChain([recipient], [{ currency: "NGN" }]);

    const res = await GET(makeRequest({ phoneNumber: "+2348123456789" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("r-uuid");
    expect(json.data.username).toBe("janedoe");
    expect(json.data.stellarAddress).toBe(STELLAR_ADDRESS);
    expect(json.data.currency).toBe("NGN");
    expect(spies.usersWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        __eq: { col: users.phoneNumber, val: "+2348123456789" },
      }),
    );
    expect(json.data.email).toBeUndefined();
    expect(json.data.phoneNumber).toBeUndefined();
    expect(json.data.maskedEmail).toBe("ja***@example.com");
    expect(json.data.maskedPhone).toBe("+234******6789");
    expect(spies.walletsOrderBy).toHaveBeenCalledWith(
      expect.objectContaining({ __asc: wallets.createdAt }),
    );
  });

  it("resolves by email and lowercases the email for lookup", async () => {
    const spies = mockDbSelectChain([recipient], [{ currency: "NGN" }]);

    const res = await GET(makeRequest({ email: "JANE@Example.COM" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("r-uuid");
    expect(spies.usersWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        __eq: { col: users.email, val: "jane@example.com" },
      }),
    );
  });

  it("resolves by username", async () => {
    const spies = mockDbSelectChain([recipient], [{ currency: "NGN" }]);

    const res = await GET(makeRequest({ username: "janedoe" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("r-uuid");
    expect(spies.usersWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        __eq: { col: users.username, val: "janedoe" },
      }),
    );
  });

  it("resolves by Stellar address", async () => {
    const spies = mockDbSelectChain([recipient], [{ currency: "NGN" }]);

    const res = await GET(makeRequest({ stellarAddress: STELLAR_ADDRESS }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("r-uuid");
    expect(json.data.stellarAddress).toBe(STELLAR_ADDRESS);
    expect(spies.usersWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        __eq: { col: users.stellarAddress, val: STELLAR_ADDRESS },
      }),
    );
  });

  it("returns null masked identifiers and currency when absent", async () => {
    mockDbSelectChain(
      [
        {
          id: "minimal",
          name: null,
          username: null,
          avatarUrl: null,
          stellarAddress: null,
          email: null,
          phoneNumber: null,
        },
      ],
      [],
    );

    const res = await GET(makeRequest({ username: "minimal" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.maskedEmail).toBeNull();
    expect(json.data.maskedPhone).toBeNull();
    expect(json.data.currency).toBeNull();
  });

  it("returns 500 when the database query throws", async () => {
    (db.select as jest.Mock).mockImplementation(() => {
      throw new Error("db down");
    });

    const res = await GET(makeRequest({ email: "jane@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.title).toBe("Internal Server Error");
  });
});
