/**
 * vertLine — a minimal vertical time-marker primitive for lightweight-charts v5.
 * Draws a full-height vertical line at a given `Time` on the price pane. Used for
 * the replay "start from here" marker (draggable — the drag is handled by the
 * host component, which calls setTime as the cursor moves).
 */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesType,
} from "lightweight-charts";

class VertLineRenderer implements IPrimitivePaneRenderer {
  constructor(private _x: number | null, private _color: string) {}
  draw(target: {
    useBitmapCoordinateSpace: (
      cb: (scope: { context: CanvasRenderingContext2D; bitmapSize: { width: number; height: number }; horizontalPixelRatio: number }) => void,
    ) => void;
  }): void {
    if (this._x === null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const x = Math.round(this._x! * scope.horizontalPixelRatio);
      ctx.save();
      ctx.strokeStyle = this._color;
      ctx.lineWidth = Math.max(1, Math.round(2 * scope.horizontalPixelRatio));
      ctx.setLineDash([Math.round(6 * scope.horizontalPixelRatio), Math.round(4 * scope.horizontalPixelRatio)]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, scope.bitmapSize.height);
      ctx.stroke();
      ctx.restore();
    });
  }
}

class VertLineView implements IPrimitivePaneView {
  private _x: number | null = null;
  constructor(private _src: VertLine) {}
  update(): void {
    const ts = this._src.chart?.timeScale();
    this._x = ts ? ts.timeToCoordinate(this._src.time) : null;
  }
  renderer(): IPrimitivePaneRenderer {
    return new VertLineRenderer(this._x, this._src.color);
  }
}

export class VertLine implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  time: Time;
  color: string;
  private _views: VertLineView[];
  private _req: (() => void) | null = null;

  constructor(time: Time, color = "#eab308") {
    this.time = time;
    this.color = color;
    this._views = [new VertLineView(this)];
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this.series = p.series;
    this._req = p.requestUpdate;
  }
  detached(): void {
    this.chart = null;
    this.series = null;
    this._req = null;
  }
  updateAllViews(): void {
    this._views.forEach((v) => v.update());
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
  /** Move the line to a new time and repaint. */
  setTime(t: Time): void {
    this.time = t;
    this._req?.();
  }
}
