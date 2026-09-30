export class UploadQuotaError extends Error {
  readonly status: 429 | 507;
  constructor(message: string, status: 429 | 507) {
    super(message);
    this.status = status;
  }
}
