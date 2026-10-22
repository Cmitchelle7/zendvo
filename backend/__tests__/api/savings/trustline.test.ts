import { NextRequest } from "next/server";
import { POST } from "@/api/savings/trustline/route";
import { getAuthPayload } from "@/lib/auth-session";
import { TrustlineService } from "@/lib/stellar/trustline_service";

const VALID_ACCOUNT_ID = "GDWF77422SKLZTBQT77BQEQLCIQY6PFTFZX5OFJTLAFFWJ2PK5WBOZAN";
const OTHER_ACCOUNT_ID = "GBCZIB2HXQMPOWFAFUV5QWLNHJOC2DA264KWIBMPG4EHKB7B4O4RJKLX";
const VALID_VAULT_ID = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

jest.mock("@/lib/auth-session", () => ({
  getAuthPayload: jest.fn(),
}));

jest.mock("@/lib/stellar/trustline_service", () => ({
  TrustlineService: {
    buildSponsoredTrustlineXdr: jest.fn(),
  },
}));

const mockGetAuthPayload = getAuthPayload as jest.Mock;
const mockBuildXdr = (
  TrustlineService as jest.Mocked<typeof TrustlineService>
).buildSponsoredTrustlineXdr as jest.Mock;

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/savings/trustline", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer token",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/savings/trustline", () => {
  const originalUsdcIssuer = process.env.STELLAR_USDC_ISSUER;
  const originalVaultAssets = process.env.SAVINGS_VAULT_TRUSTLINE_ASSETS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_USDC_ISSUER = USDC_ISSUER;
    delete process.env.SAVINGS_VAULT_TRUSTLINE_ASSETS;
    delete process.env.SAVINGS_TRUSTLINE_ASSET_CODE;
    delete process.env.SAVINGS_TRUSTLINE_ASSET_ISSUER;
    mockGetAuthPayload.mockResolvedValue({ userId: "user-1" });
    mockBuildXdr.mockResolvedValue("AAAAAgAAAAB-mock-xdr");
  });

  afterAll(() => {
    if (originalUsdcIssuer === undefined) {
      delete process.env.STELLAR_USDC_ISSUER;
    } else {
      process.env.STELLAR_USDC_ISSUER = originalUsdcIssuer;
    }
    if (originalVaultAssets === undefined) {
      delete process.env.SAVINGS_VAULT_TRUSTLINE_ASSETS;
    } else {
      process.env.SAVINGS_VAULT_TRUSTLINE_ASSETS = originalVaultAssets;
    }
  });

  it("returns 401 when there is no auth payload", async () => {
    mockGetAuthPayload.mockResolvedValue(null);

    const res = await POST(makeRequest({ accountId: VALID_ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
    expect(mockBuildXdr).not.toHaveBeenCalled();
  });

  it("returns 400 when accountId is missing", async () => {
    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain("accountId is required");
    expect(mockBuildXdr).not.toHaveBeenCalled();
  });

  it("returns 400 when accountId is not a Stellar public key", async () => {
    const res = await POST(makeRequest({ accountId: "not-a-stellar-address" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain("valid Stellar public key");
    expect(mockBuildXdr).not.toHaveBeenCalled();
  });

  it("returns 400 when accountId is a contract address instead of an account", async () => {
    const res = await POST(makeRequest({ accountId: VALID_VAULT_ID }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain("valid Stellar public key");
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const request = new NextRequest("http://localhost/api/savings/trustline", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: "{not-json",
    });

    const res = await POST(request);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain("accountId is required");
  });

  it("returns 400 when vaultContractId is not a contract address", async () => {
    const res = await POST(
      makeRequest({ accountId: VALID_ACCOUNT_ID, vaultContractId: "G-not-a-contract" }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toContain("valid Stellar contract address");
    expect(mockBuildXdr).not.toHaveBeenCalled();
  });

  it("returns 200 with the sponsored XDR for a valid account", async () => {
    const res = await POST(makeRequest({ accountId: VALID_ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.xdr).toBe("AAAAAgAAAAB-mock-xdr");
    expect(body.asset).toEqual({ code: "USDC", issuer: USDC_ISSUER });
    expect(body.vaultContractId).toBeNull();
    expect(mockBuildXdr).toHaveBeenCalledWith(
      VALID_ACCOUNT_ID,
      { code: "USDC", issuer: USDC_ISSUER },
      { refreshSponsorAccount: true },
    );
  });

  it("trims whitespace around the account id", async () => {
    const res = await POST(makeRequest({ accountId: `  ${VALID_ACCOUNT_ID}  ` }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockBuildXdr).toHaveBeenCalledWith(
      VALID_ACCOUNT_ID,
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns 200 and echoes the requested vault contract id", async () => {
    const res = await POST(
      makeRequest({ accountId: VALID_ACCOUNT_ID, vaultContractId: VALID_VAULT_ID }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.vaultContractId).toBe(VALID_VAULT_ID);
  });

  it("uses the per-vault asset override when one is configured", async () => {
    const otherIssuer = "GB6XVH6WZT5WFN5ZR2D3W5OZBG2LGDJZQ2S4XW6JXMW2XKZ7E7KAFMZ5";
    process.env.SAVINGS_VAULT_TRUSTLINE_ASSETS = JSON.stringify({
      [VALID_VAULT_ID]: { code: "USDY", issuer: otherIssuer },
    });

    const res = await POST(
      makeRequest({ accountId: VALID_ACCOUNT_ID, vaultContractId: VALID_VAULT_ID }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.asset).toEqual({ code: "USDY", issuer: otherIssuer });
    expect(mockBuildXdr).toHaveBeenCalledWith(
      VALID_ACCOUNT_ID,
      { code: "USDY", issuer: otherIssuer },
      { refreshSponsorAccount: true },
    );
  });

  it("falls back to the default asset when the vault has no override", async () => {
    process.env.SAVINGS_VAULT_TRUSTLINE_ASSETS = JSON.stringify({
      "COTHERCONTRACTID": { code: "USDY", issuer: USDC_ISSUER },
    });

    const res = await POST(
      makeRequest({ accountId: VALID_ACCOUNT_ID, vaultContractId: VALID_VAULT_ID }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.asset).toEqual({ code: "USDC", issuer: USDC_ISSUER });
  });

  it("returns 500 when the savings asset issuer is not configured", async () => {
    delete process.env.STELLAR_USDC_ISSUER;
    delete process.env.SAVINGS_TRUSTLINE_ASSET_ISSUER;

    const res = await POST(makeRequest({ accountId: VALID_ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.title).toBe("Internal Server Error");
    expect(body.detail).toContain("not configured correctly");
    expect(mockBuildXdr).not.toHaveBeenCalled();
  });

  it("returns 500 when the per-vault asset overrides are not valid JSON", async () => {
    process.env.SAVINGS_VAULT_TRUSTLINE_ASSETS = "{not-json";

    const res = await POST(makeRequest({ accountId: VALID_ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.detail).toContain("not configured correctly");
    expect(mockBuildXdr).not.toHaveBeenCalled();
  });

  it("returns 500 when the service fails to build the transaction", async () => {
    mockBuildXdr.mockRejectedValueOnce(new Error("Horizon unreachable"));

    const res = await POST(makeRequest({ accountId: VALID_ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.title).toBe("Internal Server Error");
    expect(body.detail).toBe(
      "Failed to build sponsored savings trustline transaction",
    );
    expect(body.detail).not.toContain("Horizon unreachable");
  });

  it("returns 500 with a generic detail when the error has no message", async () => {
    mockBuildXdr.mockRejectedValueOnce({});

    const res = await POST(makeRequest({ accountId: OTHER_ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.detail).toBe(
      "Failed to build sponsored savings trustline transaction",
    );
  });

  it("rejects a non-string accountId", async () => {
    const res = await POST(makeRequest({ accountId: 42 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toBe("accountId must be a string");
  });

  it("rejects a non-string vaultContractId", async () => {
    const res = await POST(
      makeRequest({ accountId: VALID_ACCOUNT_ID, vaultContractId: 42 }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.detail).toBe("vaultContractId must be a string");
  });
});
