/** the decode animation's frame counter: rows mid-decode read it to redraw */
export type DecodeFrame = number

declare module 'claude-code' {
  interface PluginState {
    'digital-rain': { frame: DecodeFrame }
  }
}
