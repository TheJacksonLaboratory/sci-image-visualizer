# Contributed dialog tools

An interactive tool that is not "set parameters, run once" can be a **dialog
tool** (0.6.0+). It is provided on `TOOLBAR_TOOLS`, like the run tools, with
`kind: 'dialog'`:

- **Button:** it sits with the host's own projected buttons at the start of the
  toolbar, and shows in the Image view only.
- **Dialog:** clicking the button opens a floating, non-modal dialog and starts
  a session. The tool fills the dialog body with plain DOM.
- **Context:** the same one a plot mode gets (the public visualizer, the Image
  view's viewport, the current image), with `ctx.tools` always present.

```ts
import { TOOLBAR_TOOLS, ToolbarDialogToolContribution } from '@jax-data-science/sci-image-visualizer';

const myTool: ToolbarDialogToolContribution = {
  kind: 'dialog',
  id: 'my-tool',
  label: 'My tool',
  icon: { pi: 'pi-pencil' },
  tooltip: 'Open my tool',
  dialog: { title: 'My tool', width: '22rem' },
  activate(ctx) {
    const sub = ctx.viewport.frame$.subscribe((visible) => redraw(visible));
    return { deactivate: () => sub.unsubscribe() };
  },
  // After activate(), once the dialog has rendered: `host` is in the document here,
  // so the body can measure itself.
  mount(host, ctx, session) {
    host.textContent = 'Hello';
    return () => {
      host.textContent = '';
    }; // teardown, before deactivate()
  },
};

providers: [{ provide: TOOLBAR_TOOLS, useValue: myTool, multi: true }];
```

**Lifecycle:**

- Clicking the button again, or closing the dialog, tears the body down and then
  calls `session.deactivate()`, exactly once.
- Re-rendering the Image view (another image or slice) ends the session. The
  dialog stays open, and a fresh session starts on the new view.
- Leaving the Image view closes the dialog.
- A failed start closes the dialog with a warning. As with plot modes, nothing
  the tool throws or rejects escapes.
