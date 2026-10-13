/**
 * J12-F16 — show/hide scheduling for the Toast, pure and unit-tested (timers and animations injected).
 * Each toast gets a generation. A hide only clears ITS toast, and only when its fade really finished: a new
 * toast that arrives while the previous one fades out is never erased by the old fade's callback.
 */
export const visibleMsFor = (text) => Math.min(2200 + Math.max(0, String(text).length - 30) * 60, 6000);

export function createToastScheduler({ setMessage, show, hide, stop, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0;
  let timer = null;
  let disposed = false;
  const showToast = function showToast(text) {
    if (disposed) return;
    if (timer) clearTimer(timer);
    const gen = (generation += 1);
    stop();
    setMessage(text);
    show();
    timer = setTimer(() => {
      if (disposed || gen !== generation) return;
      hide(({ finished }) => {
        if (finished && !disposed && gen === generation) setMessage(null);
      });
    }, visibleMsFor(text));
  };
  /** Provider unmounted: cancel the pending timer; late timers/animation callbacks become no-ops. */
  showToast.dispose = () => {
    disposed = true;
    if (timer) clearTimer(timer);
    timer = null;
  };
  return showToast;
}
