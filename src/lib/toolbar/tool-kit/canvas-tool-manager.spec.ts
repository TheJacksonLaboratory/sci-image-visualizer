import type { CanvasToolId } from '../../contracts/display-types';
import { CanvasToolHost, ICanvasTool } from './canvas-tool';
import { CanvasToolManager } from './canvas-tool-manager';

/** A tool that records its lifecycle calls. */
function fakeTool(id: CanvasToolId): ICanvasTool<{ v?: number }> & { log: string[] } {
  const log: string[] = [];
  return {
    id,
    log,
    activate: (_host, options) => { log.push(`activate:${options?.v ?? '-'}`); },
    deactivate: () => { log.push('deactivate'); },
    setOptions: (options) => { log.push(`options:${options.v}`); },
    reset: () => { log.push('reset'); },
  };
}

describe('CanvasToolManager', () => {
  const host = {} as CanvasToolHost;
  let wand: ReturnType<typeof fakeTool>;
  let brush: ReturnType<typeof fakeTool>;
  let manager: CanvasToolManager;

  beforeEach(() => {
    wand = fakeTool('wand');
    brush = fakeTool('brush');
    manager = new CanvasToolManager(host, [wand, brush]);
  });

  it('arms one tool at a time, disarming the previous one first', () => {
    manager.activate('wand', { v: 1 });
    manager.activate('brush', { v: 2 });
    expect(wand.log).toEqual(['activate:1', 'deactivate']);
    expect(brush.log).toEqual(['activate:2']);
    expect(manager.activeId).toBe('brush');
  });

  it('passes its own host to the tool', () => {
    const tool = fakeTool('wand');
    const spy = jest.spyOn(tool, 'activate');
    new CanvasToolManager(host, [tool]).activate('wand');
    expect(spy).toHaveBeenCalledWith(host, undefined);
  });

  it('re-arming the armed tool forwards the options without disarming it', () => {
    manager.activate('wand', { v: 1 });
    manager.activate('wand', { v: 3 });
    expect(wand.log).toEqual(['activate:1', 'activate:3']);
  });

  it('null, or an id it has no tool for (a region draw mode), only disarms', () => {
    manager.activate('wand');
    manager.activate('drawrect');
    expect(wand.log).toEqual(['activate:-', 'deactivate']);
    expect(manager.activeId).toBeNull();
    manager.activate(null);
    expect(wand.log).toHaveLength(2);
  });

  it('forwards options to a tool whether or not it is armed', () => {
    manager.setOptions('brush', { v: 5 });
    expect(brush.log).toEqual(['options:5']);
  });

  it('resets one tool, or every tool, without disarming', () => {
    manager.activate('wand');
    manager.reset('wand');
    manager.resetAll();
    expect(wand.log).toEqual(['activate:-', 'reset', 'reset']);
    expect(brush.log).toEqual(['reset']);
    expect(manager.activeId).toBe('wand');
  });

  it('knows its tools', () => {
    expect(manager.has('wand')).toBe(true);
    expect(manager.has('samPoint')).toBe(false);
    expect(manager.has(null)).toBe(false);
    expect(manager.get('brush')).toBe(brush);
  });
});
