/**
 * The longest delay `setTimeout` supports: 2^31 - 1 ms, about 24.8 days.
 * Node runs a longer timer after 1 ms instead, so a step `timeout: '30d'`
 * would time out every attempt at once.
 */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** `setTimeout`, with delays beyond what timers support treated as the longest one. */
export function setTimer(callback: () => void, ms: number): NodeJS.Timeout {
  return setTimeout(callback, Math.min(ms, MAX_TIMER_DELAY));
}
