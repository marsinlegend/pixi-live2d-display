import { Texture } from '@pixi/core';
import { Loader, LoaderResource } from '@pixi/loaders';
import { parse as urlParse } from 'url';
import { Live2DInternalModel } from './live2d/Live2DInternalModel';
import Live2DPhysics from './live2d/Live2DPhysics';
import Live2DPose from './live2d/Live2DPose';
import ModelSettings from './live2d/ModelSettings';
import { ModelSettingsJSON } from './live2d/ModelSettingsJSON';
import { Live2DModel } from './Live2DModel';
import { log, warn } from './utils/log';

const TAG = 'Live2DFactory';

export interface Live2DResources {
    settings: ModelSettings,
    model: ArrayBuffer;
    textures: Texture[];
    pose?: any;
    physics?: any;
}

export async function fromModelSettingsFile(url: string, options?: PIXI.ILoaderOptions): Promise<Live2DModel> {
    return new Promise((resolve, reject) => {
        new Loader()
            .add(url, options)
            .load((loader: Loader, resources: Partial<Record<string, LoaderResource>>) => {
                const resource = resources[url]!;

                if (!resource.error) {
                    fromModelSettingsJSON(resource.data, url).then(resolve).catch(reject);
                } else {
                    reject(resource.error);
                }
            })
            .on('error', reject);
    });
}

export async function fromModelSettingsJSON(json: ModelSettingsJSON, basePath: string, options?: PIXI.ILoaderOptions): Promise<Live2DModel> {
    return fromModelSettings(new ModelSettings(json, basePath), options);
}

export async function fromModelSettings(settings: ModelSettings, options?: PIXI.ILoaderOptions): Promise<Live2DModel> {
    return new Promise((resolve, reject) => {
        const resources: Partial<Live2DResources> = {
            settings,
            textures: [] as Texture[],
        };

        const loader = new Loader();

        function finish(error?: Error) {
            if (!error) {
                if (resources.model) {
                    try {
                        resolve(fromResources(resources as Live2DResources));
                    } catch (e) {
                        error = e;
                    }
                } else {
                    error = new Error('Missing model data.');
                }
            }

            if (error) {
                // cancel all tasks
                loader.reset();
                reject(error);
            }
        }

        try {
            loader.add(
                settings.resolvePath(settings.model),
                Object.assign({ xhrType: LoaderResource.XHR_RESPONSE_TYPE.BUFFER }, options),
                (modelRes: LoaderResource) => {
                    if (!modelRes.error) {
                        resources.model = modelRes.data;
                        log(TAG, `Loaded model data (${resources.model!.byteLength}):`, modelRes.name);
                    } else {
                        finish(modelRes.error);
                    }
                },
            );

            settings.textures.forEach((texture: string, index: number) => {
                const textureURL = settings.resolvePath(texture);

                if (!loader.resources[textureURL]) {
                    loader.add(textureURL, options, (textureRes: LoaderResource) => {
                            if (!textureRes.error) {
                                resources.textures![index] = textureRes.texture;
                                log(TAG, `Loaded texture (${textureRes.texture.width}x${textureRes.texture.height}):`, textureRes.name);
                            } else {
                                warn(TAG, `Failed to load texture from "${textureRes.url}"`, textureRes.error);
                            }
                        },
                    );
                }
            });

            if (settings.pose) {
                loader.add(settings.resolvePath(settings.pose), options, (poseRes: LoaderResource) => {
                        if (!poseRes.error) {
                            resources.pose = poseRes.data;
                            log(TAG, `Loaded pose data:`, poseRes.name);
                        } else {
                            warn(TAG, `Failed to load pose data from "${poseRes.url}"`, poseRes.error);
                        }
                    },
                );
            }

            if (settings.physics) {
                loader.add(settings.resolvePath(settings.physics), options, (physicsRes: LoaderResource) => {
                        if (!physicsRes.error) {
                            resources.physics = physicsRes.data;
                            log(TAG, `Loaded physics data:`, physicsRes.name);
                        } else {
                            warn(TAG, `Failed to load physics data from "${physicsRes.url}"`, physicsRes.error);
                        }
                    },
                );
            }

            loader.load(() => finish());
        } catch (e) {
            finish(e);
        }
    });
}

export function fromResources(resources: Live2DResources): Live2DModel {
    const coreModel = Live2DModelWebGL.loadModel(resources.model);

    const error = Live2D.getError();
    if (error) throw error;

    const internalModel = new Live2DInternalModel(coreModel, resources.settings);

    if (resources.pose) {
        internalModel.pose = new Live2DPose(coreModel, resources.pose);
    }

    if (resources.physics) {
        internalModel.physics = new Live2DPhysics(coreModel, resources.physics);
    }

    const model = new Live2DModel(internalModel);

    model.textures = resources.textures;

    return model;
}
