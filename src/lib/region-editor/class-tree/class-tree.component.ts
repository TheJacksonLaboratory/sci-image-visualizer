import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';

import type { RegionClassNode } from '../../region-source/region-tiles';
import { HexColorPickerComponent } from '../../hex-color-picker/hex-color-picker.component';
import { ClassTree, ClassTreeRow, ancestors, buildClassTree, subtree, visibleRows } from './class-tree';

/** A pick in the tree: the class, and it with every class under it. */
export interface ClassTreePick {
  name: string;
  classes: string[];
  additive: boolean;
}

/**
 * The Region Editor's classes as a hierarchy (a brain atlas's ontology), as the Allen atlas viewer
 * shows it: collapsible, each class with its colour, name and long name, and the regions it and
 * its subclasses have on this slice; a class with none is greyed. Picking a class selects all its
 * regions and its subclasses' (the editor does the selecting). Search by name or long name. A
 * class's swatch recolours it, as the class list's does.
 */
@Component({
  selector: 'region-class-tree',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule, TooltipModule, HexColorPickerComponent],
  templateUrl: './class-tree.component.html',
  styleUrls: ['./class-tree.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassTreeComponent implements OnChanges {
  /** The hierarchy. */
  @Input() nodes: readonly RegionClassNode[] = [];
  /** Regions per class on this slice (the regions and the region source's). */
  @Input() counts: ReadonlyMap<string, number> = new Map();
  /** A class's colour (a new function when the colours change, so the rows repaint). */
  @Input() colorOf: (name: string) => string = () => '#999999';
  /** The class picked last (highlighted, its path expanded). */
  @Input() picked: string | null = null;
  /** Whether a volume view is on screen: each class can then be shown in 3D. */
  @Input() volume = false;
  /** The classes shown in 3D. */
  @Input() shown3d: ReadonlySet<string> = new Set();

  @Output() pick = new EventEmitter<ClassTreePick>();
  /** A class's swatch picked a new colour. */
  @Output() recolor = new EventEmitter<{ name: string; color: string }>();
  /** A class's 3D toggle: it with every class under it. */
  @Output() toggle3d = new EventEmitter<{ name: string; classes: string[] }>();

  protected tree: ClassTree = buildClassTree([], new Map());
  protected rows: ClassTreeRow[] = [];
  protected query = '';
  private expanded = new Set<string>();

  ngOnChanges(changes: SimpleChanges): void {
    const fresh = !!changes['nodes'];
    if (fresh || changes['counts']) this.tree = buildClassTree(this.nodes, this.counts);
    // A new hierarchy opens with its roots expanded, as the atlas viewer does.
    if (fresh) this.expanded = new Set(this.tree.roots);
    if (changes['picked'] && this.picked) for (const a of ancestors(this.tree, this.picked)) this.expanded.add(a);
    this.refresh();
  }

  protected node(name: string): RegionClassNode | undefined {
    return this.tree.node.get(name);
  }

  protected total(name: string): number {
    return this.tree.total.get(name) ?? 0;
  }

  protected toggle(row: ClassTreeRow, event: Event): void {
    event.stopPropagation();
    if (this.expanded.has(row.name)) this.expanded.delete(row.name);
    else this.expanded.add(row.name);
    this.refresh();
  }

  protected choose(name: string, event: Event): void {
    const e = event as MouseEvent | KeyboardEvent;
    this.pick.emit({ name, classes: subtree(this.tree, name), additive: e.shiftKey || e.metaKey || e.ctrlKey });
  }

  protected flip3d(name: string, event: Event): void {
    event.stopPropagation();
    this.toggle3d.emit({ name, classes: subtree(this.tree, name) });
  }

  protected onQuery(value: string): void {
    this.query = value;
    this.refresh();
  }

  /** Enter in the search box picks the first match. */
  protected pickFirstMatch(event: Event): void {
    const q = this.query.trim().toLowerCase();
    const hit = this.rows.find(
      (r) => r.name.toLowerCase().includes(q) || (this.node(r.name)?.title ?? '').toLowerCase().includes(q),
    );
    if (hit) this.choose(hit.name, event);
  }

  protected readonly trackRow = (_: number, r: ClassTreeRow) => r.name;

  private refresh(): void {
    this.rows = visibleRows(this.tree, this.expanded, this.query);
  }
}
