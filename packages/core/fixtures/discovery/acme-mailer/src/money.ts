// A value object: never built by a container, must not break discovery.
export class Money {
  constructor(
    readonly amount: number,
    readonly currency: string,
  ) {}
}
