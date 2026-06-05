import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';

import { HexColorPickerComponent } from './hex-color-picker.component';

describe('HexColorPickerComponent', () => {
  let component: HexColorPickerComponent;
  let fixture: ComponentFixture<HexColorPickerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [HexColorPickerComponent],
      imports: [FormsModule]
    }).compileComponents();

    fixture = TestBed.createComponent(HexColorPickerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize with default color #000000', () => {
    expect(component.color).toBe('#000000');
  });

  it('should toggle open state', () => {
    expect(component.open).toBe(false);
    component.toggle();
    expect(component.open).toBe(true);
    component.toggle();
    expect(component.open).toBe(false);
  });

  it('should emit colorChange and close when selectAndClose is called', () => {
    const spy = jest.spyOn(component.colorChange, 'emit');
    component.open = true;
    component.selectAndClose('#FF0000');
    expect(component.color).toBe('#FF0000');
    expect(spy).toHaveBeenCalledWith('#FF0000');
    expect(component.open).toBe(false);
  });

  it('should emit colorChange but keep open when selectColor is called', () => {
    const spy = jest.spyOn(component.colorChange, 'emit');
    component.open = true;
    component.selectColor('#00FF00');
    expect(component.color).toBe('#00FF00');
    expect(spy).toHaveBeenCalledWith('#00FF00');
    expect(component.open).toBe(true);
  });

  it('should sync RGB values when color is set', () => {
    component.color = '#FF8000';
    expect(component.red).toBe(255);
    expect(component.green).toBe(128);
    expect(component.blue).toBe(0);
  });

  it('should sync HSL values when color is set', () => {
    component.color = '#FF0000';
    expect(component.hue).toBe(0);
    expect(component.saturation).toBe(100);
    expect(component.lightness).toBe(50);
  });

  it('should update color from HSL slider changes', () => {
    const spy = jest.spyOn(component.colorChange, 'emit');
    component.hue = 120;
    component.saturation = 100;
    component.lightness = 50;
    component.onHslChange();
    expect(component.color).toBe('#00FF00');
    expect(component.red).toBe(0);
    expect(component.green).toBe(255);
    expect(component.blue).toBe(0);
    expect(spy).toHaveBeenCalledWith('#00FF00');
  });

  it('should update color from RGB input changes', () => {
    const spy = jest.spyOn(component.colorChange, 'emit');
    component.red = 0;
    component.green = 0;
    component.blue = 255;
    component.onRgbChange();
    expect(component.color).toBe('#0000FF');
    expect(component.hue).toBe(240);
    expect(spy).toHaveBeenCalledWith('#0000FF');
  });

  it('should accept valid hex input', () => {
    const spy = jest.spyOn(component.colorChange, 'emit');
    component.onHexInput('#ABCDEF');
    expect(component.color).toBe('#ABCDEF');
    expect(spy).toHaveBeenCalledWith('#ABCDEF');
  });

  it('should reject invalid hex input', () => {
    const spy = jest.spyOn(component.colorChange, 'emit');
    component.color = '#000000';
    component.onHexInput('not-a-color');
    expect(component.color).toBe('#000000');
    expect(spy).not.toHaveBeenCalled();
  });

  it('should reject incomplete hex input', () => {
    const spy = jest.spyOn(component.colorChange, 'emit');
    component.color = '#000000';
    component.onHexInput('#FFF');
    expect(component.color).toBe('#000000');
    expect(spy).not.toHaveBeenCalled();
  });

  it('should clamp RGB values in hex conversion', () => {
    component.red = 300;
    component.green = -10;
    component.blue = 128;
    component.onRgbChange();
    // 300 clamps to 255, -10 clamps to 0
    expect(component.color).toBe('#FF0080');
  });

  it('should close dropdown when clicking outside', () => {
    component.open = true;
    const outsideEvent = new MouseEvent('click');
    Object.defineProperty(outsideEvent, 'target', { value: document.body });
    component.onDocumentClick(outsideEvent);
    expect(component.open).toBe(false);
  });

  it('should not close dropdown when clicking inside', () => {
    component.open = true;
    const insideEvent = new MouseEvent('click');
    Object.defineProperty(insideEvent, 'target', { value: fixture.nativeElement });
    component.onDocumentClick(insideEvent);
    expect(component.open).toBe(true);
  });

  it('should generate hue gradient', () => {
    const gradient = component.hueGradient;
    expect(gradient).toContain('linear-gradient');
    expect(gradient).toContain('hsl(0, 100%, 50%)');
    expect(gradient).toContain('hsl(360, 100%, 50%)');
  });

  it('should generate saturation gradient based on current hue', () => {
    component.hue = 200;
    component.lightness = 50;
    const gradient = component.satGradient;
    expect(gradient).toContain('hsl(200, 0%, 50%)');
    expect(gradient).toContain('hsl(200, 100%, 50%)');
  });

  it('should generate lightness gradient based on current hue and saturation', () => {
    component.hue = 200;
    component.saturation = 80;
    const gradient = component.lightGradient;
    expect(gradient).toContain('hsl(200, 80%, 0%)');
    expect(gradient).toContain('hsl(200, 80%, 50%)');
    expect(gradient).toContain('hsl(200, 80%, 100%)');
  });

  it('should have color rows forming a diamond pattern', () => {
    const lengths = component.colorRows.map(r => r.length);
    // Should grow to a middle row then shrink: 7,8,9,10,11,12,13,12,11,10,9,8,7
    expect(lengths).toEqual([7, 8, 9, 10, 11, 12, 13, 12, 11, 10, 9, 8, 7]);
  });

  it('should handle white color correctly', () => {
    component.color = '#FFFFFF';
    expect(component.red).toBe(255);
    expect(component.green).toBe(255);
    expect(component.blue).toBe(255);
    expect(component.lightness).toBe(100);
  });

  it('should handle black color correctly', () => {
    component.color = '#000000';
    expect(component.red).toBe(0);
    expect(component.green).toBe(0);
    expect(component.blue).toBe(0);
    expect(component.lightness).toBe(0);
  });

  it('should roundtrip HSL -> hex -> RGB consistently', () => {
    component.hue = 270;
    component.saturation = 60;
    component.lightness = 40;
    component.onHslChange();
    const hex = component.color;
    // Now set the hex back and verify RGB matches
    const r = component.red;
    const g = component.green;
    const b = component.blue;
    component.color = hex;
    expect(component.red).toBe(r);
    expect(component.green).toBe(g);
    expect(component.blue).toBe(b);
  });
});
