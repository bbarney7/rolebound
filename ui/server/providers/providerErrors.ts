import type { ProviderErrorCode } from "../../shared/providers";

export class ProviderServiceError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string = code,
    public readonly status = 400,
  ) {
    super(message);
  }
}
