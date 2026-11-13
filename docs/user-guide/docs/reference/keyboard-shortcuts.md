# Keyboard shortcuts

Shortcuts go to the viewer that has the keyboard focus, or else to the viewer the pointer last moved over.
They are ignored while you type in a text field. Single-letter shortcuts do nothing while ++ctrl++, ++cmd++
or ++alt++ is held. On macOS, use ++cmd++ where the table says ++ctrl++.

## View

| Keys | Action |
| --- | --- |
| ++plus++ or ++equal++ | Zoom in one step |
| ++minus++ or ++underscore++ | Zoom out one step |
| ++b++ | Zoom box on/off |
| ++p++ | Pan on/off |
| ++arrow-left++ / ++arrow-right++ | Previous / next slice (Image view or slice editor, with a stack open) |

## Region tools

| Keys | Action |
| --- | --- |
| ++s++ | Selection mode (turns off drawing tools) |
| ++r++ | Rectangle on/off |
| ++l++ | Polyline on/off |
| ++f++ | Freeform region on/off |
| ++w++ | Wand on/off |
| ++e++ | Vertex eraser on/off |
| ++del++, ++backspace++ or ++d++ | Delete the selected regions |
| ++ctrl+z++ | Undo the last region action (up to 10) |
| ++ctrl+shift+z++ or ++ctrl+y++ | Redo |

The Brush, Polygon, Add vertex and Delete vertex tools have no shortcut.

## Modifiers while drawing

| Keys | With | Action |
| --- | --- | --- |
| ++shift++ + click/drag | Wand | Erase pixels from the region |
| ++ctrl++ + click | Wand | Exact-match fill (no smoothing) |
| ++shift++ + drag | Brush | Erase from a region |
| ++shift++, ++ctrl++ or ++cmd++ + click | Selection | Add or remove a region from the selection |
| ++shift++ or ++alt++ + click | SAM point prompts | Add an exclude point to the current object |
| ++enter++ | SAM point prompts | Commit the current object |
| ++esc++ | SAM point prompts | Remove the current object |

## Region Editor

| Keys | Where | Action |
| --- | --- | --- |
| ++ctrl++ + click | Table | Add or remove a row from the selection |
| ++shift++ + click | Table | Select a range of rows |
| ++enter++ / ++esc++ | Class name editor | Apply / cancel |
| ++enter++ | Class search | Pick the first match |
| ++shift++ / ++ctrl++ + click | Class tree | Add a class to the pick |

## Slice editor

| Keys | Action |
| --- | --- |
| ++arrow-left++ / ++arrow-right++ | With the vertical divider focused: move it by 5% |
| ++arrow-up++ / ++arrow-down++ | With the horizontal divider focused: move it by 5% |

## Gene heatmap (All genes)

| Input | Action |
| --- | --- |
| Scroll | Zoom |
| ++shift++ + scroll | Zoom genes only |
| ++alt++ + scroll | Zoom cells only |
| Double-click | Reset zoom |

!!! warning "Image view keyboard navigation"
    In the Image view, the underlying image viewer has its own keys when the image itself has the focus
    (after clicking it): some letters and the arrow keys may also pan, rotate or flip the image. If the
    image turns or moves unexpectedly, click **Fit to view**, or reload the image. See
    [Known issues](../qa/known-issues.md).
