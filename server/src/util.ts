/** Synchronous sleep (the Writer/archive paths are fully synchronous). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
