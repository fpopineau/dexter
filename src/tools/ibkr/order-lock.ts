/**
 * Global order-placement lock.
 *
 * IBKR's nextValidId contract is per-connection and NOT safe under
 * concurrent placement: a bracket consumes ids N, N+1, N+2, so any other
 * placement interleaving between the id grant and the third placeOrder can
 * collide. Every code path that allocates order ids and places orders must
 * run inside this lock — placement latency is milliseconds, so serializing
 * costs nothing observable.
 */

let chain: Promise<unknown> = Promise.resolve();

export function withOrderLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined); // a failed placement must not poison the lock
    return run;
}
