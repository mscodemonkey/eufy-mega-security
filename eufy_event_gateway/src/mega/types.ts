/**
 * Defines the checked data shapes crossing the Mega client boundary.
 *
 * `MegaClient` constructs these values after validating untrusted response
 * objects. The types intentionally describe only fields the gateway uses,
 * while optional fields acknowledge that Eufy varies responses by account and
 * camera generation. They are not raw API schemas and should not be expanded
 * merely to mirror an undocumented field that no consumer needs.
 */

/** Per-host ECDH identity cached after a successful key exchange. */
export interface MegaIdentity {
  readonly keyIdent: string;
  readonly sharedKey: string;
  readonly clientPublicKey: string;
}

/** Persisted native Mega session and its account-scoped host identities. */
export interface MegaSession {
  readonly version: 2;
  readonly country: string;
  readonly openUdid: string;
  readonly credentialVerifier: string;
  readonly authToken: string;
  readonly tokenExpiresAt: number;
  readonly userId: string;

  /** Whether the saved token may only submit the verification code that requested it. */
  readonly verificationPending: boolean;
  readonly megaDomain: string;
  readonly domains: Readonly<Record<string, string>>;
  readonly identities: Readonly<Record<string, MegaIdentity>>;
}

/** Minimal envelope returned by every Mega API request. */
export interface MegaResult {
  readonly code: number;
  readonly msg?: string;
  readonly data?: unknown;
}

/** Untrusted-but-type-checked device row from Mega inventory. */
export interface MegaDevice {
  readonly device_sn: string;
  readonly device_name?: string;
  readonly device_model?: string;
  readonly device_type?: number;
  readonly parent_sn?: string;
  readonly station_sn?: string;
  readonly category?: string;
  readonly channel?: number;
  readonly device_channel?: number;
  readonly ip_addr?: string;
  readonly app_conn?: string;
  readonly p2p_did?: string;
  readonly p2p_license?: string;
  readonly push_did?: string;
  readonly member?: { readonly admin_user_id?: string; readonly nick_name?: string };
  readonly main_sw_version?: string;
  readonly params?: ReadonlyArray<{ readonly param_type?: number; readonly param_value?: string }>;
  readonly [key: string]: unknown;
}

/** Inventory response consumed by EufyProvider. */
export interface MegaInventory {
  readonly devices: readonly MegaDevice[];
  readonly groups: readonly unknown[];
}

/** Image challenge returned by the Mega passport service. */
export interface MegaCaptcha {
  readonly id: string;
  readonly image: string;
}

/** Result of a connect attempt, including the next challenge when needed. */
export interface MegaAuthResult {
  readonly state: "authenticated" | "verification-required" | "captcha-required";
  readonly captcha?: MegaCaptcha;
}
