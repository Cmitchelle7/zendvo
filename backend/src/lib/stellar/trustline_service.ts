import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Account,
  Asset,
  Horizon,
  StrKey,
} from "@stellar/stellar-sdk";

/** A classic Stellar asset a trustline can be opened against. */
export interface TrustlineAsset {
  /** Asset code, e.g. `USDC`. */
  code: string;
  /** Issuer public key (`G...`) of the asset. */
  issuer: string;
}

/** Options accepted by {@link TrustlineService.buildSponsoredTrustlineXdr}. */
export interface SponsoredTrustlineOptions {
  /**
   * Reload the sponsor account from Horizon before building the envelope.
   *
   * The sponsor is the transaction source, so the network expects its
   * sequence number to be the next unused one. Reloading keeps the generated
   * envelope submittable after a previous envelope was already submitted.
   */
  refreshSponsorAccount?: boolean;
}

/** Stellar asset codes are 1-12 alphanumeric characters. */
const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;

export class TrustlineService {
  private static horizonUrl =
    process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
  private static server = new Horizon.Server(TrustlineService.horizonUrl);

  private static sponsorAccount: Account | null = null;
  private static isFetching = false;
  private static mutexQueue: Array<() => void> = [];

  private static async lock(): Promise<void> {
    if (!this.isFetching) {
      this.isFetching = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.mutexQueue.push(resolve);
    });
  }

  private static unlock() {
    if (this.mutexQueue.length > 0) {
      const resolve = this.mutexQueue.shift();
      if (resolve) resolve();
    } else {
      this.isFetching = false;
    }
  }

  /**
   * Builds a sponsored `ChangeTrust` envelope for the platform USDC asset.
   *
   * @param userAddress Stellar `G...` account that will own the trustline.
   */
  static async buildSponsoredUsdcTrustlineXdr(
    userAddress: string,
  ): Promise<string> {
    const usdcIssuer = process.env.STELLAR_USDC_ISSUER;
    if (!usdcIssuer) {
      throw new Error("STELLAR_USDC_ISSUER is not configured");
    }

    return this.buildSponsoredTrustlineXdr(userAddress, {
      code: "USDC",
      issuer: usdcIssuer,
    });
  }

  /**
   * Builds a sponsored `ChangeTrust` transaction envelope for `userAddress`.
   *
   * The returned envelope contains three operations:
   * 1. `BeginSponsoringFutureReserves` — paid for by the platform sponsor.
   * 2. `ChangeTrust` — opens the trustline for the user.
   * 3. `EndSponsoringFutureReserves` — closes the sponsored window.
   *
   * The envelope is signed by the platform sponsor; the user still has to
   * co-sign it before it can be submitted to the network.
   *
   * @param userAddress Stellar `G...` account that will own the trustline.
   * @param asset Classic asset the trustline is opened against.
   * @param options Optional builder behaviour (see {@link SponsoredTrustlineOptions}).
   */
  static async buildSponsoredTrustlineXdr(
    userAddress: string,
    asset: TrustlineAsset,
    options?: SponsoredTrustlineOptions,
  ): Promise<string> {
    const sponsorSecret = process.env.STELLAR_SPONSOR_SECRET;
    if (!sponsorSecret) {
      throw new Error("STELLAR_SPONSOR_SECRET is not configured");
    }

    if (typeof userAddress !== "string" || !userAddress.trim()) {
      throw new Error("A Stellar account address is required");
    }

    const account = userAddress.trim();
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new Error(
        `Invalid Stellar account "${account}": expected a valid G... public key`,
      );
    }

    const assetCode = typeof asset?.code === "string" ? asset.code.trim() : "";
    const assetIssuer =
      typeof asset?.issuer === "string" ? asset.issuer.trim() : "";

    if (!ASSET_CODE_PATTERN.test(assetCode)) {
      throw new Error(
        `Invalid trustline asset code "${assetCode}": expected 1-12 alphanumeric characters`,
      );
    }

    if (!StrKey.isValidEd25519PublicKey(assetIssuer)) {
      throw new Error(
        `Invalid trustline asset issuer "${assetIssuer}": expected a valid G... public key`,
      );
    }

    const sponsorKeypair = Keypair.fromSecret(sponsorSecret);
    const networkPassphrase =
      process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
    const trustlineAsset = new Asset(assetCode, assetIssuer);

    await this.lock();
    try {
      if (!this.sponsorAccount || options?.refreshSponsorAccount) {
        const acc = await this.server.loadAccount(sponsorKeypair.publicKey());
        this.sponsorAccount = new Account(acc.accountId(), acc.sequenceNumber());
      }

      const tx = new TransactionBuilder(this.sponsorAccount, {
        fee: "300",
        networkPassphrase,
      })
        .addOperation(
          Operation.beginSponsoringFutureReserves({
            sponsoredId: account,
            source: sponsorKeypair.publicKey(),
          }),
        )
        .addOperation(
          Operation.changeTrust({
            asset: trustlineAsset,
            source: account,
          }),
        )
        .addOperation(
          Operation.endSponsoringFutureReserves({
            source: account,
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(sponsorKeypair);
      return tx.toXDR();
    } catch (error) {
      this.sponsorAccount = null;
      throw error;
    } finally {
      this.unlock();
    }
  }
}
