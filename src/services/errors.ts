export class GroqServiceError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'GroqServiceError';
    this.code = code;
    this.status = status;
  }
}