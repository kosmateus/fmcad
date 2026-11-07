'use strict';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function hitTest(presentation, x, y, modal = false, types) {
  return [...(presentation?.hits || [])].reverse().find(hit => (!modal || hit.layer === 'modal') && (!types || types.includes(hit.type)) &&
    x >= hit.x && x < hit.x + hit.width && y >= hit.y && y < hit.y + hit.height);
}
function scrollViewport(hit, offset) {
  if (!hit?.state) return false;
  const state = hit.state;
  state.navigating = true;
  state.offset = clamp(Math.round(offset), 0, Math.max(0, hit.total - hit.visible));
  if (hit.kind === 'logs') { state.follow = false; state.newCount ||= 0; }
  if (hit.rows?.length) {
    const index = hit.rows.findIndex(row => row.id === state.selectedId);
    if (index < state.offset || index >= state.offset + hit.visible) state.selectedId = hit.rows[state.offset]?.id || null;
    state.renderedSelection = state.selectedId;
  }
  return true;
}
function pointerAction(name, data, presentation, pointer, { modal = false, now = Date.now() } = {}) {
  const x = data.x - 1, y = data.y - 1;
  if (modal && pointer.drag?.hit.layer !== 'modal') pointer.drag = null;
  if (name === 'MOUSE_LEFT_BUTTON_RELEASED') { pointer.drag = null; return { type: 'redraw' }; }
  if (['MOUSE_MOTION', 'MOUSE_DRAG'].includes(name) && pointer.drag) {
    const { hit, grab } = pointer.drag;
    const room = hit.height - hit.thumbSize;
    scrollViewport(hit, room > 0 ? (y - hit.y - grab) / room * (hit.total - hit.visible) : 0);
    return { type: 'redraw', focus: hit.focus };
  }
  if (name === 'MOUSE_WHEEL_UP' || name === 'MOUSE_WHEEL_DOWN') {
    const hit = hitTest(presentation, x, y, modal, ['viewport', 'scrollbar']);
    if (hit) scrollViewport(hit, (hit.state.offset || 0) + (name === 'MOUSE_WHEEL_UP' ? -3 : 3));
    return hit ? { type: 'redraw', focus: hit.focus } : null;
  }
  if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return null;
  const hit = hitTest(presentation, x, y, modal);
  if (!hit) return null;
  if (hit.type === 'scrollbar') {
    const row = y - hit.y;
    if (row >= hit.thumbStart && row < hit.thumbStart + hit.thumbSize) pointer.drag = { hit, grab: row - hit.thumbStart };
    else scrollViewport(hit, (hit.state.offset || 0) + (row < hit.thumbStart ? -hit.visible : hit.visible));
    return { type: 'redraw', focus: hit.focus };
  }
  if (hit.type === 'row') {
    hit.state.navigating = true;
    hit.state.selectedId = hit.id;
    if (hit.kind === 'logs') hit.state.follow = false;
    const twice = pointer.lastClick?.id === hit.id && pointer.lastClick?.panel === hit.panelId && now - pointer.lastClick.time < 400;
    pointer.lastClick = { id: hit.id, panel: hit.panelId, time: now };
    return { type: twice ? 'open-details' : 'select', row: hit.row, id: hit.id, kind: hit.kind, focus: hit.focus };
  }
  return hit;
}
module.exports = { hitTest, scrollViewport, pointerAction };
