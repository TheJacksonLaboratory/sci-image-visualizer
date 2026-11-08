/**
 * A WebGL2 context that draws nothing but records what it was given — for testing the spatial
 * WebGL fallback in jsdom, which has no WebGL. Every method exists (a Proxy answers any name):
 * the create* calls return fresh objects, the status queries report success, and the calls the
 * tests read back are kept in {@link FakeWebGl2.calls}.
 */
export interface FakeWebGl2 {
  readonly gl: WebGL2RenderingContext;
  /** Every call made, in order: the method name and its arguments. */
  readonly calls: { name: string; args: unknown[] }[];
  /** The calls made to `name`. */
  callsTo(name: string): unknown[][];
}

export function fakeWebGl2(): FakeWebGl2 {
  const calls: { name: string; args: unknown[] }[] = [];
  const constants: Record<string, number> = {};
  let next = 1;
  const gl = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined;
        // GL enums (ARRAY_BUFFER, …): any stable number.
        if (/^[A-Z0-9_]+$/.test(prop)) return (constants[prop] ??= next++);
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          if (prop.startsWith('create')) return { id: next++ };
          if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return true;
          if (prop === 'getAttribLocation') return next++ % 8;
          if (prop === 'getUniformLocation') return { uniform: args[1] };
          if (prop === 'getExtension') return null;
          return undefined;
        };
      },
    },
  ) as WebGL2RenderingContext;
  return { gl, calls, callsTo: (name) => calls.filter((c) => c.name === name).map((c) => c.args) };
}

/**
 * Make `canvas.getContext('webgl2')` answer with a fresh {@link fakeWebGl2} (every other context
 * type is left as it was). Returns the fakes handed out and the restore.
 */
export function installFakeWebGl2(): { contexts: FakeWebGl2[]; restore(): void } {
  const proto = HTMLCanvasElement.prototype;
  const original = proto.getContext;
  const contexts: FakeWebGl2[] = [];
  proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    if (type === 'webgl2') {
      const fake = fakeWebGl2();
      contexts.push(fake);
      return fake.gl;
    }
    return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
  } as typeof proto.getContext;
  return { contexts, restore: () => (proto.getContext = original) };
}
