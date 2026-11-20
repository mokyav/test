export class DurableObject<E = unknown> {
  ctx: any;
  env: E;
  constructor(ctx: any, env: E) { this.ctx = ctx; this.env = env; }
}
