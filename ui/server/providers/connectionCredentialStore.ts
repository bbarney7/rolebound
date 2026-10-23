import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { readApplicationSettings } from "../applicationConfigStore";
import {
  authPath,
  modifyAuthFile,
  readAuth,
  type CredentialOwnerToken,
  type CredentialWriteAuthorization,
  type StoredAuth,
} from "./authStoreFile";
import { providerAlias } from "./providerIds";
import { ProviderServiceError } from "./providerErrors";
import type { LoginMutation } from "./loginMutationJournal";

/**
 * pi `CredentialStore` scoped to one Rolebound connection. Native provider ids map to
 * `pi-jobs-<connectionId>` in the app-store auth.json.
 *
 * pi performs OAuth refresh network I/O inside `modify` while `.provider-store` is held;
 * the lock is not re-entrant — callers already holding it must use unlocked helpers.
 */
export class ConnectionCredentialStore implements CredentialStore {
  private observing = false;
  private observed = false;
  private observedCredential: Credential | undefined;

  constructor(
    private readonly root: string,
    private readonly connectionId: string,
    private readonly nativeProviderId: string,
    private readonly onMutation?: (mutation: Extract<LoginMutation, { kind: "auth" }>) => void | Promise<void>,
    private readonly expectedGeneration?: { credential: Credential | undefined },
    private readonly ownerToken?: CredentialOwnerToken,
  ) {}

  private alias(): string {
    return providerAlias(this.connectionId);
  }

  private mapIn(auth: StoredAuth, providerId: string): Credential | undefined {
    if (providerId !== this.nativeProviderId) return undefined;
    return auth[this.alias()];
  }

  private mapOut(auth: StoredAuth, providerId: string, credential: Credential): StoredAuth {
    if (providerId !== this.nativeProviderId) return auth;
    return { ...auth, [this.alias()]: credential };
  }

  private authorization(): CredentialWriteAuthorization | undefined {
    return {
      connectionId: this.connectionId,
      ...(this.ownerToken ? { ownerToken: this.ownerToken } : {}),
    };
  }

  private observe(providerId: string, credential: Credential | undefined): void {
    if (!this.observing || providerId !== this.nativeProviderId) return;
    this.observed = true;
    this.observedCredential = credential;
  }

  private async assertExpectedProvider(): Promise<void> {
    const settings = await readApplicationSettings(this.root);
    const connection = settings.data.connections.find((item) => item.id === this.connectionId);
    if (!connection) {
      throw new ProviderServiceError("CONNECTION_MISSING", "connection not found", 404);
    }
    if (connection.provider !== this.nativeProviderId) {
      throw new ProviderServiceError(
        "CONFIG_INVALID",
        "connection provider changed while credentials were being written",
        409,
      );
    }
  }

  /** Correlate a runtime auth result with the credential generation it consumed. */
  beginObservation(): void {
    this.observing = true;
    this.observed = false;
    this.observedCredential = undefined;
  }

  endObservation(): { observed: boolean; credential: Credential | undefined } {
    const result = { observed: this.observed, credential: this.observedCredential };
    this.observing = false;
    this.observed = false;
    this.observedCredential = undefined;
    return result;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const auth = await readAuth(this.root);
    const credential = this.mapIn(auth, providerId);
    this.observe(providerId, credential);
    return credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const auth = await readAuth(this.root);
    const credential = auth[this.alias()];
    if (!credential) return [];
    return [{ providerId: this.nativeProviderId, type: credential.type }];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== this.nativeProviderId) {
      return fn(undefined);
    }
    let previous: Credential | undefined;
    let updated: Credential | undefined;
    await modifyAuthFile(this.root, async (current) => {
      await this.assertExpectedProvider();
      previous = current[this.alias()];
      if (this.expectedGeneration && !isDeepStrictEqual(previous, this.expectedGeneration.credential)) {
        throw new ProviderServiceError(
          "CONFIG_INVALID",
          "connection credential changed while sign-in was in progress",
          409,
        );
      }
      updated = await fn(previous);
      this.observe(providerId, updated ?? previous);
      if (updated === undefined) return current;
      return this.mapOut(current, providerId, updated);
    }, this.authorization());
    if (updated !== undefined) {
      if (this.expectedGeneration) this.expectedGeneration.credential = updated;
      await this.onMutation?.({ kind: "auth", alias: this.alias(), before: previous, written: updated });
    }
    return updated ?? previous;
  }

  async delete(providerId: string): Promise<void> {
    if (providerId !== this.nativeProviderId) return;
    let previous: Credential | undefined;
    await modifyAuthFile(this.root, async (current) => {
      await this.assertExpectedProvider();
      previous = current[this.alias()];
      if (this.expectedGeneration && !isDeepStrictEqual(previous, this.expectedGeneration.credential)) {
        throw new ProviderServiceError(
          "CONFIG_INVALID",
          "connection credential changed while sign-in was in progress",
          409,
        );
      }
      const next = { ...current };
      delete next[this.alias()];
      return next;
    }, this.authorization());
    if (previous !== undefined) {
      if (this.expectedGeneration) this.expectedGeneration.credential = undefined;
      await this.onMutation?.({ kind: "auth", alias: this.alias(), before: previous, written: undefined });
    }
  }

  /** Exposed for tests asserting the backing file path. */
  storePath(): string {
    return authPath(this.root);
  }
}
