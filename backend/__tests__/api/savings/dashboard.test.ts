import { NextRequest } from "next/server";
import { GET } from "@/api/savings/dashboard/route";
import { getAuthPayload } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { DefindexService, DefindexServiceError, type VaultBalance } from "@/lib/services/defindex_service";

jest.mock("@/lib/auth-session", () => ({ getAuthPayload: jest.fn() }));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    StrKey: {
      ...actual.StrKey,
      isValidContract: jest.fn((value: string) => typeof value === "string" && value.startsWith("C")),
    },
  };
});

jest.mock("@/lib/db", () => ({
  db: {
    query: { users: { findFirst: jest.fn() } },
    select: jest.fn(),
  },
}));

jest.mock("@/lib/services/defindex_service", () => {
  const actual = jest.requireActual("@/lib/services/defindex_service");
  return {
    ...actual,
    DefindexService: {
      ...actual.DefindexService,
      getVaultBalance: jest.fn(),
      estimateApy: jest.fn(),
    },
  };
});

const auth = getAuthPayload as jest.Mock;
const getVaultBalance = DefindexService.getVaultBalance as jest.Mock;
const mockFindFirst = db.query.users.findFirst as jest.Mock;
const mockOrderBy = jest.fn();
const mockWhere = jest.fn(() => ({ orderBy: mockOrderBy }));
const mockFrom = jest.fn(() => ({ where: mockWhere }));

(db.select as jest.Mock).mockReturnValue({ from: mockFrom });

const ADDRESS = "GDWF77422SKLZTBQT77BQEQLCIQY6PFTFZX5OFJTLAFFWJ2PK5WBOZAN";
const VAULT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VAULT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function request(url = "http://localhost/api/savings/dashboard") {
  return new NextRequest(url, { method: "GET" });
}

function vault(contractId: string, underlying = "52500000", shares = "500000000"): VaultBalance {
  return {
    userAddress: ADDRESS,
    contractId,
    rawUserBalance: shares,
    userBalance: "50.0000000",
    rawSharePrice: "10500000",
    sharePrice: "1.0500000",
    rawUnderlyingUsdc: underlying,
    underlyingUsdc: "5.2500000",
    rawTotalSupply: "10000000000",
    rawTotalManagedFunds: "10500000000",
    rpcUrl: "https://soroban-testnet.stellar.org",
    apy: {
      rate: 0.0825,
      formatted: "8.25%",
      isEstimated: true,
      methodology: "test",
    },
    fetchedAt: "2026-10-21T12:00:00.000Z",
  };
}

function setUser(overrides: Record<string, unknown> = {}) {
  mockFindFirst.mockResolvedValue({
    id: "user-1",
    stellarAddress: ADDRESS,
    vaultContractId: VAULT_A,
    savingsStatus: "active",
    savingsBalance: 5.25,
    ...overrides,
  });
}

describe("GET /api/savings/dashboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrderBy.mockResolvedValue([]);
    delete process.env.DEFINDEX_VAULT_CONTRACT_ID;
  });

  it("requires authentication", async () => {
    auth.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect((await response.json()).detail).toBe("Authentication required");
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("returns the verified balance, shares, APY, and recent history", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    setUser();
    mockOrderBy.mockResolvedValue([
      {
        id: "history-1",
        userId: "user-1",
        vaultContractId: VAULT_A,
        type: "deposit",
        status: "completed",
        amount: 5.25,
        currency: "USDC",
        transactionHash: "a".repeat(64),
        sharePrice: 1,
        sharesBalance: 5,
        createdAt: new Date("2026-10-20T12:00:00.000Z"),
        updatedAt: new Date("2026-10-20T12:00:00.000Z"),
        errorMessage: null,
        sharesToBurn: null,
      },
    ]);
    getVaultBalance.mockResolvedValue(vault(VAULT_A));

    const body = await (await GET(request())).json();

    expect(body.success).toBe(true);
    expect(body.totalBalanceUsdc).toBe("5.2500000");
    expect(body.sharesBalance).toBe("50.0000000");
    expect(body.totalYieldEarned).toBeNull();
    expect(body.currentApy).toBe(0.0825);
    expect(body.recentTransactions[0]).toMatchObject({
      type: "deposit",
      amountUsdc: "5.25",
      amountUnit: "usdc",
    });
    expect(getVaultBalance).toHaveBeenCalledWith(
      ADDRESS,
      VAULT_A,
      expect.objectContaining({ skipCache: false }),
    );
  });

  it("does not claim an earned yield value when the ledger cannot establish one", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    setUser();
    getVaultBalance.mockResolvedValue(vault(VAULT_A));

    const body = await (await GET(request())).json();

    expect(body.totalYieldEarned).toBeNull();
    expect(body.data.apyInfo).toBeDefined();
  });

  it("parses refresh strictly and bypasses the Defindex cache only for true", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    setUser();
    getVaultBalance.mockResolvedValue(vault(VAULT_A));

    expect((await GET(request("http://localhost/api/savings/dashboard?refresh=false"))).status).toBe(200);
    expect(getVaultBalance).toHaveBeenCalledWith(ADDRESS, VAULT_A, expect.objectContaining({ skipCache: false }));

    getVaultBalance.mockClear();
    expect((await GET(request("http://localhost/api/savings/dashboard?refresh=true"))).status).toBe(200);
    expect(getVaultBalance).toHaveBeenCalledWith(ADDRESS, VAULT_A, expect.objectContaining({ skipCache: true }));
  });

  it("rejects malformed refresh values and unlinked vaults", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    setUser();

    const malformed = await GET(request("http://localhost/api/savings/dashboard?refresh=yes"));
    expect(malformed.status).toBe(400);

    const unlinked = await GET(request(`http://localhost/api/savings/dashboard?vaultContractId=${VAULT_B}`));
    expect(unlinked.status).toBe(403);
    expect((await unlinked.json()).detail).toContain("not linked");
    expect(getVaultBalance).not.toHaveBeenCalled();
  });

  it("aggregates linked vault balances but leaves aggregate APY unavailable", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    setUser({ vaultContractId: null });
    mockOrderBy.mockResolvedValue([
      { vaultContractId: VAULT_A, type: "deposit", status: "completed", sharePrice: null, createdAt: new Date() },
      { vaultContractId: VAULT_B, type: "deposit", status: "completed", sharePrice: null, createdAt: new Date() },
    ]);
    getVaultBalance
      .mockResolvedValueOnce(vault(VAULT_A, "52500000", "500000000"))
      .mockResolvedValueOnce(vault(VAULT_B, "25000000", "250000000"));

    const body = await (await GET(request())).json();

    expect(body.totalBalanceUsdc).toBe("7.7500000");
    expect(body.sharesBalance).toBe("75.0000000");
    expect(body.currentApy).toBeNull();
    expect(body.data.vaults).toHaveLength(2);
  });

  it("maps Defindex upstream failures without exposing internal details", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    setUser();
    getVaultBalance.mockRejectedValue(new DefindexServiceError("rpc secret", "upstream"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.detail).not.toContain("rpc secret");
  });

  it("returns a stable error when the database query fails", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    mockFindFirst.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.detail).toBe("Failed to retrieve savings dashboard data");
  });
});
