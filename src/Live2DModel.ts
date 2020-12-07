import { DerivedInternalModel, MotionManager, MotionPriority } from '@/cubism-common';
import { Live2DModelOptions } from '@/cubism-common/defs';
import type { Cubism4InternalModel } from '@/cubism4';
import { Live2DFactory } from '@/factory/Live2DFactory';
import { Renderer, Texture } from '@pixi/core';
import { Container } from '@pixi/display';
import { InteractionEvent, InteractionManager } from '@pixi/interaction';
import { ObservablePoint, Point } from '@pixi/math';
import { Ticker } from '@pixi/ticker';
import { interaction } from './interaction';
import { Live2DTransform } from './Live2DTransform';
import { clamp, logger } from './utils';

const DEFAULT_OPTIONS: Pick<Required<Live2DModelOptions>, 'autoUpdate' | 'autoInteract' | 'factory'> = {
    autoUpdate: true,
    autoInteract: true,
    factory: Live2DFactory.instance,
};

const tempPoint = new Point();

// a reference to Ticker class, defaults to the one in window.PIXI (when loaded by script tag)
let TickerClass: typeof Ticker | undefined = (window as any).PIXI?.Ticker;

/**
 * A wrapper that makes Live2D model possible to be used as a `DisplayObject` in PixiJS.
 *
 * ```ts
 * let model = Live2DModel.fromModelSettingsFile('path/to/my-model.model.json');
 * container.add(model);
 * ```
 *
 * @emits {@link Live2DModelEvents}
 */
export class Live2DModel<IM extends DerivedInternalModel = Cubism4InternalModel> extends Container {
    /**
     * Tag for logging.
     */
    tag = 'Live2DModel(uninitialized)';

    internalModel?: IM;

    textures: Texture[] = [];

    /**
     * Custom transform.
     */
    transform = new Live2DTransform();

    /**
     * Works like the one in `PIXI.Sprite`.
     */
    anchor = new ObservablePoint(this.onAnchorChange, this, 0, 0);

    /**
     * The `InteractionManager` is locally stored so we can on/off events anytime.
     */
    interactionManager?: InteractionManager;

    /**
     * An ID of Gl context that syncs with `renderer.CONTEXT_UID`.
     */
    glContextID = -1;

    /**
     * Elapsed time since created. Milliseconds.
     */
    elapsedTime: DOMHighResTimeStamp = performance.now();

    /**
     * The time elapsed from last frame to current frame. Milliseconds.
     */
    deltaTime: DOMHighResTimeStamp = 0;

    /**
     * Registers the class of `Ticker` for auto updating.
     * @param tickerClass
     */
    static registerTicker(tickerClass: typeof Ticker): void {
        TickerClass = tickerClass;
    }

    constructor(source: any, options?: Live2DModelOptions) {
        super();

        const _options = Object.assign({}, DEFAULT_OPTIONS, options);

        this.autoInteract = _options.autoInteract;
        this.autoUpdate = _options.autoUpdate;

        if (_options.autoInteract) {
            this.interactive = true;
        }

        const factory = _options.factory ?? Live2DFactory.instance;

        factory.initBySource(this, source).catch(e => {
            logger.warn(this.tag, 'Failed to initialize Live2DModel:', e);
            this.emit('error:init', e);
        });

        this.on('modelLoaded', () => {
            this.tag = `Live2DModel(${this.internalModel!.settings.name})`;

            this.internalModel!.motionManager.onMotionStart = (group: string, index: number, audio?: HTMLAudioElement) => this.emit('motion', group, index, audio);
        });
    }

    private _autoInteract = false;

    /**
     * Enabling automatic interaction. Will not take effect if the `InteractionManager` plugin is not registered in `Renderer`.
     */
    get autoInteract(): boolean {
        return this._autoInteract;
    }

    set autoInteract(autoInteract: boolean) {
        if (autoInteract) {
            this.on('pointertap', this.onTap);
        } else {
            this.off('pointertap', this.onTap);
        }

        this._autoInteract = autoInteract;
    }

    protected _autoUpdate = false;

    /**
     * Enabling automatic updating. Requires {@link Live2DModel.registerTicker} or global `window.PIXI.Ticker`.
     */
    get autoUpdate() {
        return this._autoUpdate;
    }

    set autoUpdate(autoUpdate: boolean) {
        if (autoUpdate) {
            if (!this._destroyed) {
                if (TickerClass) {
                    TickerClass?.shared.add(this.onTickerUpdate, this);

                    this._autoUpdate = true;
                } else {
                    logger.warn(this.tag, 'No Ticker registered, please call Live2DModel.registerTicker(Ticker).');
                }
            }
        } else {
            TickerClass?.shared.remove(this.onTickerUpdate, this);

            this._autoUpdate = false;
        }
    }

    /**
     * Called when the values of {@link Live2DModel#anchor} are changed.
     */
    protected onAnchorChange(): void {
        if (this.internalModel) {
            this.pivot.set(this.anchor.x * this.internalModel.width, this.anchor.y * this.internalModel.height);
        }
    }

    /**
     * Shorthand of {@link MotionManager#startRandomMotion}.
     * The types may look ugly but it WORKS!
     */
    motion(group: NonNullable<this['internalModel']>['motionManager']['groups']['idle'], priority?: MotionPriority): Promise<boolean> {
        // because `startRandomMotion` is a union function, the types of its first parameter are
        // intersected and therefore collapsed to `never`, that's why we need to cast the type for it.
        // see https://github.com/Microsoft/TypeScript/issues/30581
        return (this.internalModel?.motionManager as MotionManager<any, any, any, any, any, Parameters<this['motion']>[0]>)
            .startRandomMotion(group, priority) ?? Promise.resolve(false);
    }

    /**
     * Handles `tap` event emitted by `InteractionManager`.
     * @param event
     */
    onTap(event: InteractionEvent): void {
        this.tap(event.data.global.x, event.data.global.y);
    }

    /**
     * Makes the model focus on a point.
     * @param x - Position in world space.
     * @param y - Position in world space.
     */
    focus(x: number, y: number): void {
        tempPoint.x = x;
        tempPoint.y = y;

        // we can pass `true` as third argument to skip the update transform
        // because focus won't take effect until the model is rendered,
        // and a model being rendered will always get transform updated
        this.toModelPosition(tempPoint, tempPoint, true);

        this.internalModel?.focusController.focus(
            clamp((tempPoint.x / this.internalModel.originalWidth) * 2 - 1, -1, 1),
            -clamp((tempPoint.y / this.internalModel.originalHeight) * 2 - 1, -1, 1),
        );
    }

    /**
     * Performs tap on the model.
     * @param x - The x position in world space.
     * @param y - The y position in world space.
     * @emits {@link Live2DModelEvents.hit}
     */
    tap(x: number, y: number): void {
        if (this.internalModel) {
            tempPoint.x = x;
            tempPoint.y = y;
            this.toModelPosition(tempPoint, tempPoint);

            const hitAreaNames = this.internalModel.hitTest(tempPoint.x, tempPoint.y);

            if (hitAreaNames.length) {
                logger.log(this.tag, `Hit`, hitAreaNames);

                this.emit('hit', hitAreaNames);
            }
        }
    }

    /**
     * Gets the position in original (unscaled) Live2D model.
     * @param position - The point in world space.
     * @param point - The point to store new value.
     * @param skipUpdate - True to skip the update transform.
     * @return The point in Live2D model.
     */
    toModelPosition(position: Point, point = new Point(), skipUpdate?: boolean): Point {
        if (this.internalModel) {
            if (!skipUpdate) {
                this._recursivePostUpdateTransform();

                if (!this.parent) {
                    (this.parent as any) = this._tempDisplayObjectParent;
                    this.displayObjectUpdateTransform();
                    (this.parent as any) = null;
                } else {
                    this.displayObjectUpdateTransform();
                }
            }

            const transform = this.transform.worldTransform;
            const model1 = this.internalModel;

            point.x = ((position.x - transform.tx) / transform.a - model1.matrix.tx) / model1.matrix.a;
            point.y = ((position.y - transform.ty) / transform.d - model1.matrix.ty) / model1.matrix.d;
        }

        return point;
    }

    /**
     * Required by `InteractionManager` to perform hit testing.
     * @param point - The point in world space.
     * @return True if given point is inside this model.
     */
    containsPoint(point: Point): boolean {
        return this.getBounds(true).contains(point.x, point.y);
    }

    /** @override */
    protected _calculateBounds(): void {
        if (this.internalModel) {
            this._bounds.addFrame(this.transform, 0, 0, this.internalModel.width, this.internalModel.height);
        }
    }

    /**
     * A listener to be added to `Ticker`.
     */
    onTickerUpdate(): void {
        this.update(TickerClass!.shared.deltaMS);
    }

    /**
     * Updates parameters of the model.
     * @param dt - The time elapsed since last frame.
     */
    update(dt: DOMHighResTimeStamp): void {
        this.deltaTime += dt;
        this.elapsedTime += dt;

        // don't call `this.model.update()` here, because it requires WebGL context
    }

    /** @override */
    protected _render(renderer: Renderer): void {
        if (!this.internalModel) return;

        if (this._autoInteract && renderer.plugins.interaction !== this.interactionManager) {
            interaction.registerInteraction(this, renderer.plugins.interaction);
        }

        // reset certain systems in renderer to make Live2D's drawing system compatible with Pixi
        renderer.batch.reset();
        renderer.geometry.reset();
        renderer.shader.reset();
        renderer.state.reset();

        // when the WebGL context has changed
        if (this.glContextID !== (renderer as any).CONTEXT_UID) {
            this.glContextID = (renderer as any).CONTEXT_UID;

            this.internalModel.updateWebGLContext(renderer.gl, this.glContextID);

            renderer.gl.pixelStorei(WebGLRenderingContext.UNPACK_FLIP_Y_WEBGL, true);

            for (let i = 0; i < this.textures.length; i++) {
                const baseTexture = this.textures[i].baseTexture;

                // let TextureSystem generate corresponding WebGLTexture. The binding location is not important
                renderer.texture.bind(baseTexture, 0);

                // bind the WebGLTexture generated by TextureSystem
                // kind of ugly but it does the trick :/
                this.internalModel.bindTexture(i, (baseTexture as any)._glTextures[this.glContextID].texture);
            }
        }

        for (const texture of this.textures) {
            // manually update the GC counter so they won't be GCed
            (texture.baseTexture as any).touched = renderer.textureGC.count;
        }

        this.internalModel.update(this.deltaTime, this.elapsedTime);
        this.deltaTime = 0;

        this.internalModel.draw(this.transform.getDrawingMatrix(renderer.gl));

        // reset the active texture that has been changed by Live2D's drawing system
        if (renderer.texture.currentLocation >= 0) {
            renderer.gl.activeTexture(WebGLRenderingContext.TEXTURE0 + renderer.texture.currentLocation);
        }

        // reset WebGL state
        renderer.state.reset();
    }

    /** @override */
    destroy(options?: { children?: boolean, texture?: boolean, baseTexture?: boolean }): void {
        // the setter will do the cleanup
        this.autoUpdate = false;

        this.autoInteract = false;
        interaction.unregisterInteraction(this);

        super.destroy(options);
    }
}
