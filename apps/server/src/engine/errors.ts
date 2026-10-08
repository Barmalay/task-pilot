/** Ошибка запроса к движку с HTTP-статусом для API. */
export class EngineError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
