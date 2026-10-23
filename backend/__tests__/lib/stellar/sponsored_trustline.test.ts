import {
  Keypair,
  TransactionBuilder,
  Operation,
  Networks,
} from "@stellar/stellar-sdk";

const SPONSOR_SECRET = Keypair.random().secret();
const SPONSOR_PUBLIC = Keypair.fromSecret(SPONSOR_SECRET).publicKey();
const USER_ADDRESS = Keypair.random().publicKey();
const ASSET_ISSUER = Keypair.random().publicKey();

const loadAccountMock = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: loadAccountMock,
      })),
    },
  };
});

describe("TrustlineService.buildSponsoredTrustlineXdr", () => {
  let TrustlineService: typeof import("@/lib/stellar/trustline_service").TrustlineService;

  beforeAll(() => {
    process.env.STELLAR_SPONSOR_SECRET = SPONSOR_SECRET;
    process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET;
    process.env.STELLAR_HORIZON_URL = "https://horizon-testnet.stellar.org";

    jest.isolateModules(() => {
      TrustlineService = require("@/lib/stellar/trustline_service").TrustlineService;
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (TrustlineService as any).sponsorAccount = null;
    loadAccountMock.mockResolvedValue({
      accountId: () => SPONSOR_PUBLIC,
      sequenceNumber: () => "1234567890",
    });
  });

  it("throws when STELLAR_SPONSOR_SECRET is not configured", async () => {
    const original = process.env.STELLAR_SPONSOR_SECRET;
    delete process.env.STELLAR_SPONSOR_SECRET;

    await expect(
      TrustlineService.buildSponsoredTrustlineXdr(USER_ADDRESS, {
        code: "USDC",
        issuer: ASSET_ISSUER,
      }),
    ).rejects.toThrow("STELLAR_SPONSOR_SECRET is not configured");

    process.env.STELLAR_SPONSOR_SECRET = original;
  });

  it("rejects an account that is not a valid Stellar public key", async () => {
    await expect(
      TrustlineService.buildSponsoredTrustlineXdr("G-not-valid", {
        code: "USDC",
        issuer: ASSET_ISSUER,
      }),
    ).rejects.toThrow("expected a valid G... public key");

    expect(loadAccountMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid asset code", async () => {
    await expect(
      TrustlineService.buildSponsoredTrustlineXdr(USER_ADDRESS, {
        code: "TOO-LONG-ASSET-CODE",
        issuer: ASSET_ISSUER,
      }),
    ).rejects.toThrow("expected 1-12 alphanumeric characters");
  });

  it("rejects an invalid asset issuer", async () => {
    await expect(
      TrustlineService.buildSponsoredTrustlineXdr(USER_ADDRESS, {
        code: "USDC",
        issuer: "C-not-an-issuer",
      }),
    ).rejects.toThrow("expected a valid G... public key");
  });

  it("builds a sponsored change trust for the requested asset", async () => {
    const xdr = await TrustlineService.buildSponsoredTrustlineXdr(USER_ADDRESS, {
      code: "USDY",
      issuer: ASSET_ISSUER,
    });

    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as any;

    expect(tx.operations).toHaveLength(3);
    expect(tx.operations[0].type).toBe("beginSponsoringFutureReserves");
    expect(tx.operations[0].sponsoredId).toBe(USER_ADDRESS);
    expect(tx.operations[1].type).toBe("changeTrust");
    expect(tx.operations[1].line.code).toBe("USDY");
    expect(tx.operations[1].line.issuer).toBe(ASSET_ISSUER);
    expect(tx.operations[2].type).toBe("endSponsoringFutureReserves");
    expect(tx.source).toBe(SPONSOR_PUBLIC);
    expect(tx.operations[1].source).toBe(USER_ADDRESS);
    expect(tx.signatures).toHaveLength(1);
  });

  it("reuses the cached sponsor account by default", async () => {
    await TrustlineService.buildSponsoredTrustlineXdr(USER_ADDRESS, {
      code: "USDC",
      issuer: ASSET_ISSUER,
    });
    await TrustlineService.buildSponsoredTrustlineXdr(USER_ADDRESS, {
      code: "USDC",
      issuer: ASSET_ISSUER,
    });

    expect(loadAccountMock).toHaveBeenCalledTimes(1);
  });

  it("reloads the sponsor account when a refresh is requested", async () => {
    await TrustlineService.buildSponsoredTrustlineXdr(
      USER_ADDRESS,
      { code: "USDC", issuer: ASSET_ISSUER },
      { refreshSponsorAccount: true },
    );
    await TrustlineService.buildSponsoredTrustlineXdr(
      USER_ADDRESS,
      { code: "USDC", issuer: ASSET_ISSUER },
      { refreshSponsorAccount: true },
    );

    expect(loadAccountMock).toHaveBeenCalledTimes(2);
  });

  it("returns a base64 XDR that can be parsed back", async () => {
    const xdr = await TrustlineService.buildSponsoredTrustlineXdr(USER_ADDRESS, {
      code: "USDC",
      issuer: ASSET_ISSUER,
    });

    expect(typeof xdr).toBe("string");
    expect(() => TransactionBuilder.fromXDR(xdr, Networks.TESTNET)).not.toThrow();
  });
});
