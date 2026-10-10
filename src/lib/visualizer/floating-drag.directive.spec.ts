import { FloatingDragDirective, FloatingPos } from './floating-drag.directive';

describe('FloatingDragDirective', () => {
  let drag: FloatingDragDirective;
  let moves: FloatingPos[];
  let added: { type: string; outside: boolean }[];

  beforeEach(() => {
    let outside = false;
    added = [];
    const realAdd = window.addEventListener.bind(window);
    jest
      .spyOn(window, 'addEventListener')
      .mockImplementation(
        (type: string, l: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
          added.push({ type, outside });
          realAdd(type, l, o);
        },
      );
    drag = new FloatingDragDirective({
      run: (fn: () => unknown) => fn(),
      runOutsideAngular: (fn: () => unknown) => {
        outside = true;
        try {
          return fn();
        } finally {
          outside = false;
        }
      },
    } as never);
    drag.origin = () => ({ x: 100, y: 50 });
    moves = [];
    drag.vizFloatingDragMove.subscribe((p) => moves.push(p));
  });

  afterEach(() => {
    drag.ngOnDestroy();
    jest.restoreAllMocks();
  });

  const mouse = (type: string, x: number, y: number) =>
    new MouseEvent(type, { clientX: x, clientY: y, cancelable: true });

  it('listens to the window only while dragging, outside the zone', () => {
    expect(added).toEqual([]);
    drag.onMouseDown(mouse('mousedown', 10, 10));
    expect(added).toEqual([
      { type: 'mousemove', outside: true },
      { type: 'mouseup', outside: true },
    ]);
  });

  it('moves the panel by the pointer delta from where the drag started', () => {
    drag.onMouseDown(mouse('mousedown', 10, 10));
    window.dispatchEvent(mouse('mousemove', 15, 30));
    expect(moves).toEqual([{ x: 105, y: 70 }]);
    window.dispatchEvent(mouse('mouseup', 15, 30));
    window.dispatchEvent(mouse('mousemove', 50, 50));
    expect(moves).toHaveLength(1); // released
  });

  it('asks for the origin at mousedown, so the host can detach a docked panel then', () => {
    let floating = false;
    drag.origin = () => {
      floating = true;
      return { x: 8, y: 8 };
    };
    drag.onMouseDown(mouse('mousedown', 0, 0));
    expect(floating).toBe(true);
    window.dispatchEvent(mouse('mousemove', 2, 3));
    expect(moves).toEqual([{ x: 10, y: 11 }]);
  });

  it('a destroyed handle stops listening mid-drag', () => {
    drag.onMouseDown(mouse('mousedown', 0, 0));
    drag.ngOnDestroy();
    window.dispatchEvent(mouse('mousemove', 5, 5));
    expect(moves).toEqual([]);
  });
});
