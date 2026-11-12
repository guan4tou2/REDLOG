/** True while an input method is composing, so the key belongs to the IME
 *  (an Enter that picks a candidate is not a submit). Takes a React keyboard
 *  event or a DOM one. `keyCode === 229` covers browsers that report the
 *  composition keydown without `isComposing`. */
export function isComposing(e: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean {
  return e.nativeEvent?.isComposing === true || e.isComposing === true || e.keyCode === 229
}
