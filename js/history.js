/* Undo / redo: every store.save() that changes the map's data (see store.snapshot) becomes one step. Saves made in the same turn
   of the event loop (one user action often saves more than once) are folded into a single step. */
(function (TM) {
  const store = TM.store;
  const LIMIT = 200;
  const undoHistory = (TM.history = { undo: [], redo: [], base: null });
  let timer = 0, busy = false;

  undoHistory.reset = () => {
    clearTimeout(timer); timer = 0;
    undoHistory.undo = []; undoHistory.redo = [];
    undoHistory.base = store.snapshot();
    TM.emit('history');
  };
  undoHistory.touch = () => { if (!busy && undoHistory.base && !timer) timer = setTimeout(commit, 0); };
  function commit() {
    clearTimeout(timer); timer = 0;
    if (!undoHistory.base) return;
    const now = store.snapshot();
    if (store.sameSnapshot(now, undoHistory.base)) return;
    undoHistory.undo.push(undoHistory.base);
    if (undoHistory.undo.length > LIMIT) undoHistory.undo.shift();
    undoHistory.redo = [];
    undoHistory.base = now;
    TM.emit('history');
  }
  function step(from, to) {
    commit();                                   // a change still waiting to be recorded counts as the latest step
    if (!from.length) return false;
    const snap = from.pop();
    to.push(undoHistory.base);
    undoHistory.base = snap;
    busy = true;
    try { store.restore(snap); } finally { busy = false; }
    TM.emit('history');
    return true;
  }
  undoHistory.canUndo = () => undoHistory.undo.length > 0 || !!timer;
  undoHistory.canRedo = () => undoHistory.redo.length > 0;
  undoHistory.doUndo = () => { if (!step(undoHistory.undo, undoHistory.redo)) TM.toast('Nothing to undo'); };
  undoHistory.doRedo = () => { if (!step(undoHistory.redo, undoHistory.undo)) TM.toast('Nothing to redo'); };

  /* Cmd+Z / Ctrl+Z undo; Cmd+Shift+Z / Ctrl+Shift+Z / Ctrl+Y redo. Text fields keep their own native undo. */
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    const target = e.target;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '') || target.isContentEditable)) return;
    if (document.querySelector('.modal-back')) return;
    e.preventDefault();
    if (key === 'y' || e.shiftKey) undoHistory.doRedo(); else undoHistory.doUndo();
  });
})(window.TM);
