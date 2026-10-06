/* Number inputs everywhere get the app's own up / down arrows instead of the browser's spinners (which differ per
   browser and are too small to hit). Each input[type=number] — including ones a panel draws later — is wrapped once in
   <span class="num-box"> with two buttons; a click steps the value (holding repeats) and fires the input's own
   input + change events, exactly as typing would, so every existing handler keeps working unchanged. */
(function (TM) {
  const ARROW = (d) => `<svg viewBox="0 0 10 6" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  function step(input, dir) {
    if (input.disabled || input.readOnly) return;
    const before = input.value;
    if (input.value === '') input.value = input.min !== '' && dir > 0 ? input.min : '0';
    else if (dir > 0) input.stepUp(); else input.stepDown();
    if (input.value === before) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function enhance(input) {
    if (input.closest('.num-box')) return;
    const box = document.createElement('span');
    box.className = 'num-box';
    if (input.style.width) { box.style.width = input.style.width; input.style.width = '100%'; }   // the box takes the input's own size
    input.parentNode.insertBefore(box, input);
    box.appendChild(input);
    const arrows = document.createElement('span');
    arrows.className = 'num-arrows';
    arrows.innerHTML = `<button type="button" tabindex="-1" data-num-step="1" aria-label="Increase">${ARROW('M1 5l4-4 4 4')}</button><button type="button" tabindex="-1" data-num-step="-1" aria-label="Decrease">${ARROW('M1 1l4 4 4-4')}</button>`;
    box.appendChild(arrows);
  }
  let repeat = 0, delay = 0;
  const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = 0; };
  document.addEventListener('pointerdown', (e) => {
    const button = e.target.closest && e.target.closest('[data-num-step]');
    if (!button) return;
    e.preventDefault();   // keep the focus where it is
    const input = button.closest('.num-box').querySelector('input'), dir = +button.dataset.numStep;
    step(input, dir);
    stop();
    delay = setTimeout(() => { repeat = setInterval(() => step(input, dir), 70); }, 380);   // hold to keep stepping
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach((ev) => window.addEventListener(ev, stop, true));
  const scan = (root) => { if (root.querySelectorAll) root.querySelectorAll('input[type="number"]').forEach(enhance); };
  document.addEventListener('DOMContentLoaded', () => {
    scan(document);
    new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      if (n.matches('input[type="number"]')) enhance(n); else scan(n);
    }))).observe(document.body, { childList: true, subtree: true });
  });
})(window.TM);
