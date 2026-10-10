import { DestroyRef } from '@angular/core';

/**
 * A `DestroyRef` for a component a spec constructs with `new`, outside an injection
 * context. {@link destroy} runs the registered callbacks — what Angular does when it
 * destroys the view, right after `ngOnDestroy`.
 */
export class TestDestroyRef implements DestroyRef {
  private callbacks: (() => void)[] = [];

  onDestroy(callback: () => void): () => void {
    this.callbacks.push(callback);
    return () => { this.callbacks = this.callbacks.filter((c) => c !== callback); };
  }

  destroy(): void {
    const callbacks = this.callbacks;
    this.callbacks = [];
    for (const callback of callbacks) callback();
  }
}

const refs = new WeakMap<object, TestDestroyRef>();

/** A {@link TestDestroyRef} for the component about to be built; tie it with {@link own}. */
export function testDestroyRef(): TestDestroyRef {
  return new TestDestroyRef();
}

/** Remember which {@link TestDestroyRef} `component` was built with. Returns the component. */
export function own<T extends object>(component: T, ref: TestDestroyRef): T {
  refs.set(component, ref);
  return component;
}

/** Destroy a `new`-built component as Angular would: `ngOnDestroy`, then its DestroyRef. */
export function destroyComponent(component: { ngOnDestroy(): void }): void {
  component.ngOnDestroy();
  refs.get(component)?.destroy();
}
