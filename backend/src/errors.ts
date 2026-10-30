export class SupercutsError extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SupercutsError";
  }
}

export const fail = (code: string, message: string, cause?: unknown): never => {
  throw new SupercutsError(code, message, cause);
};
